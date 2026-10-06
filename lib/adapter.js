/**
 * `VertexExpressAdapter`: a direct-fetch `LlmAdapter` speaking the Vertex AI
 * express-mode wire format with an API key, plus the Service Account variant.
 *
 * The endpoint and credential resolve once per operation from the registering
 * plugin's live configuration, so settings changes take effect on the next
 * request. The wire shape is the Vertex AI express-mode format: the global
 * `aiplatform.googleapis.com/v1` endpoint (or a derived regional endpoint),
 * the model path `/publishers/google/models/{model}:streamGenerateContent`,
 * and the key as the `key` query parameter.
 *
 * Request images follow this runtime's contract: the adapter stages one
 * deterministic request version per attachment, then projects the message
 * history through the route's representation budget, which drops the oldest
 * occurrences that cannot ride and replaces each with its handle text. This
 * runtime has no `IMAGE_OFFLOAD_REQUIRED` handshake, so the projection decision
 * belongs to the adapter rather than to a surface that retries.
 *
 * Headers, the JSON POST, and the failure taxonomy come from
 * `./vertex-request.js`, which the image-generation tool shares.
 *
 * @module dsh-plugin-google-cloud/adapter
 */
import {
	LlmAdapter,
	LlmError,
	offloadRequestImagesWithPolicy,
	offloadedImageText,
	projectFilesToText,
} from '@deepseek-ai/dsh-llm';
import { DEFAULT_CONTEXT_WINDOW, REASONING_EFFORTS, catalogModel, reasoningFamilyOf } from './catalog.js';
import { buildRequestBody, translatePayloads } from './convert.js';
import { endpointFor } from './endpoint.js';
import { assertTierEndpointSupport, assertVertexOk, postVertexJson } from './vertex-request.js';

/** Accumulated base64 image payload accepted per request, matching the pi-ai adapter default. */
const MAX_REQUEST_IMAGE_BYTES = 20 * 1024 * 1024;
/** Total-pixel budget for each deterministic request-image version (2048x2048 equivalent). */
const REQUEST_IMAGE_PIXEL_BUDGET = 2048 * 2048;
/** Raw encoded-byte target for each request-image version before base64 expansion. */
const REQUEST_IMAGE_MAX_BYTES = 1024 * 1024;

/**
 * Fit one source image into a total-pixel budget without enlarging it.
 * @param {number} width - intrinsic width of the normalized attachment.
 * @param {number} height - intrinsic height of the normalized attachment.
 * @param {number} maxPixels - the route's total-pixel budget.
 * @returns {{width: number, height: number}} the request dimensions.
 */
function requestImageDimensions(width, height, maxPixels) {
	const source = { width: Math.max(1, Math.trunc(width)), height: Math.max(1, Math.trunc(height)) };
	if (source.width * source.height <= maxPixels) return source;
	const scale = Math.sqrt(maxPixels / (source.width * source.height));
	return {
		width: Math.max(1, Math.floor(source.width * scale)),
		height: Math.max(1, Math.floor(source.height * scale)),
	};
}

/**
 * The deterministic request-image target this route applies to one source.
 * @param {object} ref - the durable attachment reference.
 * @returns {{width: number, height: number, maxBytes: number}} the target.
 */
function requestImageTarget(ref) {
	return {
		...requestImageDimensions(ref.width, ref.height, REQUEST_IMAGE_PIXEL_BUDGET),
		maxBytes: REQUEST_IMAGE_MAX_BYTES,
	};
}

/**
 * Wrap one payload iterable so every read races an idle watchdog: the timer
 * fires only when the provider sends nothing for the whole interval. Firing
 * also invokes `onIdle`, which the caller wires to an internal abort so the
 * parked upstream read settles and the teardown cannot hang. `teardown` runs
 * before the iterator is closed — it must settle any parked read, because a
 * generator's `return()` cannot be delivered while it awaits one.
 * @param {AsyncIterable<string>} payloads - upstream SSE payloads.
 * @param {number} idleMs - the idle bound; non-positive disables the watchdog.
 * @param {string} endpoint - the endpoint, for the diagnostic.
 * @param {() => void} onIdle - invoked once when the idle bound fires.
 * @param {() => void} teardown - settles a parked upstream read unconditionally.
 * @returns {AsyncGenerator<string>} the same payloads, with the idle bound enforced.
 */
