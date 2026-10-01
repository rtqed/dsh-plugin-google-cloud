/**
 * The `generate_image` tool: Vertex AI Gemini image models and Imagen, whose
 * output is committed to the durable attachment store and returned as image
 * content blocks beside a text envelope.
 *
 * Why a tool and not a chat model: the harness block vocabulary is
 * text/reasoning/tool-call only, no model metadata can declare image output,
 * and an assistant message cannot carry an image block. A tool result is the
 * one place an image may legitimately enter the conversation, and it is a
 * first-class one — the client renders `{ type: 'image' }` from chat,
 * trajectory, and primitives alike.
 *
 * The tool deliberately does NOT copy `read_image`'s image-capable-route gate:
 * the runtime degrades image blocks to placeholder text on a model that
 * declares no image input, so generating an image stays legal (and the user
 * still sees it) while the calling model only reads the text envelope.
 *
 * @module dsh-plugin-google-cloud/imagegen
 */
import { Buffer } from 'node:buffer';
import { AttachmentError, AttachmentId, isAttachmentError } from '@deepseek-ai/dsh-attachment';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { endpointFor } from './endpoint.js';
import {
	DEFAULT_IMAGE_ASPECT_RATIO,
	DEFAULT_IMAGE_MODEL,
	IMAGE_ASPECT_RATIOS,
	MAX_IMAGE_COUNT,
	imageModelFor,
} from './image-catalog.js';
import { assertTierEndpointSupport, postVertexJson, readVertexJson } from './vertex-request.js';

/** The model-facing tool name. */
export const GENERATE_IMAGE_TOOL_NAME = 'generate_image';

/** Media types this tool can commit; the deployment may accept a narrower set. */
const SUPPORTED_MEDIA_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

/** Extension per media type, for the display name the attachment store records. */
const MEDIA_TYPE_EXTENSIONS = Object.freeze({
	'image/png': 'png',
	'image/jpeg': 'jpg',
	'image/webp': 'webp',
	'image/gif': 'gif',
});

/**
 * The structured image value the tool returns, mirroring the harness
 * `ImageAttachmentRef` plus the host path a user can open directly.
 */
export const IMAGE_VALUE_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	properties: {
		attachmentId: { type: 'string', required: true },
		mediaType: { type: 'string', enum: [...SUPPORTED_MEDIA_TYPES], required: true },
		bytes: { type: 'integer', required: true },
		width: { type: 'integer', required: true },
		height: { type: 'integer', required: true },
		name: { type: 'string' },
		hostPath: { type: 'string' },
		originalDimensions: {
			type: 'object',
			additionalProperties: false,
			properties: {
				width: { type: 'integer', required: true },
				height: { type: 'integer', required: true },
			},
		},
	},
};

/**
 * The registered tool's result schema. Every field of the value is declared:
 * the runtime validates the result against this schema before `render` sees it.
 */
export const GENERATE_IMAGE_VALUE_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	properties: {
		model: { type: 'string', required: true },
		family: { type: 'string', enum: ['gemini', 'imagen'], required: true },
		prompt: { type: 'string', required: true },
		aspectRatio: { type: 'string', required: true },
		images: { type: 'array', required: true, items: IMAGE_VALUE_SCHEMA },
	},
};

/**
 * Render one generated-image value as its model-facing envelope plus one image
 * block per image. The envelope mirrors `read_image`: the host path of the
 * durable attachment, then the normalized facts, so a user has a real file to
 * open and the model has the attachment's identity and geometry.
 * @param {object} value - the structured tool result.
 * @returns {object[]} content blocks: one text block, then the images.
 */
export function generateImageContent(value) {
	const count = value.images.length;
	const headline = `${value.model} generated ${count} image${count === 1 ? '' : 's'} at ${value.aspectRatio}.`;
	const envelopes = value.images.map((image) => formatImageEnvelope(image));
	return [
		{ type: 'text', text: [headline, ...envelopes].join('\n') },
		...value.images.map((image) => ({
			type: 'image',
			attachment: {
				attachmentId: AttachmentId(image.attachmentId),
				mediaType: image.mediaType,
				bytes: image.bytes,
				width: image.width,
				height: image.height,
				...(image.name === undefined ? {} : { name: image.name }),
				...(image.originalDimensions === undefined
					? {}
					: { originalDimensions: { ...image.originalDimensions } }),
			},
		})),
	];
}

