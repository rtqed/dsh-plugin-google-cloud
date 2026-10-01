/**
 * Shared Vertex AI request plumbing.
 *
 * The chat adapter and the image-generation tool speak to the same endpoint with
 * the same credential, the same attribution headers, and the same PayGo serving
 * tier headers; only the model path suffix, the body, and the response shape
 * differ. This module owns that single implementation so the two callers can
 * never drift: the header set, the JSON POST with its transport mapping, the
 * HTTP-status taxonomy, and the response-body error parsing.
 *
 * @module dsh-plugin-google-cloud/vertex-request
 */
import { LlmError, attributionHeaders } from '@deepseek-ai/dsh-llm';

/**
 * Build the header set for one Vertex AI request.
 * @param {object} connection - the resolved connection snapshot.
 * @param {object | undefined} auth - the resolved authentication snapshot.
 * @param {string} accept - the expected response shape: 'text/event-stream' while streaming, 'application/json' for a whole-body call.
 * @returns {Record<string, string>} the headers to send.
 */
export function buildVertexHeaders(connection, auth, accept) {
	const headers = {
		'content-type': 'application/json',
		accept,
		...attributionHeaders(),
	};
	if (auth?.mode === 'full' && auth.accessToken) {
		headers.authorization = `Bearer ${auth.accessToken}`;
	}
	// PayGo serving tiers ride headers, not body fields: the shared-request type
	// selects flex/priority, and the explicit shared request type opts out of
	// Provisioned-Throughput-first spillover (pure PayGo semantics).
	const tier = connection.tier ?? 'standard';
	if (tier !== 'standard') {
		headers['x-vertex-ai-llm-request-type'] = 'shared';
		headers['x-vertex-ai-llm-shared-request-type'] = tier;
	}
	return headers;
}

/**
 * POST one JSON body to a Vertex AI endpoint with the shared headers and the
 * shared transport mapping.
 * @param {object} request - the call facts.
 * @param {string} request.url - the complete request URL.
 * @param {object} request.body - the JSON body.
 * @param {AbortSignal | undefined} request.signal - caller cancellation.
 * @param {object} request.connection - the resolved connection snapshot.
 * @param {object | undefined} request.auth - the resolved authentication snapshot.
 * @param {string} request.accept - the expected response shape.
 * @param {typeof fetch} request.fetch - the fetch implementation to use.
 * @returns {Promise<Response>} the raw response.
 * @throws {LlmError} code ABORTED or TRANSPORT when the request never produced a response.
 */
export async function postVertexJson({ url, body, signal, connection, auth, accept, fetch }) {
	try {
		return await fetch(url, {
			method: 'POST',
			headers: buildVertexHeaders(connection, auth, accept),
			body: JSON.stringify(body),
			...(signal !== undefined ? { signal } : {}),
		});
	} catch (error) {
		if (signal?.aborted) throw new LlmError('Vertex AI request aborted by caller', 'ABORTED', { cause: error });
		throw new LlmError(`Vertex AI request to ${url} failed`, 'TRANSPORT', { cause: error });
	}
}

/**
 * Reject one unsuccessful Vertex AI response with the shared failure taxonomy.
 * @param {Response} response - the raw response.
 * @param {object} facts - the diagnostic facts.
 * @param {string} facts.endpoint - the endpoint the request went to, named in the fallback message.
 * @param {object} [facts.connection] - the resolved connection snapshot, read for its tier.
 * @returns {Promise<void>} resolves only when the response succeeded.
 * @throws {LlmError} the mapped provider failure.
 */
export async function assertVertexOk(response, { endpoint, connection }) {
	if (response.ok) return;
	const detail = await response.text().catch(() => '');
	const parsed = parseErrorBody(detail);
	const message = parsed?.message ?? `Vertex AI request to ${endpoint} failed with status ${response.status}`;
	const retryAfter = retryAfterMs(response.headers?.get?.('retry-after'));
	throw new LlmError(tierHint(message, connection), httpErrorCode(response.status, message), {
		status: response.status,
		...(retryAfter !== undefined ? { providerRetryAfterMs: retryAfter } : {}),
	});
}

/**
 * Read one whole-body JSON response, mapping an unsuccessful status first.
 * @param {Response} response - the raw response.
 * @param {object} facts - the diagnostic facts; see assertVertexOk.
 * @returns {Promise<object>} the parsed body.
 * @throws {LlmError} the mapped provider failure, or EMPTY_RESPONSE / MALFORMED_RESPONSE.
 */