async function* withIdleWatchdog(payloads, idleMs, endpoint, onIdle, teardown) {
	if (idleMs <= 0) {
		yield* payloads;
		return;
	}
	const iterator = payloads[Symbol.asyncIterator]();
	try {
		while (true) {
			let timer;
			const watchdog = new Promise((_, reject) => {
				timer = setTimeout(() => {
					onIdle();
					reject(new LlmError(`Vertex AI stream idle timeout after ${idleMs}ms from ${endpoint}`, 'TIMEOUT'));
				}, idleMs);
			});
			let result;
			try {
				result = await Promise.race([iterator.next(), watchdog]);
			} finally {
				clearTimeout(timer);
			}
			if (result.done) break;
			yield result.value;
		}
	} finally {
		teardown();
		await iterator.return?.().catch(() => {});
	}
}

/**
 * Split one `text/event-stream` body into `data:` payload strings.
 * Multi-line data frames join with newlines; comment, `event:`, and `id:` lines
 * are ignored. The stream ends when the body ends — Vertex sends no sentinel.
 * @param {ReadableStreamDefaultReader<Uint8Array>} reader - reader over the response body.
 * @yields {string} one payload per SSE data frame.
 */
async function* ssePayloads(reader) {
	const decoder = new TextDecoder();
	let buffer = '';
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let boundary = buffer.search(/\r?\n\r?\n/);
			while (boundary !== -1) {
				const frame = buffer.slice(0, boundary);
				buffer = buffer.slice(boundary + (buffer[boundary] === '\r' ? 4 : 2));
				const payload = dataPayloadOf(frame);
				if (payload !== undefined) yield payload;
				boundary = buffer.search(/\r?\n\r?\n/);
			}
		}
		buffer += decoder.decode();
		const payload = dataPayloadOf(buffer);
		if (payload !== undefined) yield payload;
	} finally {
		reader.cancel().catch(() => {});
	}
}

/**
 * Extract the joined `data:` payload of one SSE frame.
 * @param {string} frame - one raw frame.
 * @returns {string | undefined} the payload, or undefined when the frame carries none.
 */
function dataPayloadOf(frame) {
	if (frame.length === 0) return undefined;
	const lines = [];
	for (const line of frame.split(/\r?\n/)) {
		if (line.startsWith('data:')) lines.push(line.slice(5).replace(/^ /, ''));
	}
	if (lines.length === 0) return undefined;
	return lines.join('\n');
}

/**
 * The adapter registered for the harness route. All wire behavior lives in
 * {@link stream}; the base class supplies the remaining contract defaults.
 */
export class VertexExpressAdapter extends LlmAdapter {
	/** @param {object} deps - plugin-provided thunks over live configuration and host services. */
	constructor(deps) {
		super();
		this.deps = deps;
	}

	/**
	 * @param {string} provider - the registered route.
	 * @returns {object} display metadata for selectors and diagnostics.
	 */
	providerInfo(provider) {
		const connection = this.deps.resolveConnection();
		return { id: provider, name: connection.displayName };
	}

	/**
	 * List the advertised Vertex Gemini models. Catalog membership is advisory.
	 * @param {string} provider - the registered route.
	 * @returns {Promise<object[]>} model metadata in catalog order.
	 */
	async listModels(provider) {
		return this.deps.listModels().map((model) => ({
			provider,
			id: model.id,
			name: model.name,
			inputModalities: ['text', 'image'],
		}));
	}

	/**
	 * Resolve exact metadata for one model route, listed or not.
	 * @param {string} provider - the registered route.
	 * @param {string} model - exact model id.
	 * @param {AbortSignal} [signal] - cancellation.
	 * @returns {Promise<object>} resolved model metadata.
	 */
	async resolveModel(provider, model, signal) {
		signal?.throwIfAborted();
		const known = catalogModel(model);
		return {
			provider,
			id: model,
			name: known?.name ?? model,
			context: { contextWindow: known?.contextWindow ?? DEFAULT_CONTEXT_WINDOW },
			...known?.maxTokens === undefined ? {} : { defaultMaxTokens: known.maxTokens },
			inputModalities: ['text', 'image'],
			...(reasoningFamilyOf(model) === undefined
				? {}
				: { reasoning: { efforts: REASONING_EFFORTS } }),
		};
	}

	/**
	 * Prepare one model call and bind the connection snapshot it was prepared
	 * from. The runtime hands the whole request to the returned `stream`, so a
	 * settings edit between preparation and dispatch can never combine one
	 * generation's model metadata with another generation's endpoint.
	 * @param {string} provider - the registered route.
	 * @param {string} model - exact model id.
	 * @param {AbortSignal} [signal] - cancellation.
	 * @returns {Promise<{model: object, stream: (options: object) => AsyncIterable<object>}>}
	 *   the resolved model and the bound stream.
	 */
	async prepareCall(provider, model, signal) {
		const resolved = await this.resolveModel(provider, model, signal);
		const connection = this.deps.resolveConnection();
		return {
			model: resolved,
			stream: (options) => this.run(options, connection),
		};
	}