/**
 * Format one committed image as its text envelope.
 * @param {object} image - one entry of the value's `images` array.
 * @returns {string} the envelope.
 */
function formatImageEnvelope(image) {
	let scaled = '';
	if (image.originalDimensions !== undefined) {
		scaled = ` (downscaled from ${image.originalDimensions.width}x${image.originalDimensions.height} px)`;
	}
	return [
		`<path>${image.hostPath ?? `attachment:${image.attachmentId}`}</path>`,
		'<type>image</type>',
		'<content>',
		`${image.mediaType} image, ${image.width}x${image.height} px, ${image.bytes} bytes${scaled}`,
		'</content>',
	].join('\n');
}

/**
 * Register the tool on the context that has the durable attachment store.
 * @param {object} ctx - the injection scope owning `tools` and `attachments`.
 * @param {object} deps - the host facts the tool reads at execution time.
 * @param {() => object} deps.resolveConnection - live connection snapshot, including the image settings.
 * @param {() => object | undefined} deps.resolveAttachments - the durable attachment store, when mounted.
 * @param {typeof fetch} deps.fetch - the fetch implementation.
 * @param {object} [deps.logger] - the plugin logger, for one line per generated batch.
 * @returns {() => void} the disposer that unregisters the tool.
 */
export function registerGenerateImageTool(ctx, deps) {
	return ctx.tools.register(defineTool({
		name: GENERATE_IMAGE_TOOL_NAME,
		description: [
			'Generate image(s) with Google Vertex AI (Gemini image models or Imagen) and display them in the conversation.',
			'Each image is billed per generated image, so generate only what the user asked for.',
			'Returns the images plus the host path of each durable attachment.',
			'On a text-only model route the images still render for the user while this model reads the text envelope.',
		].join(' '),
		parameters: {
			prompt: {
				type: 'string',
				required: true,
				description: 'The image description. Describe subject, composition, style, and any text to render; it is sent verbatim.',
			},
			model: {
				type: 'string',
				description: `Image model id, e.g. "gemini-3-pro-image", "gemini-3.1-flash-image", "gemini-3.1-flash-lite-image", "imagen-4.0-generate-001". Defaults to the imageModel setting (currently "${DEFAULT_IMAGE_MODEL}").`,
			},
			aspect_ratio: {
				type: 'string',
				enum: [...IMAGE_ASPECT_RATIOS],
				description: `Output aspect ratio; one of ${IMAGE_ASPECT_RATIOS.map((ratio) => `"${ratio}"`).join(', ')}. Defaults to the imageAspectRatio setting.`,
			},
			count: {
				type: 'integer',
				description: `How many images to generate, 1 through ${MAX_IMAGE_COUNT}. Defaults to the imageCount setting. Each image is billed separately.`,
			},
		},
		output: {
			schema: GENERATE_IMAGE_VALUE_SCHEMA,
			render: (_args, value) => generateImageContent(value),
			presentationMeta: (_args, value) => ({
				model: value.model,
				prompt: value.prompt.slice(0, 200),
				images: value.images.length,
			}),
		},
		isConcurrencySafe: () => false,
		timeoutMs: 180000,
		async execute(args, exec) {
			return generateImage(deps, args, exec);
		},
		presentCall(args) {
			const prompt = args.prompt.length > 80 ? `${args.prompt.slice(0, 80)}…` : args.prompt;
			return {
				card: 'generic',
				title: `Generate image: ${prompt}`,
				kind: 'execute',
				rawInput: args.prompt,
			};
		},
	}));
}

/**
 * Run one generation call end to end: resolve the route and settings, ask the
 * family's endpoint, admit the bytes into the attachment store, and project
 * everything into the tool's value.
 * @param {object} deps - the registration deps; see {@link registerGenerateImageTool}.
 * @param {object} args - the validated tool arguments.
 * @param {object} [exec] - the tool execution context, for cancellation.
 * @returns {Promise<object>} the structured value the render consumes.
 */
