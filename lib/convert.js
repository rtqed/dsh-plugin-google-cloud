/**
 * Wire translation between the harness message vocabulary and the Vertex AI
 * Gemini `generateContent` payloads, and between the `alt=sse` event stream and
 * harness `StreamChunk`s.
 *
 * The request shape is the Vertex express-mode wire format:
 * `POST {endpoint}/publishers/google/models/{model}:streamGenerateContent?alt=sse&key=…`
 * over the global `aiplatform.googleapis.com/v1` endpoint.
 *
 * This module stays free of harness *services*: it reads only the shared
 * content helpers (`requestImageHandleText`, `offloadedImageText`) so the
 * model-facing image handles it emits match every other adapter byte for byte.
 * Coded failures are plain Errors carrying `code`/`status`, which the adapter
 * maps onto `LlmError`.
 *
 * @module dsh-plugin-google-cloud/convert
 */
import { offloadedImageText, requestImageHandleText } from '@deepseek-ai/dsh-llm';
import { requiresToolCallId, supportsMultimodalFunctionResponse, thinkingConfigFor } from './catalog.js';

/**
 * Flatten one message's text blocks to model-visible text.
 * @param {object} message - harness message.
 * @returns {string} the joined text.
 */
export function flattenText(message) {
	const parts = [];
	for (const block of message.content) {
		if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
	}
	return parts.join('');
}

/**
 * Sanitize one text for the Gemini wire: lone surrogates break JSON encoding.
 * @param {string} text - arbitrary text.
 * @returns {string} text with unpaired surrogate code points replaced.
 */
export function sanitizeSurrogates(text) {
	return String(text).replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, () => '\uFFFD');
}

const JSON_SCHEMA_META_DECLARATIONS = new Set([
	'$schema', '$id', '$anchor', '$dynamicAnchor', '$vocabulary', '$comment', '$defs', 'definitions',
]);

/**
 * Sanitize one tool parameter schema for the Gemini wire. Mirrors pi-ai's
 * `sanitizeForOpenApi`: strip JSON Schema meta-declarations the endpoint
 * rejects; every other key reaches the wire unchanged, matching the shipped
 * adapter's proven behavior on both `parameters` and `parametersJsonSchema`.
 * @param {object} schema - tool parameter JSON Schema.
 * @returns {object} the sanitized schema.
 */
function sanitizeToolSchema(schema, depth = 0) {
	if (depth > 16 || typeof schema !== 'object' || schema === null || Array.isArray(schema)) return schema;
	const result = {};
	for (const [key, value] of Object.entries(schema)) {
		if (JSON_SCHEMA_META_DECLARATIONS.has(key)) continue;
		result[key] = sanitizeToolSchema(value, depth + 1);
	}
	return result;
}

/**
 * Build the Gemini `tools` field from harness tool schemas.
 * Gemini 3+ takes full JSON Schema under `parametersJsonSchema`; older models
 * take the OpenAPI subset under `parameters`.
 * @param {readonly {name: string, description: string, parameters: object}[]} tools - harness tool schemas.
 * @param {string} model - exact model id.
 * @returns {object[]} the Gemini tools value.
 */
export function convertTools(tools, model) {
	const includeIds = requiresToolCallId(model);
	return [{
		functionDeclarations: tools.map((tool) => {
			const parameters = sanitizeToolSchema(tool.parameters ?? {});
			return {
				name: tool.name,
				description: tool.description,
				...(includeIds
					? { parametersJsonSchema: parameters }
					: { parameters }),
			};
		}),
	}];
}

/**
 * Index every assistant tool-call block so tool results can name their function.
 * @param {readonly object[]} messages - harness messages in request order.
 * @returns {Map<string, string>} tool-call id to function name.
 */
export function collectToolNames(messages) {
	const names = new Map();
	for (const message of messages) {
		if (message.role !== 'assistant') continue;
		for (const block of message.content) {
			if (block.type === 'tool-call' && typeof block.name === 'string') names.set(block.id, block.name);
		}
	}
	return names;
}

/**
 * Recover this adapter's replay metadata from one assistant message.
 * @param {object} message - harness assistant message.
 * @param {string} provider - the registered route this adapter owns.
 * @returns {{ v: number, response?: object, blocks?: unknown[] } | undefined} the envelope when it belongs to this route and parses.
 */