	/**
	 * Stream one model call against the Vertex AI express endpoint, resolving
	 * the connection at call time.
	 * @param {object} options - the fully assembled harness request.
	 * @yields {object} harness StreamChunk values.
	 */
	async *stream(options) {
		yield* this.run(options, this.deps.resolveConnection());
	}

	/**
	 * Stream one model call with one already-resolved connection snapshot.
	 * @param {object} options - the fully assembled harness request.
	 * @param {object} connection - the resolved connection snapshot.
	 * @yields {object} harness StreamChunk values.
	 */
	async *run(options, connection) {
		const auth = connection.resolveAuth
			? await connection.resolveAuth()
			: { mode: 'express', apiKey: await connection.resolveApiKey() };
		const model = options.model;

		if (contentHasImageOutsideUserTurns(options.messages)) {
			throw new LlmError('The Vertex AI adapter cannot represent image content in a system or assistant message.', 'UNSUPPORTED_CONTENT');
		}

		const attachments = this.deps.resolveAttachments();
		const accessOf = (ref) => (this.deps.resolveImageAccess === undefined
			? undefined
			: this.deps.resolveImageAccess(attachments, ref));
		const { messages: requestMessages, requestImages } = await this.prepareMessages(options, attachments, accessOf);
		const body = buildRequestBody(
			{
				messages: requestMessages,
				system: options.system,
				provider: options.provider,
				model,
				requestImages,
				resolveImageAccess: accessOf,
				resolveFileText: this.deps.resolveFileText,
			},
			{
				temperature: options.temperature,
				maxTokens: options.maxTokens,
				stop: options.stop,
				reasoningEffort: options.reasoningEffort,
			},
			options.tools,
		);

		if (body.contents.length === 0 && body.systemInstruction === undefined) {
			throw new LlmError('The Vertex AI request has no convertible content.', 'INVALID_REQUEST');
		}

		const effectiveConnection = {
			...connection,
			authMode: auth.mode,
			projectId: connection.projectId || (auth.mode === 'full' ? (auth.projectId ?? '') : ''),
		};
		const endpoint = endpointFor(effectiveConnection);
		const tier = effectiveConnection.tier ?? 'standard';
		assertTierEndpointSupport(tier, effectiveConnection.region);
		const idleAbort = new AbortController();
		const requestSignal = options.signal === undefined ? idleAbort.signal : AbortSignal.any([options.signal, idleAbort.signal]);
		const url = auth.mode === 'full'
			? `${endpoint}/publishers/google/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`
			: `${endpoint}/publishers/google/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(auth.apiKey)}`;
		const response = await this.request(url, body, requestSignal, effectiveConnection, auth);

		await assertVertexOk(response, { endpoint, connection: effectiveConnection });
		if (response.body === undefined) {
			throw new LlmError('Vertex AI returned no response body.', 'EMPTY_RESPONSE');
		}

		const reader = response.body.getReader();
		const payloads = withIdleWatchdog(
			ssePayloads(reader),
			connection.streamIdleTimeoutMs,
			endpoint,
			() => idleAbort.abort(),
			() => { try { reader.cancel().catch(() => {}); } catch { /* already released */ } },
		);
		try {
			for await (const chunk of translatePayloads(payloads, model)) {
				if (tier !== 'standard' && chunk.type === 'finish' && typeof chunk.replayState?.response?.trafficType === 'string') {
					this.deps.onTrafficType?.(chunk.replayState.response.trafficType);
				}
				yield chunk;
			}
		} catch (error) {
			throw this.wrapStreamError(error, options, endpoint);
		}
	}

	/**
	 * Map one stream failure onto the harness error taxonomy.
	 * @param {unknown} error - the thrown failure.
	 * @param {object} options - the harness request, for abort detection.
	 * @param {string} endpoint - the endpoint, for the diagnostic.
	 * @returns {LlmError} the normalized failure.
	 */
	wrapStreamError(error, options, endpoint) {
		if (options.signal?.aborted) {
			return new LlmError('Vertex AI request aborted by caller', 'ABORTED', { cause: error });
		}
		if (error instanceof LlmError) return error;
		const code = typeof error?.code === 'string' ? error.code : undefined;
		if (code === 'MALFORMED_RESPONSE') return new LlmError(error.message, 'MALFORMED_RESPONSE', { cause: error });
		if (code === 'INVALID_RESPONSE' || code === 'EMPTY_RESPONSE' || code === 'PROVIDER_REFUSED') {
			return new LlmError(error.message, code, {
				cause: error,
				...(typeof error?.status === 'number' ? { status: error.status } : {}),
			});
		}
		return new LlmError(`Vertex AI stream from ${endpoint} failed`, 'TRANSPORT', { cause: error });
	}