export async function generateImage(deps, args, exec) {
	const connection = deps.resolveConnection();
	if (connection.imageToolEnabled === false) {
		throw new Error('generate_image is turned off in the google-cloud settings (imageToolEnabled: false); enable it to generate images');
	}
	const attachments = deps.resolveAttachments?.();
	if (attachments === undefined) {
		throw new Error('generate_image requires the durable attachment service, which is not mounted in this deployment');
	}

	const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
	if (prompt.length === 0) throw new Error('generate_image requires a non-empty prompt');

	const modelId = resolveModelId(args.model, connection);
	const entry = imageModelFor(modelId);
	const aspectRatio = resolveAspectRatio(args.aspect_ratio ?? connection.imageAspectRatio);
	const count = resolveCount(args.count ?? connection.imageCount, entry);

	const auth = connection.resolveAuth !== undefined
		? await connection.resolveAuth()
		: { mode: 'express', apiKey: await connection.resolveApiKey() };
	const effective = {
		...connection,
		authMode: auth.mode,
		projectId: connection.projectId || (auth.mode === 'full' ? (auth.projectId ?? '') : ''),
	};
	const endpoint = endpointFor(effective);
	const tier = effective.tier ?? 'standard';
	assertTierEndpointSupport(tier, effective.region);

	const signal = exec?.signal;
	const produced = entry.family === 'imagen'
		? await requestImagen({ deps, entry, endpoint, auth, connection: effective, prompt, aspectRatio, count, signal })
		: await requestGemini({ deps, entry, endpoint, auth, connection: effective, prompt, aspectRatio, count, signal });

	const prepared = produced.map((image, index) => ({
		data: decodeBase64(image.base64, { model: entry.id, index }),
		mediaType: image.mediaType,
		name: `vertex-${entry.family}-${Date.now()}-${index + 1}.${MEDIA_TYPE_EXTENSIONS[image.mediaType] ?? 'bin'}`,
	}));
	assertDeploymentAdmits(attachments, prepared, entry.id);

	let refs;
	try {
		refs = await attachments.saveImages(prepared);
	} catch (error) {
		throw mapAttachmentError(error, attachments, entry.id);
	}
	deps.logger?.info(
		'google-cloud: generate_image produced %d image(s) with %s (%s, %s)',
		refs.length,
		entry.id,
		entry.family,
		aspectRatio,
	);

	return {
		model: entry.id,
		family: entry.family,
		prompt,
		aspectRatio,
		images: refs.map((ref, index) => imageValue(ref, prepared[index].mediaType, attachments)),
	};
}

/**
 * Resolve the model id from the call, then the settings, then the default.
 * @param {string | undefined} requested - the `model` argument.
 * @param {object} connection - the live connection snapshot.
 * @returns {string} the model id to call.
 */
function resolveModelId(requested, connection) {
	const candidates = [requested, connection.imageModel, DEFAULT_IMAGE_MODEL];
	for (const candidate of candidates) {
		if (typeof candidate === 'string' && candidate.trim().length > 0) return candidate.trim();
	}
	return DEFAULT_IMAGE_MODEL;
}

/**
 * Resolve and validate the aspect ratio.
 * @param {unknown} requested - the `aspect_ratio` argument or the settings value.
 * @returns {string} a supported aspect ratio.
 * @throws {Error} naming the setting and the argument when the value is unsupported.
 */
function resolveAspectRatio(requested) {
	if (requested === undefined || requested === null || requested === '') return DEFAULT_IMAGE_ASPECT_RATIO;
	if (typeof requested === 'string' && IMAGE_ASPECT_RATIOS.includes(requested)) return requested;
	throw new Error(
		`generate_image: unsupported aspect ratio ${JSON.stringify(requested)} — use one of ${IMAGE_ASPECT_RATIOS.join(', ')} (set imageAspectRatio in the google-cloud settings, or pass aspect_ratio)`,
	);
}

/**
 * Resolve and bound the image count.
 * @param {unknown} requested - the `count` argument or the settings value.
 * @param {object} entry - the resolved catalog entry.
 * @returns {number} the count to generate.
 * @throws {Error} when the request exceeds the per-call ceiling.
 */
