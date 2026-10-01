/**
 * Static Vertex AI Gemini model catalog and reasoning-effort wire mapping.
 *
 * Model ids, context windows, and output caps follow the Google Vertex AI
 * `publishers/google/models` Gemini family that the pinned runtime's pi-ai
 * catalog (0.85.1) ships for `google-vertex`, so ids the model picker already
 * knows keep working here. The catalog is advisory: the adapter accepts any
 * model id the endpoint recognizes.
 *
 * @module dsh-plugin-google-cloud/catalog
 */

/** Context capacity assumed for a model neither the catalog nor configuration sizes. */
export const DEFAULT_CONTEXT_WINDOW = 262144;

/**
 * One catalog entry. `family` selects the reasoning wire mapping in
 * {@link thinkingConfigFor}; absent means the model exposes no reasoning
 * control and requests send no `thinkingConfig`.
 */
const MODELS = [
	{ id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', contextWindow: 1048576, maxTokens: 65536, family: 'gemini3-flash' },
	{ id: 'gemini-3.7-flash', name: 'Gemini 3.7 Flash', contextWindow: 1048576, maxTokens: 65536, family: 'gemini3-flash' },
	{ id: 'gemini-3.6-flash', name: 'Gemini 3.6 Flash', contextWindow: 1048576, maxTokens: 65536, family: 'gemini3-flash' },
	{ id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash', contextWindow: 1048576, maxTokens: 65536, family: 'gemini3-flash' },
	{ id: 'gemini-3.5-flash-lite', name: 'Gemini 3.5 Flash Lite', contextWindow: 1048576, maxTokens: 65536, family: 'gemini3-flash' },
	{ id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro Preview', contextWindow: 1048576, maxTokens: 65536, family: 'gemini3-pro' },
	{ id: 'gemini-3.1-pro-preview-customtools', name: 'Gemini 3.1 Pro Preview (Custom Tools)', contextWindow: 1048576, maxTokens: 65536, family: 'gemini3-pro' },
	{ id: 'gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash Lite', contextWindow: 1048576, maxTokens: 65536, family: 'gemini3-flash' },
	{ id: 'gemini-3-flash-preview', name: 'Gemini 3 Flash Preview', contextWindow: 1048576, maxTokens: 65536, family: 'gemini3-flash' },
	{ id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', contextWindow: 1048576, maxTokens: 65536, family: 'gemini25-pro' },
	{ id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', contextWindow: 1048576, maxTokens: 65536, family: 'gemini25-flash' },
	{ id: 'gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash Lite', contextWindow: 1048576, maxTokens: 65536, family: 'gemini25-flash' },
	{ id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash', contextWindow: 1048576, maxTokens: 8192, family: 'gemini25-flash' },
	{ id: 'gemini-2.0-flash-lite', name: 'Gemini 2.0 Flash Lite', contextWindow: 1048576, maxTokens: 8192, family: 'gemini25-flash' },
	{ id: 'gemini-1.5-pro', name: 'Gemini 1.5 Pro', contextWindow: 2097152, maxTokens: 8192 },
	{ id: 'gemini-1.5-flash', name: 'Gemini 1.5 Flash', contextWindow: 1048576, maxTokens: 8192 },
	{ id: 'gemini-1.5-flash-8b', name: 'Gemini 1.5 Flash 8B', contextWindow: 1048576, maxTokens: 8192 },
	{ id: 'gemini-flash-latest', name: 'Gemini Flash Latest', contextWindow: 1048576, maxTokens: 65536, family: 'gemini3-flash' },
	{ id: 'gemini-flash-lite-latest', name: 'Gemini Flash Lite Latest', contextWindow: 1048576, maxTokens: 65536, family: 'gemini3-flash' },
];

/** Selectable reasoning efforts, in escalation order. */
export const REASONING_EFFORTS = Object.freeze([
	{ id: 'minimal', name: 'Minimal' },
	{ id: 'low', name: 'Low' },
	{ id: 'medium', name: 'Medium' },
	{ id: 'high', name: 'High' },
]);

/**
 * Built-in static region-to-Gemini-models availability map.
 * Pre-extracted from Google Cloud official documentation.
 */
export const DEFAULT_REGION_MODELS = Object.freeze({
	global: [
		'gemini-3.8-flash',
		'gemini-3.7-flash',
		'gemini-3.6-flash',
		'gemini-3.5-flash',
		'gemini-3.5-flash-lite',
		'gemini-3.1-pro-preview',
		'gemini-3.1-flash-lite',
		'gemini-3-flash-preview',
		'gemini-2.5-pro',
		'gemini-2.5-flash',
		'gemini-2.5-flash-lite',
		'gemini-2.0-flash',
		'gemini-2.0-flash-lite',
		'gemini-1.5-pro',
		'gemini-1.5-flash',
		'gemini-1.5-flash-8b',
		'gemini-flash-latest',
		'gemini-flash-lite-latest',
	],
	us: [
		'gemini-3.8-flash',
		'gemini-3.7-flash',
		'gemini-3.6-flash',
		'gemini-3.5-flash',
		'gemini-3.5-flash-lite',
		'gemini-3.1-flash-lite',
		'gemini-2.5-pro',
		'gemini-2.5-flash',
		'gemini-1.5-pro',
		'gemini-1.5-flash',
	],
	eu: [
		'gemini-3.8-flash',
		'gemini-3.7-flash',
		'gemini-3.6-flash',
		'gemini-3.5-flash',
		'gemini-3.5-flash-lite',
		'gemini-3.1-flash-lite',
		'gemini-2.5-pro',
		'gemini-2.5-flash',
		'gemini-1.5-pro',
		'gemini-1.5-flash',
	],
	'us-central1': [
		'gemini-3.8-flash',
		'gemini-3.7-flash',
		'gemini-3.6-flash',
		'gemini-3.5-flash',
		'gemini-3.5-flash-lite',
		'gemini-3.1-pro-preview',
		'gemini-3.1-flash-lite',
		'gemini-3-flash-preview',
		'gemini-2.5-pro',
		'gemini-2.5-flash',
		'gemini-2.5-flash-lite',
		'gemini-2.0-flash',
		'gemini-2.0-flash-lite',
		'gemini-1.5-pro',
		'gemini-1.5-flash',
		'gemini-1.5-flash-8b',
	],
	'us-east4': [
		'gemini-3.8-flash',
		'gemini-3.7-flash',
		'gemini-3.6-flash',
		'gemini-3.5-flash',
		'gemini-3.5-flash-lite',
		'gemini-2.5-pro',
		'gemini-2.5-flash',
		'gemini-2.5-flash-lite',
		'gemini-2.0-flash',
		'gemini-1.5-pro',
		'gemini-1.5-flash',
	],
	'us-west1': [
		'gemini-3.8-flash',
		'gemini-3.7-flash',
		'gemini-3.6-flash',
		'gemini-3.5-flash',
		'gemini-2.5-pro',
		'gemini-2.5-flash',
		'gemini-2.5-flash-lite',
		'gemini-1.5-pro',
		'gemini-1.5-flash',
	],
	'us-west4': [
		'gemini-2.5-pro',
		'gemini-2.5-flash',
		'gemini-2.5-flash-lite',
		'gemini-1.5-pro',
		'gemini-1.5-flash',
	],
	'us-east1': [
		'gemini-2.5-pro',
		'gemini-2.5-flash',
		'gemini-2.5-flash-lite',
		'gemini-1.5-pro',
		'gemini-1.5-flash',
	],
	'us-east5': [
		'gemini-2.5-pro',
		'gemini-2.5-flash',
		'gemini-2.5-flash-lite',
		'gemini-1.5-pro',
		'gemini-1.5-flash',
	],
	'us-south1': [
		'gemini-2.5-pro',
		'gemini-2.5-flash',
		'gemini-2.5-flash-lite',
		'gemini-1.5-pro',
		'gemini-1.5-flash',
	],
	'northamerica-northeast1': [
		'gemini-3.5-flash',
		'gemini-2.5-pro',
		'gemini-2.5-flash',
		'gemini-1.5-pro',
		'gemini-1.5-flash',
	],
	'southamerica-east1': [
		'gemini-2.5-flash',
		'gemini-1.5-flash',
	],
	'europe-west1': [
		'gemini-3.8-flash',
		'gemini-3.7-flash',
		'gemini-3.6-flash',
		'gemini-3.5-flash',
		'gemini-2.5-pro',
		'gemini-2.5-flash',
		'gemini-2.5-flash-lite',
		'gemini-1.5-pro',
		'gemini-1.5-flash',
	],
	'europe-west4': [
		'gemini-3.8-flash',
		'gemini-3.7-flash',
		'gemini-3.6-flash',
		'gemini-3.5-flash',
		'gemini-3.5-flash-lite',
		'gemini-2.5-pro',
		'gemini-2.5-flash',
		'gemini-2.5-flash-lite',
		'gemini-2.0-flash',
		'gemini-1.5-pro',
		'gemini-1.5-flash',
	],
	'europe-west9': [
		'gemini-2.5-pro',
		'gemini-2.5-flash',
		'gemini-2.5-flash-lite',
		'gemini-1.5-pro',
		'gemini-1.5-flash',
	],
	'europe-west2': [
		'gemini-3.5-flash',
		'gemini-2.5-flash',
		'gemini-1.5-pro',
		'gemini-1.5-flash',
	],
	'europe-west3': [
		'gemini-3.5-flash',
		'gemini-2.5-flash',
		'gemini-1.5-pro',
		'gemini-1.5-flash',
	],
	'europe-north1': [
		'gemini-2.5-pro',
		'gemini-2.5-flash',
		'gemini-2.5-flash-lite',
		'gemini-1.5-pro',
		'gemini-1.5-flash',
	],
	'europe-central2': [
		'gemini-2.5-pro',
		'gemini-2.5-flash',
		'gemini-2.5-flash-lite',
		'gemini-1.5-pro',
		'gemini-1.5-flash',
	],
	'europe-west8': [
		'gemini-2.5-pro',
		'gemini-2.5-flash',
		'gemini-2.5-flash-lite',
		'gemini-1.5-pro',
		'gemini-1.5-flash',
	],
	'europe-southwest1': [
		'gemini-2.5-pro',
		'gemini-2.5-flash',
		'gemini-2.5-flash-lite',
		'gemini-1.5-pro',
		'gemini-1.5-flash',
	],
	'asia-northeast1': [
		'gemini-3.8-flash',
		'gemini-3.7-flash',
		'gemini-3.6-flash',
		'gemini-3.5-flash',
		'gemini-3.5-flash-lite',
		'gemini-2.5-pro',
		'gemini-2.5-flash',
		'gemini-2.5-flash-lite',
		'gemini-2.0-flash',
		'gemini-1.5-pro',
		'gemini-1.5-flash',
	],
	'asia-southeast1': [
		'gemini-3.8-flash',
		'gemini-3.7-flash',
		'gemini-3.6-flash',
		'gemini-3.5-flash',
		'gemini-2.5-pro',
		'gemini-2.5-flash',
		'gemini-1.5-pro',
		'gemini-1.5-flash',
	],
	'asia-east1': [
		'gemini-3.8-flash',
		'gemini-3.7-flash',
		'gemini-3.6-flash',
		'gemini-3.5-flash',
		'gemini-2.5-pro',
		'gemini-2.5-flash',
		'gemini-1.5-pro',
		'gemini-1.5-flash',
	],
	'asia-south1': [
		'gemini-3.5-flash',
		'gemini-2.5-pro',
		'gemini-2.5-flash',
		'gemini-1.5-pro',
		'gemini-1.5-flash',
	],
	'asia-northeast3': [
		'gemini-2.5-flash',
		'gemini-1.5-flash',
	],
	'australia-southeast1': [
		'gemini-3.5-flash',
		'gemini-2.5-pro',
		'gemini-2.5-flash',
		'gemini-1.5-pro',
		'gemini-1.5-flash',
	],
});

/**
 * The plain catalog served to model pickers, discovery, and diagnostics.
 * Entry fields are detached copies; callers may not mutate the catalog.
 */
export const CATALOG = Object.freeze(MODELS.map(({ id, name, contextWindow, maxTokens }) => Object.freeze({ id, name, contextWindow, maxTokens })));

/**
 * Format a readable display name from a Gemini model id.
 * @param {string} id - model id.
 * @returns {string} formatted name.
 */
export function formatGeminiName(id) {
	return id
		.replace(/^gemini-/, 'Gemini ')
		.split('-')
		.map((part) => (part.length > 0 ? part[0].toUpperCase() + part.slice(1) : ''))
		.join(' ');
}

/**
 * Return model entries available for a specific region, merged with any user custom models.
 * @param {string} [region='global'] - target region id.
 * @param {string[]} [customModels=[]] - optional array of custom model IDs.
 * @returns {readonly object[]} filtered and merged catalog entries.
 */
export function listModelsForRegion(region = 'global', customModels = []) {
	const targetRegion = (region || 'global').trim().toLowerCase();
	const allowedIds = DEFAULT_REGION_MODELS[targetRegion] || DEFAULT_REGION_MODELS['global'] || [];

	const allowedSet = new Set(allowedIds.map((id) => id.toLowerCase()));
	const filtered = CATALOG.filter((entry) => allowedSet.has(entry.id.toLowerCase()));

	const existingSet = new Set(filtered.map((c) => c.id.toLowerCase()));
	const extraEntries = [];

	if (Array.isArray(customModels)) {
		for (const raw of customModels) {
			if (typeof raw !== 'string') continue;
			const id = raw.trim();
			if (!id) continue;
			const lowerId = id.toLowerCase();
			if (!existingSet.has(lowerId)) {
				existingSet.add(lowerId);
				extraEntries.push(Object.freeze({
					id,
					name: formatGeminiName(id),
					contextWindow: 1048576,
					maxTokens: 65536,
				}));
			}
		}
	}

	return Object.freeze([...filtered, ...extraEntries]);
}

/**
 * Look up one catalog entry.
 * @param {string} model - exact model id.
 * @returns {object | undefined} the catalog entry, or undefined for an unlisted id.
 */
export function catalogModel(model) {
	return MODELS.find((entry) => entry.id === model);
}

/**
 * Derive the reasoning-wire family for any model id, listed or not.
 * @param {string} model - exact model id.
 * @returns {string | undefined} 'gemini3-pro' | 'gemini3-flash' | 'gemini25-pro' | 'gemini25-flash'.
 */
export function reasoningFamilyOf(model) {
	const lower = model.toLowerCase();
	if (/^gemini(?:-live)?-3(\.\d+)?-pro/.test(lower)) return 'gemini3-pro';
	if (/^gemini(?:-live)?-3(\.\d+)?-flash/.test(lower)) return 'gemini3-flash';
	if (lower === 'gemini-flash-latest' || lower === 'gemini-flash-lite-latest') return 'gemini3-flash';
	if (lower.includes('2.5-pro')) return 'gemini25-pro';
	if (lower.includes('2.5-flash')) return 'gemini25-flash';
	return undefined;
}

/**
 * Gemini major version of a model id, when the id states one.
 * Gemini 3+ function calling carries tool-call ids and accepts full JSON Schema
 * parameters (`parametersJsonSchema`); older models take the OpenAPI subset.
 * @param {string} model - exact model id.
 * @returns {number | undefined} the major version, or undefined when not a versioned Gemini id.
 */
export function geminiMajorVersion(model) {
	const match = model.toLowerCase().match(/^gemini(?:-live)?-(\d+)/);
	if (match === null) return undefined;
	return Number.parseInt(match[1], 10);
}

/**
 * Whether function calls and responses must carry explicit tool-call ids.
 * Mirrors pi-ai's `requiresToolCallId`: Claude/GPT-OSS on Vertex and Gemini 3+ do.
 * @param {string} model - exact model id.
 * @returns {boolean}
 */
export function requiresToolCallId(model) {
	const lower = model.toLowerCase();
	return lower.startsWith('claude-') || lower.startsWith('gpt-oss-') || (geminiMajorVersion(model) ?? 0) >= 3;
}

/**
 * Whether the model accepts multimodal `functionResponse.parts` (Gemini 3+).
 * @param {string} model - exact model id.
 * @returns {boolean}
 */
export function supportsMultimodalFunctionResponse(model) {
	const major = geminiMajorVersion(model);
	return major === undefined ? true : major >= 3;
}

/**
 * Build the `generationConfig.thinkingConfig` value for one effort selection.
 * The mapping follows pi-ai's Gemini dispatch: Gemini 3 Pro floors `minimal`
 * to `LOW`; Flash families accept `MINIMAL`; Gemini 2.5 takes token budgets.
 * @param {string} model - exact model id.
 * @param {string} effort - one {@link REASONING_EFFORTS} id.
 * @returns {object | undefined} the thinkingConfig value, or undefined when the model has no reasoning control.
 */
export function thinkingConfigFor(model, effort) {
	const family = reasoningFamilyOf(model);
	if (family === undefined) return undefined;
	const config = { includeThoughts: true };
	switch (family) {
		case 'gemini3-pro':
			config.thinkingLevel = effort === 'medium' ? 'MEDIUM' : effort === 'high' ? 'HIGH' : 'LOW';
			return config;
		case 'gemini3-flash':
			config.thinkingLevel = effort === 'minimal' ? 'MINIMAL' : effort === 'low' ? 'LOW' : effort === 'medium' ? 'MEDIUM' : 'HIGH';
			return config;
		case 'gemini25-pro':
			config.thinkingBudget = { minimal: 128, low: 2048, medium: 8192, high: 32768 }[effort];
			return config;
		case 'gemini25-flash':
			config.thinkingBudget = { minimal: 128, low: 2048, medium: 8192, high: 24576 }[effort];
			return config;
		default:
			return undefined;
	}
}