export function replayEnvelopeOf(message, provider) {
	const source = message.source;
	if (source === undefined || source === null) return undefined;
	if (source.provider !== provider) return undefined;
	const state = source.replayState;
	if (typeof state !== 'object' || state === null) return undefined;
	if (state.v !== 1) return undefined;
	return state;
}

/**
 * Signature-restoring lookup over one replay envelope's per-block entries.
 * @param {object | undefined} envelope - this route's replay envelope.
 * @returns {(order: number) => string | undefined} the signature for one block position.
 */
function signatureAt(envelope) {
	const blocks = Array.isArray(envelope?.blocks) ? envelope.blocks : [];
	return (order) => {
		const meta = blocks[order];
		if (typeof meta === 'object' && meta !== null && typeof meta.thoughtSignature === 'string' && meta.thoughtSignature.length > 0) {
			return meta.thoughtSignature;
		}
		return undefined;
	};
}

/**
 * Convert harness messages into Gemini `contents` plus `systemInstruction`.
 *
 * The leading system message (or `options.system`) becomes the system
 * instruction; any later system message folds into a user turn. Assistant
 * reasoning/text/function-call parts restore their `thoughtSignature` when the
 * replay envelope belongs to this route.
 *
 * @param {object} options - conversion inputs.
 * @param {readonly object[]} options.messages - harness messages in request order.
 * @param {string | undefined} options.system - one-shot system prompt from `GenerateOptions`.
 * @param {string} options.provider - the registered route this adapter owns.
 * @param {string} options.model - exact model id.
 * @param {Map<string, {data: Uint8Array, mediaType: string, width: number, height: number}>} options.requestImages - prepared request-image versions by attachment id.
 * @param {(ref: object) => {readonlyPath?: string} | undefined} options.resolveImageAccess - execution-world path resolver for image handles.
 * @param {(ref: object) => string | undefined} options.resolveFileText - durable file handle text resolver.
 * @returns {{ systemInstruction: string | undefined, contents: object[] }}
 */