function resolveCount(requested, entry) {
	if (requested === undefined || requested === null) return 1;
	const limit = Math.min(entry.maxCount, MAX_IMAGE_COUNT);
	const value = Number(requested);
	if (!Number.isInteger(value) || value < 1) {
		throw new Error(`generate_image: count must be an integer from 1 through ${limit}`);
	}
	if (value > limit) {
		throw new Error(`generate_image: count ${value} exceeds the ${limit}-image ceiling of one call — issue several calls instead`);
	}
	return value;
}

/**
 * Ask a Gemini image model for images. These models answer exactly one image
 * per request (`candidateCount` is refused for image responses), so a batch is
 * one request per image, in order.
 * @param {object} facts - the resolved call facts.
 * @returns {Promise<object[]>} the produced images, each `{base64, mediaType}`.
 */
async function requestGemini({ deps, entry, endpoint, auth, connection, prompt, aspectRatio, count, signal }) {
	const images = [];
	const body = {
		contents: [{ role: 'user', parts: [{ text: prompt }] }],
		generationConfig: {
			// Without this the model answers with text only, which reads exactly
			// like a model that cannot generate images at all.
			responseModalities: ['TEXT', 'IMAGE'],
			imageConfig: { aspectRatio },
		},
	};
	for (let index = 0; index < count; index += 1) {
		signal?.throwIfAborted?.();
		const payload = await readVertexJson(
			await postVertexJson({
				url: modelUrl(endpoint, entry.id, 'generateContent', auth),
				body,
				signal,
				connection,
				auth,
				accept: 'application/json',
				fetch: deps.fetch,
			}),
			{ endpoint, connection },
		);
		images.push(...parseGeminiPayload(payload, entry.id));
	}
	return images;
}

/**
 * Ask an Imagen model for images. Imagen batches natively through
 * `parameters.sampleCount`, so a batch is one request.
 * @param {object} facts - the resolved call facts.
 * @returns {Promise<object[]>} the produced images, each `{base64, mediaType}`.
 */
async function requestImagen({ deps, entry, endpoint, auth, connection, prompt, aspectRatio, count, signal }) {
	signal?.throwIfAborted?.();
	const body = {
		instances: [{ prompt }],
		parameters: { sampleCount: count, aspectRatio },
	};
	const payload = await readVertexJson(
		await postVertexJson({
			url: modelUrl(endpoint, entry.id, 'predict', auth),
			body,
			signal,
			connection,
			auth,
			accept: 'application/json',
			fetch: deps.fetch,
		}),
		{ endpoint, connection },
	);
	return parseImagenPayload(payload, entry.id);
}

/**
 * Build one model URL with the credential this connection uses.
 * @param {string} endpoint - the resolved endpoint root.
 * @param {string} model - the model id.
 * @param {string} verb - the method suffix, without the colon.
 * @param {object} auth - the resolved authentication snapshot.
 * @returns {string} the complete URL.
 */
function modelUrl(endpoint, model, verb, auth) {
	const base = `${endpoint}/publishers/google/models/${encodeURIComponent(model)}:${verb}`;
	return auth.mode === 'full' ? base : `${base}?key=${encodeURIComponent(auth.apiKey)}`;
}

/**
 * Read the inline images out of one Gemini response.
 * @param {object} payload - the parsed response body.
 * @param {string} model - the model id, for the diagnostic.
 * @returns {object[]} the produced images.
 * @throws {Error} an actionable failure when the response carries no image.
 */
function parseGeminiPayload(payload, model) {
	const candidate = payload?.candidates?.[0];
	const parts = candidate?.content?.parts;
	if (!Array.isArray(parts)) throw new Error(noImageMessage(model, payload, candidate));
	const images = [];
	const texts = [];
	for (const part of parts) {
		const data = part?.inlineData?.data;
		if (typeof data === 'string' && data.length > 0) {
			images.push({ base64: data, mediaType: normalizeMediaType(part.inlineData.mimeType) });
		} else if (typeof part?.text === 'string' && part.text.trim().length > 0) {
			texts.push(part.text.trim());
		}
	}
	if (images.length === 0) throw new Error(noImageMessage(model, payload, candidate, texts));
	return images;
}