	/**
	 * Fetch with the attribution contract and transport mapping.
	 * @param {string} url - the complete request URL.
	 * @param {object} body - the JSON body.
	 * @param {AbortSignal | undefined} signal - caller cancellation.
	 * @param {object} connection - the resolved connection snapshot.
	 * @param {object} [auth] - the resolved authentication snapshot.
	 * @returns {Promise<Response>} the raw response.
	 */
	async request(url, body, signal, connection, auth) {
		return postVertexJson({
			url,
			body,
			signal,
			connection,
			auth,
			accept: 'text/event-stream',
			fetch: this.deps.fetch,
		});
	}

	/**
	 * Project file and image history into request form and stage request images.
	 *
	 * Order follows this runtime's contract: file handles become text, the
	 * route's representation budget removes the oldest image occurrences in whole
	 * byte quanta, every retained occurrence gets its deterministic request
	 * version, and the exact version sizes are re-judged so the finished request
	 * stays inside the budget. DSH 0.1.5-rc.2 has no `IMAGE_OFFLOAD_REQUIRED`
	 * handshake, so the adapter makes the projection decision itself rather than
	 * reporting a shortfall for the surface to retry.
	 * @param {object} options - the harness request.
	 * @param {object | undefined} attachments - the durable attachment provider, resolved once per call.
	 * @param {(ref: object) => object | undefined} accessOf - execution-world access resolver for one reference.
	 * @returns {Promise<{messages: object[], requestImages: Map<string, object>}>}
	 *   messages with files projected and images either staged or offloaded, plus
	 *   the prepared request-image versions by attachment id (empty when none).
	 */
	async prepareMessages(options, attachments, accessOf) {
		const placeholder = (ref) => offloadedImageText(ref, accessOf(ref));
		const projectedMessages = projectFilesToText(options.messages, (ref) => this.deps.resolveFileText(ref));
		const policy = (byteLength) => ({
			representation: 'base64',
			maxBytes: MAX_REQUEST_IMAGE_BYTES,
			byteQuantum: 1,
			byteLength,
			placeholder,
		});

		// Normalized sizes decide which occurrences cannot ride at all, so a
		// request version is prepared only for an occurrence that will.
		const trimmed = offloadRequestImagesWithPolicy(
			projectedMessages,
			policy((ref) => Math.min(ref.bytes ?? 0, REQUEST_IMAGE_MAX_BYTES)),
		);
		const requestImages = new Map();
		if (!trimmed.some((message) => hasImage(message.content))) {
			return { messages: trimmed, requestImages };
		}

		if (attachments === undefined) {
			throw new LlmError('Vertex AI image conversion requires the durable attachment service.', 'UNSUPPORTED_CONTENT');
		}
		const refs = new Map();
		for (const message of trimmed) collectImageRefs(message.content, refs);
		await Promise.all([...refs.values()].map(async (ref) => {
			if (requestImages.has(ref.attachmentId)) return;
			const version = await attachments.readImageRequest(ref, requestImageTarget(ref), options.signal);
			requestImages.set(ref.attachmentId, version);
		}));

		// Base64 expansion can push a request past the budget the estimate passed.
		const messages = offloadRequestImagesWithPolicy(
			trimmed,
			policy((ref) => requestImages.get(ref.attachmentId)?.bytes ?? ref.bytes),
		);
		return { messages, requestImages };
	}
}

/**
 * Whether any message outside user turns carries an image block, nested tool
 * results included.
 * @param {readonly object[]} messages - harness messages.
 * @returns {boolean}
 */
function contentHasImageOutsideUserTurns(messages) {
	return messages.some((message) => (message.role === 'system' || message.role === 'assistant') && hasImage(message.content));
}

/**
 * Whether one block list contains an image, walking nested tool results.
 * @param {readonly object[]} blocks - content blocks.
 * @returns {boolean}
 */
function hasImage(blocks) {
	if (!Array.isArray(blocks)) return false;
	return blocks.some((block) => {
		if (block?.type === 'image') return true;
		if (block?.type === 'tool-result') return hasImage(block.content);
		return false;
	});
}

/**
 * Collect every distinct image reference in request order.
 * @param {readonly object[]} blocks - content blocks.
 * @param {Map<string, object>} refs - attachment id to reference, filled in order.
 */
function collectImageRefs(blocks, refs) {
	if (!Array.isArray(blocks)) return;
	for (const block of blocks) {
		if (block?.type === 'image') refs.set(block.attachment.attachmentId, block.attachment);
		else if (block?.type === 'tool-result') collectImageRefs(block.content, refs);
	}
}

