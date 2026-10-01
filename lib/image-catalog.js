/**
 * Static Vertex AI image-generation model catalog.
 *
 * Deliberately separate from `catalog.js`: that file lists the models the chat
 * route may select, and an image model must never appear there. Chat responses
 * carry only text/reasoning/tool-call blocks, and this plugin's streaming
 * translation drops `inlineData` parts, so a model in the chat picker would
 * answer every prompt with nothing. Image models are reachable exclusively
 * through the `generate_image` tool, which reads this catalog.
 *
 * Two families are supported, and they differ in more than the URL suffix:
 *
 * - `gemini` — the Gemini image models, served by the same
 *   `:generateContent` verb as chat. They answer one image per request
 *   (`candidateCount` is refused for image responses), so N images mean N
 *   requests, and the media type is whatever the inline part declares — the
 *   Flash-Lite model returns JPEG.
 * - `imagen` — the Imagen models, served by `:predict`, which batches natively
 *   through `parameters.sampleCount`.
 *
 * Ids were verified live against the deployment's own credential (see
 * README.zh.md, "生图工具"); membership here is advisory and the endpoint stays
 * authoritative for access.
 *
 * @module dsh-plugin-google-cloud/image-catalog
 */
/** The image model the tool uses when neither the call nor the settings name one. */
export const DEFAULT_IMAGE_MODEL = 'gemini-2.5-flash-image';
/** The aspect ratio the tool uses when neither the call nor the settings name one. */
export const DEFAULT_IMAGE_ASPECT_RATIO = '1:1';
/** Aspect ratios every supported model accepts, verified against the live endpoint. */
export const IMAGE_ASPECT_RATIOS = Object.freeze(['1:1', '16:9', '9:16', '4:3', '3:4']);
/** Hard ceiling on images per call, for both families; also the cost guardrail. */
export const MAX_IMAGE_COUNT = 4;

/**
 * One catalog entry.
 *
 * `family` picks the wire path; `mediaTypes` documents what the family has been
 * observed to return, never what the parser accepts — the parser accepts any
 * media type the attachment store admits.
 */
const MODELS = [
	{
		id: 'gemini-2.5-flash-image',
		name: 'Gemini 2.5 Flash Image',
		family: 'gemini',
		description: '通用快速生图（nano banana），PNG 输出并附带一段文字说明。',
	},
	{
		id: 'gemini-3.1-flash-image',
		name: 'Gemini 3.1 Flash Image',
		family: 'gemini',
		description: '新一代快速生图，PNG 输出。',
	},
	{
		id: 'gemini-3-pro-image',
		name: 'Gemini 3 Pro Image',
		family: 'gemini',
		description: '质量优先的生图模型，PNG 输出，支持高分辨率长边。',
	},
	{
		id: 'gemini-3.1-flash-lite-image',
		name: 'Gemini 3.1 Flash Lite Image',
		family: 'gemini',
		description: '最省成本的生图模型，JPEG 输出。',
	},
	{
		id: 'imagen-4.0-generate-001',
		name: 'Imagen 4',
		family: 'imagen',
		description: 'Imagen 4 标准版，一次请求可批量出图（sampleCount）。',
	},
	{
		id: 'imagen-4.0-fast-generate-001',
		name: 'Imagen 4 Fast',
		family: 'imagen',
		description: 'Imagen 4 快速版，单张成本更低。',
	},
	{
		id: 'imagen-4.0-ultra-generate-001',
		name: 'Imagen 4 Ultra',
		family: 'imagen',
		description: 'Imagen 4 超清版，画质最高、单价最高。',
	},
];

/** The frozen catalog, in presentation order. */
export const IMAGE_MODELS = Object.freeze(MODELS.map((model) => Object.freeze({
	...model,
	aspectRatios: IMAGE_ASPECT_RATIOS,
	maxCount: MAX_IMAGE_COUNT,
})));

/**
 * Resolve one model id to its catalog entry.
 *
 * An unknown id is not an error: the endpoint is authoritative and a model may
 * ship between releases, so an unrecognized id is described by the family its
 * name implies — `imagen-*` by prefix, everything else as a Gemini image model.
 * @param {string} id - the model id to resolve.
 * @returns {object} the catalog entry, or a synthesized one for an unknown id.
 */
export function imageModelFor(id) {
	const known = IMAGE_MODELS.find((model) => model.id === id);
	if (known !== undefined) return known;
	return {
		id,
		name: id,
		family: /^imagen/i.test(id) ? 'imagen' : 'gemini',
		description: '未收录的生图模型，按名称推断所属族别。',
		aspectRatios: IMAGE_ASPECT_RATIOS,
		maxCount: MAX_IMAGE_COUNT,
	};
}