/**
 * Describe a Gemini response that carried no image, naming the likeliest cause:
 * a safety refusal, a text-only answer, or a model without image output.
 * @param {string} model - the model id.
 * @param {object} payload - the parsed response body.
 * @param {object | undefined} candidate - the first candidate.
 * @param {string[]} [texts] - the text parts the model answered with.
 * @returns {string} the failure message.
 */
function noImageMessage(model, payload, candidate, texts = []) {
	const reason = candidate?.finishReason ?? payload?.promptFeedback?.blockReason;
	const suffix = reason === undefined ? '' : ` (finishReason: ${reason})`;
	const said = texts.length === 0 ? '' : `: ${texts.join(' ').slice(0, 300)}`;
	const hint = payload?.promptFeedback?.blockReason === undefined
		? ' — the model may not serve image output for this project, or the prompt was refused'
		: ' — the prompt was blocked by the safety filter';
	return `generate_image: ${model} returned no image${suffix}${said}${hint}`;
}

/**
 * Read the images out of one Imagen response.
 * @param {object} payload - the parsed response body.
 * @param {string} model - the model id, for the diagnostic.
 * @returns {object[]} the produced images.
 * @throws {Error} an actionable failure when the response carries no image.
 */
function parseImagenPayload(payload, model) {
	const predictions = payload?.predictions;
	if (!Array.isArray(predictions) || predictions.length === 0) {
		const filtered = payload?.predictions?.[0]?.raiFilteredReason;
		throw new Error(
			`generate_image: ${model} returned no image${filtered === undefined ? '' : ` (raiFilteredReason: ${filtered})`} — the prompt may have been filtered, or the request parameters were refused`,
		);
	}
	return predictions.map((prediction) => {
		const data = prediction?.bytesBase64Encoded;
		const filtered = prediction?.raiFilteredReason;
		if (typeof data !== 'string' || data.length === 0) {
			throw new Error(`generate_image: ${model} returned a prediction without image bytes${filtered === undefined ? '' : ` (raiFilteredReason: ${filtered})`}`);
		}
		return { base64: data, mediaType: normalizeMediaType(prediction.mimeType) };
	});
}

/**
 * Normalize one provider media type to a supported one.
 * @param {unknown} mimeType - the provider's declared media type.
 * @returns {string} a supported media type; PNG when the provider named none.
 * @throws {Error} when the provider named a type this tool cannot commit.
 */
function normalizeMediaType(mimeType) {
	if (mimeType === undefined || mimeType === null || mimeType === '') return 'image/png';
	if (typeof mimeType === 'string' && SUPPORTED_MEDIA_TYPES.includes(mimeType)) return mimeType;
	throw new Error(`generate_image: the provider returned an unsupported image type ${JSON.stringify(mimeType)}; supported types are ${SUPPORTED_MEDIA_TYPES.join(', ')}`);
}

/**
 * Decode one base64 image payload.
 * @param {string} base64 - the provider's payload.
 * @param {object} facts - the model and index, for the diagnostic.
 * @returns {Uint8Array} the image bytes.
 * @throws {Error} when the payload is not usable base64.
 */
function decodeBase64(base64, { model, index }) {
	const data = new Uint8Array(Buffer.from(base64, 'base64'));
	if (data.byteLength === 0) {
		throw new Error(`generate_image: ${model} returned an empty image payload for image ${index + 1}`);
	}
	return data;
}

/**
 * Refuse a batch the deployment cannot store before any write happens, naming
 * the limit that refused it. The attachment store would refuse the same batch,
 * but only after the generation has already been billed.
 * @param {object} attachments - the durable attachment store.
 * @param {object[]} prepared - the decoded images in order.
 * @param {string} model - the model id, for the diagnostic.
 * @throws {Error} an actionable refusal naming the offending image.
 */