export function convertMessages(options) {
	const { messages, system, provider, model, requestImages, resolveImageAccess, resolveFileText } = options;
	const includeIds = requiresToolCallId(model);
	const toolNames = collectToolNames(messages);

	let systemInstruction;
	if (typeof system === 'string' && system.length > 0) systemInstruction = system;

	const contents = [];

	function pushText(text) {
		if (text.length === 0) return;
		const last = contents[contents.length - 1];
		if (last !== undefined && last.role === 'user') last.parts.push({ text });
		else contents.push({ role: 'user', parts: [{ text }] });
	}

	function inlinePartFor(ref) {
		const version = requestImages.get(ref.attachmentId);
		if (version === undefined) return undefined;
		return {
			inlineData: {
				mimeType: version.mediaType,
				data: Buffer.from(version.data).toString('base64'),
			},
		};
	}

	function imageHandleText(ref) {
		const version = requestImages.get(ref.attachmentId);
		const access = resolveImageAccess(ref);
		if (version !== undefined) {
			try {
				return requestImageHandleText(ref, version, access);
			} catch {
				// Fall through to the identifier-only handle when the version is unusable.
			}
		}
		return offloadedImageText(ref, access);
	}

	function nestedResponseText(blocks) {
		const parts = [];
		for (const block of blocks) {
			if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
			else if (block.type === 'image') parts.push('(image attached to tool result)');
			else if (block.type === 'file') {
				const text = resolveFileText(block.attachment);
				if (text !== undefined) parts.push(text);
			} else if (block.type === 'tool-call' && typeof block.name === 'string') parts.push(`[tool call ${block.name}]`);
		}
		return sanitizeSurrogates(parts.join('\n'));
	}

	let systemConsumed = false;

	for (const message of messages) {
		if (message.role === 'system') {
			const text = flattenText(message);
			if (!systemConsumed && systemInstruction === undefined) {
				systemConsumed = true;
				if (text.length > 0) systemInstruction = text;
				continue;
			}
			if (text.length > 0) pushText(sanitizeSurrogates(text));
			continue;
		}

		if (message.role === 'assistant') {
			const signatureFor = signatureAt(replayEnvelopeOf(message, provider));
			const parts = [];
			let order = 0;
			for (const block of message.content) {
				const signature = signatureFor(order);
				order += 1;
				if (block.type === 'text' && block.text.length > 0) {
					parts.push({ text: sanitizeSurrogates(block.text), ...(signature ? { thoughtSignature: signature } : {}) });
				} else if (block.type === 'reasoning' && block.text.trim().length > 0) {
					parts.push({ thought: true, text: sanitizeSurrogates(block.text), ...(signature ? { thoughtSignature: signature } : {}) });
				} else if (block.type === 'tool-call') {
					let args = {};
					try {
						const parsed = JSON.parse(block.arguments);
						if (typeof parsed === 'object' && parsed !== null) args = parsed;
					} catch {
						args = {};
					}
					parts.push({
						functionCall: {
							name: block.name,
							args,
							...(includeIds ? { id: block.id } : {}),
						},
						...(signature ? { thoughtSignature: signature } : {}),
					});
				}
			}
			if (parts.length > 0) contents.push({ role: 'model', parts });
			continue;
		}

		// role === 'user': text, images, files, and tool results.
		const parts = [];
		for (const block of message.content) {
			if (block.type === 'text' && block.text.length > 0) {
				parts.push({ text: sanitizeSurrogates(block.text) });
			} else if (block.type === 'image') {
				const version = requestImages.get(block.attachment.attachmentId);
				if (version !== undefined) {
					parts.push({ text: imageHandleText(block.attachment) });
					parts.push(inlinePartFor(block.attachment));
				}
			} else if (block.type === 'file') {
				const text = resolveFileText(block.attachment);
				if (text !== undefined) parts.push({ text });
			} else if (block.type === 'tool-result') {
				const name = toolNames.get(block.toolCallId) ?? block.toolCallId;
				const text = nestedResponseText(block.content);
				const inlineImages = [];
				if (supportsMultimodalFunctionResponse(model)) {
					for (const nested of block.content) {
						if (nested.type !== 'image') continue;
						const inline = inlinePartFor(nested.attachment);
						if (inline !== undefined) inlineImages.push(inline);
					}
				}
				const responseValue = text.length > 0 ? text : (inlineImages.length > 0 ? '(see attached image)' : '');
				parts.push({
					functionResponse: {
						name,
						response: block.isError === true ? { error: responseValue } : { output: responseValue },
						...(inlineImages.length > 0 ? { parts: inlineImages } : {}),
						...(includeIds ? { id: block.toolCallId } : {}),
					},
				});
			}
		}
		if (parts.length > 0) {
			const last = contents[contents.length - 1];
			if (last !== undefined && last.role === 'user' && parts.every((part) => part.functionResponse !== undefined)) {
				last.parts.push(...parts);
			} else {
				contents.push({ role: 'user', parts });
			}
		}
	}

	return { systemInstruction, contents };
}

/**
 * Assemble the complete request body for one call.
 * @param {object} request - conversion inputs (see {@link convertMessages}).
 * @param {object} controls - request controls: temperature, maxTokens, stop, reasoningEffort.
 * @param {readonly {name: string, description: string, parameters: object}[] | undefined} tools - harness tool schemas.
 * @returns {object} the JSON body.
 */
export function buildRequestBody(request, controls, tools) {
	const { systemInstruction, contents } = convertMessages(request);
	const generationConfig = {};
	if (controls.temperature !== undefined) generationConfig.temperature = controls.temperature;
	if (controls.maxTokens !== undefined) generationConfig.maxOutputTokens = controls.maxTokens;
	if (controls.stop !== undefined && controls.stop.length > 0) generationConfig.stopSequences = [...controls.stop];
	if (controls.reasoningEffort !== undefined) {
		const thinking = thinkingConfigFor(request.model, controls.reasoningEffort);
		if (thinking !== undefined) generationConfig.thinkingConfig = thinking;
	}

	return {
		contents,
		...(systemInstruction !== undefined ? { systemInstruction: { parts: [{ text: sanitizeSurrogates(systemInstruction) }] } } : {}),
		...(tools !== undefined && tools.length > 0 ? { tools: convertTools(tools, request.model) } : {}),
		...(Object.keys(generationConfig).length > 0 ? { generationConfig } : {}),
	};
}

