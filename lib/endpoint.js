/**
 * Vertex AI endpoint derivation from the plugin configuration.
 *
 * Semantics (express API-key mode):
 * - `region: global` — the global endpoint `https://aiplatform.googleapis.com/v1`,
 *   no project in the URL; this is the default express path. The
 *   region/project fields are ignored entirely.
 * - any other region — Google's regional express pattern: the project rides in
 *   the URL path (`/v1/projects/{id}/locations/{region}`) while the key still
 *   travels as `?key=`. `us`/`eu` are multi-region hosts
 *   (`aiplatform.{region}.rep.googleapis.com`); every other value is a
 *   concrete region host.
 * - a non-empty explicit `endpoint` always wins (reverse proxies), so region
 *   and projectId are not required in that case.
 *
 * @module dsh-plugin-google-cloud/endpoint
 */
import { LlmError } from '@deepseek-ai/dsh-llm';

/** The Vertex AI global endpoint root. */
export const GLOBAL_ENDPOINT = 'https://aiplatform.googleapis.com/v1';

/**
 * Derive the request root for one configuration snapshot.
 * @param {object} config - the live `google-cloud` configuration values.
 * @param {string | undefined} config.endpoint - explicit endpoint override (may be empty).
 * @param {string | undefined} config.region - 'global' (default) or a Vertex region / multi-region id.
 * @param {string | undefined} config.projectId - Google Cloud project id, required for non-global regions.
 * @returns {string} the endpoint root a model path appends to, without a trailing slash.
 * @throws {LlmError} code `INVALID_REQUEST` when a non-global region names no projectId.
 */
export function endpointFor(config) {
	const explicit = typeof config.endpoint === 'string' ? config.endpoint.trim() : '';
	if (explicit.length > 0) return explicit.replace(/\/+$/, '');

	const region = (typeof config.region === 'string' && config.region.trim().length > 0 ? config.region : 'global').trim().toLowerCase();
	const authMode = config.authMode ?? 'express';
	const projectId = typeof config.projectId === 'string' ? config.projectId.trim() : '';

	// Express mode with region 'global' uses the root endpoint directly without project id in the path.
	if (authMode === 'express' && region === 'global') return GLOBAL_ENDPOINT;

	// Full mode (Service Account) or regional express mode requires a project id.
	if (projectId.length === 0) {
		throw new LlmError(
			`google-cloud: ${authMode === 'full' ? 'Full mode (Service Account)' : `region "${region}"`} requires a project id — set projectId in the google-cloud settings or provide a Service Account JSON containing project_id`,
			'INVALID_REQUEST',
		);
	}
	const host = region === 'global'
		? 'https://aiplatform.googleapis.com'
		: region === 'us' || region === 'eu'
			? `https://aiplatform.${region}.rep.googleapis.com`
			: `https://${region}-aiplatform.googleapis.com`;
	return `${host}/v1/projects/${encodeURIComponent(projectId)}/locations/${encodeURIComponent(region)}`;
}