function assertDeploymentAdmits(attachments, prepared, model) {
	const limits = attachments.imageLimits;
	if (limits === undefined) return;
	if (prepared.length > limits.maxImagesPerMessage) {
		throw new Error(`generate_image: ${prepared.length} images exceed this deployment's ${limits.maxImagesPerMessage}-image limit per message — ask for fewer`);
	}
	let total = 0;
	for (const [index, image] of prepared.entries()) {
		if (!limits.mediaTypes.includes(image.mediaType)) {
			throw new Error(`generate_image: ${model} returned ${image.mediaType} for image ${index + 1}, which this deployment does not accept (${limits.mediaTypes.join(', ')})`);
		}
		if (image.data.byteLength > limits.maxImageBytes) {
			throw new Error(`generate_image: image ${index + 1} is ${image.data.byteLength} bytes, beyond this deployment's ${limits.maxImageBytes}-byte image limit — try a smaller aspect ratio or another model`);
		}
		const size = imageDimensions(image.data);
		if (size !== undefined) {
			if (size.width > limits.maxImageDimension || size.height > limits.maxImageDimension) {
				throw new Error(`generate_image: image ${index + 1} is ${size.width}x${size.height} px, beyond this deployment's ${limits.maxImageDimension}px side limit — try another aspect ratio or model`);
			}
			if (size.width * size.height > limits.maxImagePixels) {
				throw new Error(`generate_image: image ${index + 1} is ${size.width * size.height} pixels, beyond this deployment's ${limits.maxImagePixels}-pixel limit — try another aspect ratio or model`);
			}
		}
		total += image.data.byteLength;
	}
	if (total > limits.maxMessageImageBytes) {
		throw new Error(`generate_image: the batch totals ${total} bytes, beyond this deployment's ${limits.maxMessageImageBytes}-byte per-message image limit — ask for fewer images`);
	}
}

/**
 * Map one attachment-store refusal onto an actionable message. Codes are the
 * store's stable taxonomy, so this routes on `code` and never on the message.
 * @param {unknown} error - the value caught from the store.
 * @param {object} attachments - the store, read for its limits.
 * @param {string} model - the model id.
 * @returns {Error} the mapped failure.
 * @throws {unknown} rethrows anything that is not an attachment failure.
 */
function mapAttachmentError(error, attachments, model) {
	if (!isAttachmentError(error)) throw error;
	const limits = attachments.imageLimits ?? {};
	switch (error.code) {
		case 'IMAGE_DIMENSION_TOO_LARGE':
			return new Error(`generate_image: ${model} returned an image whose side exceeds the ${limits.maxImageDimension}px limit of this deployment — try another aspect ratio or model`, { cause: error });
		case 'IMAGE_TOO_MANY_PIXELS':
			return new Error(`generate_image: ${model} returned an image beyond the ${limits.maxImagePixels}-pixel limit of this deployment — try another aspect ratio or model`, { cause: error });
		case 'IMAGE_TOO_LARGE':
			return new Error(`generate_image: ${model} returned an image the attachment store cannot hold within this deployment's byte limits — try another model`, { cause: error });
		case 'IMAGES_TOO_LARGE':
			return new Error(`generate_image: the image batch exceeds this deployment's aggregate byte limit — ask for fewer images`, { cause: error });
		case 'TOO_MANY_IMAGES':
			return new Error(`generate_image: the batch exceeds this deployment's image-count limit — ask for fewer images`, { cause: error });
		case 'UNSUPPORTED_IMAGE_TYPE':
			return new Error(`generate_image: the deployment does not accept this image type — try another model`, { cause: error });
		case 'INVALID_IMAGE':
		case 'INVALID_IMAGE_BASE64':
		case 'IMAGE_TYPE_MISMATCH':
			return new Error(`generate_image: ${model} returned bytes that do not decode as a supported image; retry, or try another model`, { cause: error });
		case 'ATTACHMENT_WRITE_FAILED':
			return new Error(`generate_image: the generated image could not be stored durably (attachment write failed)`, { cause: error });
		default:
			return error instanceof AttachmentError ? new Error(`generate_image: the generated image was refused by the attachment store (${error.code})`, { cause: error }) : error;
	}
}

/**
 * Project one committed attachment reference into the tool value, adding the
 * host path a user can open directly.
 * @param {object} ref - the durable normalized reference.
 * @param {string} mediaType - the media type that was submitted.
 * @param {object} attachments - the store, for the host path.
 * @returns {object} the `images` entry.
 */
