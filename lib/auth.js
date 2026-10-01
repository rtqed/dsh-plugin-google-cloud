/**
 * Vertex AI Service Account authentication and OAuth2 token management.
 *
 * Implements the standard Google Cloud OAuth2 service account JWT bearer flow:
 * - Validates service account JSON structure
 * - Generates RS256-signed JWT assertions using Node.js native `node:crypto`
 * - Exchanges assertions for short-lived access tokens at `https://oauth2.googleapis.com/token`
 * - Caches access tokens in memory until near-expiry
 *
 * @module dsh-plugin-google-cloud/auth
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { LlmError } from '@deepseek-ai/dsh-llm';

/** OAuth2 scope for Google Cloud Platform operations including Vertex AI. */
export const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

/** Standard Google OAuth2 token endpoint. */
export const GOOGLE_OAUTH2_TOKEN_URL = 'https://oauth2.googleapis.com/token';

/** In-memory cache for access tokens: Map<cacheKey, { token: string, expiresAt: number }> */
const tokenCache = new Map();

/**
 * Validate and parse Service Account credentials from raw JSON or a file path.
 * @param {string} raw - raw JSON string or path to a JSON file.
 * @returns {{
 *   type: string,
 *   project_id: string,
 *   private_key: string,
 *   client_email: string,
 *   client_id?: string,
 *   private_key_id?: string
 * }} parsed service account object.
 * @throws {LlmError} code `MISSING_CREDENTIAL` or `INVALID_REQUEST` on invalid input.
 */
export function parseServiceAccount(raw) {
	if (typeof raw !== 'string' || raw.trim().length === 0) {
		throw new LlmError(
			'google-cloud: Service Account credentials are empty — configure Service Account JSON in settings or credentials store.',
			'MISSING_CREDENTIAL',
		);
	}

	let trimmed = raw.trim();
	let jsonStr = trimmed;

	// If input appears to be a local file path rather than raw JSON
	if (!trimmed.startsWith('{') && (trimmed.endsWith('.json') || trimmed.includes('/') || trimmed.includes('\\'))) {
		if (fs.existsSync(trimmed)) {
			try {
				jsonStr = fs.readFileSync(trimmed, 'utf8');
			} catch (err) {
				throw new LlmError(
					`google-cloud: failed to read Service Account key file at "${trimmed}": ${err.message}`,
					'INVALID_REQUEST',
				);
			}
		} else {
			throw new LlmError(
				`google-cloud: Service Account key file not found at path "${trimmed}".`,
				'INVALID_REQUEST',
			);
		}
	}

	let parsed;
	try {
		parsed = JSON.parse(jsonStr);
	} catch (err) {
		throw new LlmError(
			`google-cloud: invalid Service Account JSON format: ${err.message}`,
			'INVALID_REQUEST',
		);
	}

	if (typeof parsed !== 'object' || parsed === null) {
		throw new LlmError(
			'google-cloud: Service Account JSON must be an object.',
			'INVALID_REQUEST',
		);
	}

	if (parsed.type !== 'service_account') {
		throw new LlmError(
			`google-cloud: invalid Service Account credential type. Expected "service_account", received "${parsed.type}".`,
			'INVALID_REQUEST',
		);
	}

	const requiredFields = ['project_id', 'private_key', 'client_email'];
	const missing = requiredFields.filter((f) => !parsed[f] || typeof parsed[f] !== 'string');
	if (missing.length > 0) {
		throw new LlmError(
			`google-cloud: Service Account JSON is missing required fields: ${missing.join(', ')}`,
			'INVALID_REQUEST',
		);
	}

	return parsed;
}

/**
 * Generate a signed JWT assertion using RS256 and exchange it for a Google OAuth2 access token.
 * Caches tokens until 5 minutes before expiry.
 * @param {object} sa - parsed Service Account object.
 * @param {typeof fetch} [fetchFn] - fetch function to use (defaults to globalThis.fetch).
 * @returns {Promise<string>} a valid Google Cloud OAuth2 access token.
 * @throws {LlmError} code `AUTH` or `TRANSPORT` on token retrieval errors.
 */
export async function getServiceAccountAccessToken(sa, fetchFn = globalThis.fetch) {
	const cacheKey = `${sa.client_email}:${sa.project_id}`;
	const cached = tokenCache.get(cacheKey);

	// Reuse token if still valid for more than 5 minutes (300,000 ms)
	if (cached && Date.now() < cached.expiresAt - 300000) {
		return cached.token;
	}

	const now = Math.floor(Date.now() / 1000);
	const header = {
		alg: 'RS256',
		typ: 'JWT',
		...(sa.private_key_id ? { kid: sa.private_key_id } : {}),
	};

	const payload = {
		iss: sa.client_email,
		sub: sa.client_email,
		aud: GOOGLE_OAUTH2_TOKEN_URL,
		scope: CLOUD_PLATFORM_SCOPE,
		iat: now,
		exp: now + 3600,
	};

	const b64Header = Buffer.from(JSON.stringify(header)).toString('base64url');
	const b64Payload = Buffer.from(JSON.stringify(payload)).toString('base64url');
	const unsignedAssertion = `${b64Header}.${b64Payload}`;

	let signature;
	try {
		const signer = crypto.createSign('RSA-SHA256');
		signer.update(unsignedAssertion);
		signature = signer.sign(sa.private_key, 'base64url');
	} catch (err) {
		throw new LlmError(
			`google-cloud: failed to sign JWT assertion with Service Account private key: ${err.message}`,
			'AUTH',
		);
	}

	const assertion = `${unsignedAssertion}.${signature}`;
	const body = new URLSearchParams({
		grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
		assertion,
	});

	let response;
	try {
		response = await fetchFn(GOOGLE_OAUTH2_TOKEN_URL, {
			method: 'POST',
			headers: {
				'content-type': 'application/x-www-form-urlencoded',
				'accept': 'application/json',
			},
			body: body.toString(),
		});
	} catch (err) {
		throw new LlmError(
			`google-cloud: network error contacting Google OAuth2 token endpoint: ${err.message}`,
			'TRANSPORT',
		);
	}

	if (!response.ok) {
		const detail = await response.text().catch(() => '');
		let errMsg = detail;
		try {
			const json = JSON.parse(detail);
			errMsg = json.error_description || json.error || detail;
		} catch {
			// use raw detail
		}
		throw new LlmError(
			`google-cloud: Google OAuth2 token exchange failed (${response.status}): ${errMsg}`,
			'AUTH',
		);
	}

	let data;
	try {
		data = await response.json();
	} catch (err) {
		throw new LlmError(
			`google-cloud: failed to parse Google OAuth2 token response: ${err.message}`,
			'AUTH',
		);
	}

	if (!data || typeof data.access_token !== 'string' || data.access_token.length === 0) {
		throw new LlmError(
			'google-cloud: Google OAuth2 response is missing "access_token".',
			'AUTH',
		);
	}

	const expiresIn = typeof data.expires_in === 'number' && Number.isFinite(data.expires_in)
		? data.expires_in
		: 3600;

	tokenCache.set(cacheKey, {
		token: data.access_token,
		expiresAt: Date.now() + expiresIn * 1000,
	});

	return data.access_token;
}

/** Clear all cached tokens (useful in tests or when switching accounts). */
export function clearTokenCache() {
	tokenCache.clear();
}