export async function readVertexJson(response, facts) {
	await assertVertexOk(response, facts);
	const text = await response.text().catch(() => '');
	if (text.length === 0) throw new LlmError('Vertex AI returned an empty response body.', 'EMPTY_RESPONSE');
	try {
		return JSON.parse(text);
	} catch (error) {
		throw new LlmError('Vertex AI returned a malformed JSON response body.', 'MALFORMED_RESPONSE', { cause: error });
	}
}

/**
 * Enforce the documented endpoint constraints of the PayGo serving tiers:
 * Flex PayGo serves from the global endpoint only, and Priority PayGo from the
 * global and us/eu multi-region endpoints — neither supports concrete regional
 * endpoints. Standard has no constraints.
 * @param {string} tier - the configured serving tier.
 * @param {string | undefined} region - the configured region.
 * @throws {LlmError} code INVALID_REQUEST naming the setting to change.
 */
export function assertTierEndpointSupport(tier, region) {
	if (tier === 'standard') return;
	const normalized = (typeof region === 'string' && region.trim().length > 0 ? region : 'global').trim().toLowerCase();
	if (tier === 'flex' && normalized !== 'global') {
		throw new LlmError(
			`google-cloud: Flex PayGo only supports the global endpoint — set region "global" (or clear tier) for region "${normalized}"`,
			'INVALID_REQUEST',
		);
	}
	if (tier === 'priority' && normalized !== 'global' && normalized !== 'us' && normalized !== 'eu') {
		throw new LlmError(
			`google-cloud: Priority PayGo supports only the global and us/eu multi-region endpoints, not the regional endpoint "${normalized}" — set region "global", "us", or "eu"`,
			'INVALID_REQUEST',
		);
	}
}

/**
 * Map an HTTP status onto the shared harness failure taxonomy.
 * @param {number} status - HTTP status from Vertex AI.
 * @param {string} detail - provider error message text.
 * @returns {string} a stable failure code.
 */
export function httpErrorCode(status, detail) {
	if (status === 401 || status === 403) return 'AUTH';
	if (status === 413) return 'INVALID_REQUEST';
	if (status === 429) return 'RATE_LIMIT';
	if (status === 400) {
		if (/token limit|context length|exceeds the maximum/i.test(detail)) return 'CONTEXT_WINDOW_EXCEEDED';
		return 'INVALID_REQUEST';
	}
	if (status === 404) return 'MODEL_NOT_FOUND';
	if (status >= 500) return 'SERVER';
	return `HTTP_${status}`;
}

/**
 * Read one positive delay from a Retry-After header.
 * @param {string | null} value - the raw header value.
 * @returns {number | undefined} the delay in milliseconds, when valid.
 */
export function retryAfterMs(value) {
	if (value === null || value === undefined || value.length === 0) return undefined;
	const seconds = Number(value);
	if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
	const date = Date.parse(value);
	if (Number.isFinite(date)) return Math.max(date - Date.now(), 0);
	return undefined;
}

/**
 * Parse one Vertex AI error body.
 * @param {string} text - the raw error body.
 * @returns {{ message?: string } | undefined} the provider message, when the body carries one.
 */
export function parseErrorBody(text) {
	if (text.length === 0) return undefined;
	try {
		const value = JSON.parse(text);
		const message = value?.error?.message ?? value?.message;
		return typeof message === 'string' && message.length > 0 ? { message } : undefined;
	} catch {
		return { message: text.slice(0, 200) };
	}
}

/**
 * Name the configured PayGo tier when a refusal is the tier's own doing. The
 * provider rejects a tier far more cryptically than that: Flex and Priority are
 * served by a subset of models, projects, and endpoints, and the raw message
 * never names the setting that selected them.
 * @param {string} message - the provider message.
 * @param {object} [connection] - the resolved connection snapshot.
 * @returns {string} the message, with an actionable suffix when the tier caused it.
 */
function tierHint(message, connection) {
	const tier = connection?.tier ?? 'standard';
	if (tier === 'standard' || !/\b(flex|priority)\b/i.test(message)) return message;
	return `${message} — the google-cloud settings select the ${tier} PayGo tier for this request; set tier to "standard" when the chosen model or endpoint does not serve ${tier}`;
}