function imageValue(ref, mediaType, attachments) {
	let hostPath;
	try {
		hostPath = attachments.imageHostPath?.(ref);
	} catch {
		// A backend without host-file storage simply reports no path.
		hostPath = undefined;
	}
	return {
		attachmentId: ref.attachmentId,
		mediaType: ref.mediaType ?? mediaType,
		bytes: ref.bytes,
		width: ref.width,
		height: ref.height,
		...(ref.name === undefined ? {} : { name: ref.name }),
		...(typeof hostPath === 'string' && hostPath.length > 0 ? { hostPath } : {}),
		...(ref.originalDimensions === undefined
			? {}
			: { originalDimensions: { width: ref.originalDimensions.width, height: ref.originalDimensions.height } }),
	};
}

/**
 * Read the pixel dimensions declared by a PNG/JPEG/WebP/GIF header.
 * @param {Uint8Array} data - the image bytes.
 * @returns {{width: number, height: number} | undefined} the dimensions, when the header is readable.
 */
export function imageDimensions(data) {
	if (matchesAscii(data, 0, '\x89PNG\r\n\x1a\n') && data.byteLength >= 24) {
		return { width: readUInt32BE(data, 16), height: readUInt32BE(data, 20) };
	}
	if ((matchesAscii(data, 0, 'GIF87a') || matchesAscii(data, 0, 'GIF89a')) && data.byteLength >= 10) {
		return { width: data[6] | (data[7] << 8), height: data[8] | (data[9] << 8) };
	}
	if (matchesAscii(data, 0, 'RIFF') && matchesAscii(data, 8, 'WEBP')) {
		if (matchesAscii(data, 12, 'VP8X') && data.byteLength >= 30) {
			return { width: readUInt24LE(data, 24) + 1, height: readUInt24LE(data, 27) + 1 };
		}
		if (matchesAscii(data, 12, 'VP8L') && data.byteLength >= 25) {
			const bits = data[21] | (data[22] << 8) | (data[23] << 16) | (data[24] << 24);
			return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
		}
		return undefined;
	}
	return jpegDimensions(data);
}

/**
 * Read the dimensions from the first JPEG SOF marker.
 * @param {Uint8Array} data - the image bytes.
 * @returns {{width: number, height: number} | undefined} the dimensions, when a SOF marker is present.
 */
function jpegDimensions(data) {
	if (!matchesAscii(data, 0, '\xff\xd8\xff')) return undefined;
	let offset = 2;
	while (offset + 9 <= data.byteLength) {
		if (data[offset] !== 0xff) {
			offset += 1;
			continue;
		}
		const marker = data[offset + 1];
		if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) {
			offset += 2;
			continue;
		}
		const length = (data[offset + 2] << 8) | data[offset + 3];
		if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
			return {
				height: (data[offset + 5] << 8) | data[offset + 6],
				width: (data[offset + 7] << 8) | data[offset + 8],
			};
		}
		if (length <= 0) return undefined;
		offset += 2 + length;
	}
	return undefined;
}

/**
 * Compare ASCII bytes at one offset.
 * @param {Uint8Array} data - the bytes.
 * @param {number} offset - the offset to compare at.
 * @param {string} value - the expected ASCII text.
 * @returns {boolean} whether the bytes match.
 */
function matchesAscii(data, offset, value) {
	if (data.byteLength < offset + value.length) return false;
	for (let index = 0; index < value.length; index += 1) {
		if (data[offset + index] !== value.charCodeAt(index)) return false;
	}
	return true;
}

/**
 * Read one big-endian unsigned 32-bit integer.
 * @param {Uint8Array} data - the bytes.
 * @param {number} offset - the offset to read at.
 * @returns {number} the value.
 */
function readUInt32BE(data, offset) {
	return ((data[offset] << 24) | (data[offset + 1] << 16) | (data[offset + 2] << 8) | data[offset + 3]) >>> 0;
}

/**
 * Read one little-endian unsigned 24-bit integer.
 * @param {Uint8Array} data - the bytes.
 * @param {number} offset - the offset to read at.
 * @returns {number} the value.
 */
function readUInt24LE(data, offset) {
	return data[offset] | (data[offset + 1] << 8) | (data[offset + 2] << 16);
}