/** Vertex finish reasons that mean the model refused or failed, not completed. */
const REFUSAL_FINISH_REASONS = new Set([
	'SAFETY', 'RECITATION', 'LANGUAGE', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII',
	'MALFORMED_FUNCTION_CALL', 'OTHER',
]);

/**
 * Translate parsed SSE `data` payloads into harness `StreamChunk`s.
 *
 * Emits block starts/deltas as parts arrive, then block ends, usage, and the
 * terminal finish. A completed stream with no visible content maps to an
 * `EMPTY_RESPONSE` error finish instead of a degenerate empty message. Coded
 * failures throw plain errors carrying `code`/`status` for the adapter to map.
 * @param {AsyncIterable<string>} payloads - JSON payload strings, in stream order.
 * @param {string} model - exact model id.
 * @yields {object} harness StreamChunk values.
 */
export async function* translatePayloads(payloads, model) {
	let nextIndex = 0;
	let textBlock;
	let reasoningBlock;
	const toolBlocks = [];
	let responseId;
	let modelVersion;
	let pendingFinish;
	let pendingUsage;
	let trafficType;
	let blockReason;
	let sawFunctionCall = false;
	let callCounter = 0;

	function open(kind) {
		return { index: nextIndex++, kind, text: '', name: undefined, callId: undefined, thoughtSignature: undefined };
	}

	function retainSignature(block, signature) {
		if (typeof signature === 'string' && signature.length > 0) block.thoughtSignature = signature;
	}

	for await (const payload of payloads) {
		let chunk;
		try {
			chunk = JSON.parse(payload);
		} catch {
			throw Object.assign(new Error(`malformed SSE payload: ${payload.slice(0, 120)}`), { code: 'MALFORMED_RESPONSE' });
		}

		if (typeof chunk.error === 'object' && chunk.error !== null) {
			const error = chunk.error;
			throw Object.assign(new Error(error.message ?? 'Vertex AI request failed'), {
				code: 'INVALID_RESPONSE',
				status: typeof error.code === 'number' ? error.code : undefined,
			});
		}
		if (typeof chunk.responseId === 'string') responseId = chunk.responseId;
		if (typeof chunk.modelVersion === 'string') modelVersion = chunk.modelVersion;

		const feedback = chunk.promptFeedback;
		if (typeof feedback === 'object' && feedback !== null && typeof feedback.blockReason === 'string') {
			blockReason = feedback.blockReason;
		}

		const candidate = chunk.candidates?.[0];
		if (typeof candidate?.finishReason === 'string') pendingFinish = candidate.finishReason;
		for (const part of candidate?.content?.parts ?? []) {
			const signature = part.thoughtSignature;
			const call = part.functionCall;
			if (call !== undefined && call !== null) {
				sawFunctionCall = true;
				const block = open('tool-call');
				toolBlocks.push(block);
				block.callId = mintToolCallId(responseId, callCounter++);
				block.name = typeof call.name === 'string' ? call.name : '';
				const argumentsJson = JSON.stringify(call.args ?? {});
				block.text += argumentsJson;
				retainSignature(block, signature);
				yield { type: 'block-start', index: block.index, blockType: 'tool-call' };
				yield {
					type: 'tool-call-delta',
					index: block.index,
					id: block.callId,
					...(block.name.length > 0 ? { name: block.name } : {}),
					argumentsDelta: argumentsJson,
				};
				continue;
			}
			if (part.thought === true) {
				const text = typeof part.text === 'string' ? part.text : '';
				if (text.length === 0) continue;
				if (reasoningBlock === undefined) {
					reasoningBlock = open('reasoning');
					yield { type: 'block-start', index: reasoningBlock.index, blockType: 'reasoning' };
				}
				reasoningBlock.text += text;
				retainSignature(reasoningBlock, signature);
				yield { type: 'reasoning-delta', index: reasoningBlock.index, text };
				continue;
			}
			const text = typeof part.text === 'string' ? part.text : '';
			if (text.length === 0) continue;
			if (textBlock === undefined) {
				textBlock = open('text');
				yield { type: 'block-start', index: textBlock.index, blockType: 'text' };
			}
			textBlock.text += text;
			retainSignature(textBlock, signature);
			yield { type: 'text-delta', index: textBlock.index, text };
		}

		const usage = chunk.usageMetadata;
		if (typeof usage === 'object' && usage !== null) {
			if (typeof usage.trafficType === 'string') trafficType = usage.trafficType;
			const cached = typeof usage.cachedContentTokenCount === 'number' ? usage.cachedContentTokenCount : 0;
			const prompt = typeof usage.promptTokenCount === 'number' ? usage.promptTokenCount : 0;
			const output = typeof usage.candidatesTokenCount === 'number' ? usage.candidatesTokenCount : 0;
			const reasoning = typeof usage.thoughtsTokenCount === 'number' ? usage.thoughtsTokenCount : undefined;
			pendingUsage = {
				inputTokens: Math.max(prompt - cached, 0),
				outputTokens: output,
				...(typeof usage.totalTokenCount === 'number' ? { totalTokens: usage.totalTokenCount } : {}),
				...(cached > 0 ? { cacheReadTokens: cached } : {}),
				...(reasoning !== undefined ? { reasoningTokens: reasoning } : {}),
			};
		}
	}

	const blocks = [...(reasoningBlock !== undefined ? [reasoningBlock] : []), ...(textBlock !== undefined ? [textBlock] : []), ...toolBlocks]
		.sort((left, right) => left.index - right.index);
	for (const block of blocks) {
		yield { type: 'block-end', index: block.index, block: closeBlock(block) };
	}
	if (pendingUsage !== undefined) yield { type: 'usage', usage: pendingUsage };

	let reason;
	if (blockReason !== undefined) {
		reason = { kind: 'error', failure: { message: `Vertex AI blocked the prompt: ${blockReason}`, code: 'PROVIDER_REFUSED' } };
	} else if (pendingFinish !== undefined && REFUSAL_FINISH_REASONS.has(pendingFinish)) {
		reason = { kind: 'error', failure: { message: `Vertex AI stopped early: ${pendingFinish}`, code: 'PROVIDER_REFUSED' } };
	} else if (pendingFinish === 'MAX_TOKENS') {
		reason = { kind: 'max-tokens' };
	} else if (blocks.length === 0) {
		reason = { kind: 'error', failure: { message: 'model returned a completed response with no content', code: 'EMPTY_RESPONSE' } };
	} else {
		reason = { kind: sawFunctionCall ? 'tool-calls' : 'stop' };
	}
	yield {
		type: 'finish',
		reason,
		replayState: {
			v: 1,
			response: {
				...(responseId !== undefined ? { responseId } : {}),
				...(modelVersion !== undefined ? { modelVersion } : {}),
				...(pendingFinish !== undefined ? { finishReason: pendingFinish } : {}),
				...(trafficType !== undefined ? { trafficType } : {}),
			},
			blocks: blocks.map((block) => ({ ...(block.thoughtSignature !== undefined ? { thoughtSignature: block.thoughtSignature } : {}) })),
		},
	};
}

/**
 * Close one open block into its harness `ContentBlock`.
 * @param {object} block - the open block state.
 * @returns {object} the assembled content block.
 */
function closeBlock(block) {
	switch (block.kind) {
		case 'text': return { type: 'text', text: block.text };
		case 'reasoning': return { type: 'reasoning', text: block.text };
		case 'tool-call': return {
			type: 'tool-call',
			id: block.callId,
			name: block.name ?? '',
			arguments: block.text,
		};
		default: throw new Error(`unknown block kind ${block.kind}`);
	}
}

/**
 * Mint a stable tool-call id. Gemini does not issue one; the id only needs to
 * correlate the call with its result inside this conversation, so the response
 * id plus a per-response counter keep ids unique across turns.
 * @param {string | undefined} responseId - provider response id when known.
 * @param {number} counter - the call ordinal within this response.
 * @returns {string} a call id.
 */
function mintToolCallId(responseId, counter) {
	return `call_${responseId ?? 'unknown'}_${counter}`.replace(/[^A-Za-z0-9_.-]/g, '_');
}
