// adapter.js + index.js integration tests against the real dsh-llm classes,
// with a mocked fetch. Verifies the Vertex AI express wire format end to end:
// global endpoint, ?key= auth, attribution headers, SSE parsing, chunk output.
import assert from 'node:assert/strict';
import { LlmError } from '@deepseek-ai/dsh-llm';
import { VertexExpressAdapter } from '../lib/adapter.js';
import { CATALOG } from '../lib/catalog.js';
import { Config, ROUTE } from '../lib/index.js';

const SSE_HEADERS = { 'content-type': 'text/event-stream' };

function sseResponse(frames) {
	const encoder = new TextEncoder();
	const stream = new ReadableStream({
		start(controller) {
			for (const frame of frames) controller.enqueue(encoder.encode(frame));
			controller.close();
		},
	});
	return new Response(stream, { status: 200, headers: SSE_HEADERS });
}

function makeAdapter(handlers, connection = defaultConnection(), extraDeps = {}) {
	const calls = [];
	const fetchImpl = async (url, init) => {
		calls.push({ url, init });
		for (const handler of [].concat(handlers)) {
			const response = handler({ url, init });
			if (response !== undefined) return response;
		}
		throw new Error('no mock handler matched');
	};
	const adapter = new VertexExpressAdapter({
		resolveConnection: () => connection,
		listModels: () => CATALOG,
		resolveAttachments: () => undefined,
		resolveImageAccess: () => undefined,
		resolveFileText: () => undefined,
		fetch: fetchImpl,
		...extraDeps,
	});
	return { adapter, calls };
}

function defaultConnection() {
	return {
		displayName: 'Google Vertex AI',
		endpoint: 'https://aiplatform.googleapis.com/v1',
		streamIdleTimeoutMs: 300000,
		resolveApiKey: async () => 'test-api-key',
	};
}

function requestOptions(messages, extra = {}) {
	return {
		provider: ROUTE,
		model: 'gemini-3.8-flash',
		messages,
		system: undefined,
		tools: undefined,
		temperature: undefined,
		maxTokens: undefined,
		stop: undefined,
		reasoningEffort: undefined,
		signal: undefined,
		sessionId: undefined,
		...extra,
	};
}

const userText = (text) => ({ id: 'm1', role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } });

// 1. Happy path: request hits the exact express wire format.
{
	const { adapter, calls } = makeAdapter(({ url }) => {
		if (!url.startsWith('https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-3.8-flash:streamGenerateContent')) return undefined;
		return sseResponse([
			'data: {"candidates":[{"content":{"parts":[{"text":"Hi there"}]}}]}\r\n\r\n',
			'data: {"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":3,"totalTokenCount":13}}\n\n',
			'data: {"candidates":[{"finishReason":"STOP"}]}\n\n',
		]);
	});
	const chunks = [];
	for await (const chunk of adapter.stream(requestOptions([userText('hello')]))) chunks.push(chunk);

	const call = calls[0];
	const parsedUrl = new URL(call.url);
	assert.equal(`${parsedUrl.origin}${parsedUrl.pathname}`, 'https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-3.8-flash:streamGenerateContent');
	assert.equal(parsedUrl.searchParams.get('alt'), 'sse');
	assert.equal(parsedUrl.searchParams.get('key'), 'test-api-key');
	assert.equal(call.init.headers['content-type'], 'application/json');
	assert.equal(call.init.headers.accept, 'text/event-stream');
	assert.ok(call.init.headers['user-agent'].length > 0, 'attribution user-agent required');

	const text = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('');
	assert.equal(text, 'Hi there');
	assert.equal(chunks.at(-1).reason.kind, 'stop');
	assert.deepEqual(chunks.find((c) => c.type === 'usage').usage, { inputTokens: 10, outputTokens: 3, totalTokens: 13 });

	const body = JSON.parse(call.init.body);
	assert.deepEqual(body.contents, [{ role: 'user', parts: [{ text: 'hello' }] }]);
}

// 2. HTTP failures map onto the harness taxonomy with provider detail.
{
	const { adapter } = makeAdapter(() => new Response(JSON.stringify({ error: { code: 429, message: 'Resource has been exhausted' } }), { status: 429 }));
	await assert.rejects(
		(async () => { for await (const chunk of adapter.stream(requestOptions([userText("hi")]))) void chunk; })(),
		(error) => error instanceof LlmError && error.failure.code === 'RATE_LIMIT' && error.failure.status === 429,
	);
}

{
	const { adapter } = makeAdapter(() => new Response('forbidden', { status: 403 }));
	await assert.rejects(
		(async () => { for await (const chunk of adapter.stream(requestOptions([userText('hi')]))) void chunk; })(),
		(error) => error.failure.code === 'AUTH',
	);
}

// 3. Missing credential fails loud with MISSING_CREDENTIAL before any request.
{
	const { adapter } = makeAdapter(() => { throw new Error('must not fetch'); }, { ...defaultConnection(), resolveApiKey: async () => { throw new LlmError('no key', 'MISSING_CREDENTIAL'); } });
	await assert.rejects(
		(async () => { for await (const chunk of adapter.stream(requestOptions([userText('hi')]))) void chunk; })(),
		(error) => error.failure.code === 'MISSING_CREDENTIAL',
	);
}

// 4. Caller abort surfaces as ABORTED, not TRANSPORT.
{
	const controller = new AbortController();
	const { adapter } = makeAdapter(async ({ init }) => {
		controller.abort();
		return new Response(new ReadableStream({
			async pull(controller) {
				await new Promise((resolve) => setTimeout(resolve, 20));
				if (!init.signal.aborted) controller.enqueue(new TextEncoder().encode('data: {"candidates":[{"content":{"parts":[{"text":"x"}]}}]}\n\n'));
				else controller.error(new Error('The operation was aborted'));
			},
		}), { status: 200, headers: SSE_HEADERS });
	});
	await assert.rejects(
		(async () => { for await (const chunk of adapter.stream(requestOptions([userText('hi')], { signal: controller.signal }))) void chunk; })(),
		(error) => error.failure.code === 'ABORTED',
	);
}

// 5. Metadata contract: providerInfo, listModels, resolveModel.
{
	const { adapter } = makeAdapter(() => undefined);
	assert.deepEqual(adapter.providerInfo(ROUTE), { id: ROUTE, name: 'Google Vertex AI' });
	const models = await adapter.listModels(ROUTE);
	assert.ok(models.length >= 10);
	assert.ok(models.every((m) => m.provider === ROUTE && typeof m.id === 'string'));
	const resolved = await adapter.resolveModel(ROUTE, 'gemini-2.5-pro');
	assert.equal(resolved.context.contextWindow, 1048576);
	assert.equal(resolved.reasoning.efforts.length, 4);
	const unlisted = await adapter.resolveModel(ROUTE, 'gemini-future-model');
	assert.equal(unlisted.context.contextWindow, 262144);
	assert.equal(unlisted.reasoning, undefined);
}

// 6. Plugin config schema validates as a StandardSchema and applies defaults.
// `Config` is root-volatile (the mounting entry's config block is the live
// authority), so the validated value is the shared reference object.
async function validateConfig(input) {
	const result = Config['~standard'].validate(input);
	const validated = result instanceof Promise ? await result : result;
	return validated;
}

{
	const validated = await validateConfig({});
	assert.equal(validated.issues, undefined);
	const value = validated.value.get();
	assert.equal(value.apiKeyEnv, 'GOOGLE_CLOUD_API_KEY');
	assert.equal(value.region, 'global');
	assert.equal(value.projectId, '');
	assert.equal(value.tier, 'standard');
	assert.equal(value.endpoint, '');
	assert.equal(value.authMode, 'express');
	assert.deepEqual(value.customModels, []);

	const bad = await validateConfig({ streamIdleTimeoutMs: 10 });
	assert.ok(bad.issues !== undefined);
}

// 8. Regional express: derived endpoint carries the project path, key stays in the query.
{
	const { adapter, calls } = makeAdapter(({ url }) => {
		if (!url.includes('/publishers/google/models/gemini-3.8-flash:streamGenerateContent')) return undefined;
		return sseResponse([
			'data: {"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}\n\n',
			'data: {"candidates":[{"finishReason":"STOP"}]}\n\n',
		]);
	}, {
		displayName: 'Google Vertex AI',
		endpoint: '',
		region: 'us-central1',
		projectId: 'vertex-proj',
		streamIdleTimeoutMs: 300000,
		resolveApiKey: async () => 'test-api-key',
	});
	const chunks = [];
	for await (const chunk of adapter.stream(requestOptions([userText('hello')]))) chunks.push(chunk);
	const parsedUrl = new URL(calls[0].url);
	assert.equal(
		`${parsedUrl.origin}${parsedUrl.pathname}`,
		'https://us-central1-aiplatform.googleapis.com/v1/projects/vertex-proj/locations/us-central1/publishers/google/models/gemini-3.8-flash:streamGenerateContent',
	);
	assert.equal(parsedUrl.searchParams.get('key'), 'test-api-key');
	assert.equal(chunks.at(-1).reason.kind, 'stop');
}

// 9. Regional express without a project fails loud with INVALID_REQUEST, naming the setting.
{
	const { adapter } = makeAdapter(() => { throw new Error('must not fetch'); }, {
		displayName: 'Google Vertex AI',
		endpoint: '',
		region: 'us-central1',
		projectId: '',
		streamIdleTimeoutMs: 300000,
		resolveApiKey: async () => 'test-api-key',
	});
	await assert.rejects(
		(async () => { for await (const chunk of adapter.stream(requestOptions([userText('hi')]))) void chunk; })(),
		(error) => error.failure.code === 'INVALID_REQUEST' && /projectId/.test(error.failure.message),
	);
}

// 7. Idle watchdog fires when the provider stalls mid-stream.
{
	const { adapter } = makeAdapter(() => new Response(new ReadableStream({
		start(controller) {
			controller.enqueue(new TextEncoder().encode('data: {"candidates":[{"content":{"parts":[{"text":"a"}]}}]}\n\n'));
			// No further data; the watchdog must fire.
		},
	}), { status: 200, headers: SSE_HEADERS }), { ...defaultConnection(), streamIdleTimeoutMs: 200 });
	await assert.rejects(
		(async () => { for await (const chunk of adapter.stream(requestOptions([userText("hi")]))) void chunk; })(),
		(error) => error.failure.code === 'TIMEOUT',
	);
}

// 10. PayGo tiers: flex on global sends the documented headers, trafficType surfaces.
{
	const trafficTypes = [];
	const { adapter, calls } = makeAdapter(({ url }) => {
		if (!url.startsWith('https://aiplatform.googleapis.com/v1/publishers/google/models/')) return undefined;
		return sseResponse([
			'data: {"candidates":[{"content":{"parts":[{"text":"hi"}]}}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":1,"trafficType":"ON_DEMAND_FLEX"}}\n\n',
			'data: {"candidates":[{"finishReason":"STOP"}]}\n\n',
		]);
	}, { ...defaultConnection(), tier: 'flex' }, { onTrafficType: (tt) => trafficTypes.push(tt) });
	const chunks = [];
	for await (const chunk of adapter.stream(requestOptions([userText('hi')], { provider: ROUTE, model: 'gemini-3.8-flash' }))) chunks.push(chunk);
	const headers = calls[0].init.headers;
	assert.equal(headers['x-vertex-ai-llm-request-type'], 'shared');
	assert.equal(headers['x-vertex-ai-llm-shared-request-type'], 'flex');
	assert.deepEqual(trafficTypes, ['ON_DEMAND_FLEX']);
}

// 11. Priority on the us multi-region is allowed; standard sends no tier headers.
{
	const { adapter, calls } = makeAdapter(() => sseResponse([
		'data: {"candidates":[{"content":{"parts":[{"text":"ok"}]}}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":1,"trafficType":"ON_DEMAND_PRIORITY"}}\n\n',
		'data: {"candidates":[{"finishReason":"STOP"}]}\n\n',
	]), {
		...defaultConnection(),
		endpoint: '',
		region: 'us',
		projectId: 'vertex-proj',
		tier: 'priority',
	});
	for await (const chunk of adapter.stream(requestOptions([userText('hi')]))) void chunk;
	const headers = calls[0].init.headers;
	assert.equal(headers['x-vertex-ai-llm-shared-request-type'], 'priority');
	assert.equal(headers['x-vertex-ai-llm-request-type'], 'shared');
	assert.equal(new URL(calls[0].url).host, 'aiplatform.us.rep.googleapis.com');
}

{
	const { adapter, calls } = makeAdapter(() => sseResponse([
		'data: {"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}\n\n',
		'data: {"candidates":[{"finishReason":"STOP"}]}\n\n',
	]));
	for await (const chunk of adapter.stream(requestOptions([userText('hi')]))) void chunk;
	assert.equal(calls[0].init.headers['x-vertex-ai-llm-shared-request-type'], undefined);
	assert.equal(calls[0].init.headers['x-vertex-ai-llm-request-type'], undefined);
}

// 12. Tier endpoint constraints fail loud before any request.
{
	const { adapter, calls } = makeAdapter(() => { throw new Error('must not fetch'); }, { ...defaultConnection(), region: 'us-central1', projectId: 'p', tier: 'flex' });
	await assert.rejects(
		(async () => { for await (const chunk of adapter.stream(requestOptions([userText('hi')]))) void chunk; })(),
		(error) => error.failure.code === 'INVALID_REQUEST' && /Flex PayGo/.test(error.failure.message),
	);
	assert.equal(calls.length, 0);
}
{
	const { adapter } = makeAdapter(() => { throw new Error('must not fetch'); }, { ...defaultConnection(), region: 'us-central1', projectId: 'p', tier: 'priority' });
	await assert.rejects(
		(async () => { for await (const chunk of adapter.stream(requestOptions([userText('hi')]))) void chunk; })(),
		(error) => error.failure.code === 'INVALID_REQUEST' && /Priority PayGo/.test(error.failure.message),
	);
}

// 13. Images: the current offload protocol end to end.
// One attachment, one request version; the adapter stages the version, asks the
// image-offload surface for more room when the route budget is exceeded, and
// emits the shared handle text for retained occurrences.
const IMAGE_REF = Object.freeze({
	attachmentId: 'sha256:image-1',
	bytes: 4096,
	width: 4000,
	height: 3000,
	mediaType: 'image/png',
	name: 'shot.png',
});
const imageMessage = (extra = {}) => ({
	id: 'm-img',
	role: 'user',
	content: [{ type: 'image', attachment: { ...IMAGE_REF }, ...extra }],
	source: { kind: 'user' },
});

function fakeAttachments(bytes) {
	const staged = [];
	return {
		staged,
		readImageRequest: async (ref, target, signal) => {
			signal?.throwIfAborted?.();
			staged.push({ ref, target });
			return { data: new Uint8Array([1, 2, 3]), mediaType: 'image/webp', width: target.width, height: target.height, bytes };
		},
	};
}

function accessFacts() {
	return { readonlyPath: '/tmp/dsh/normalized.png' };
}

// A. Images without the durable attachment service fail loud.
{
	const { adapter } = makeAdapter(() => { throw new Error('must not fetch'); });
	await assert.rejects(
		(async () => { for await (const chunk of adapter.stream(requestOptions([imageMessage()]))) void chunk; })(),
		(error) => error.failure.code === 'UNSUPPORTED_CONTENT',
	);
}

// B. A retained image is staged at a pixel-budget target and inlined, preceded
// by the shared request-image handle (dimensions + normalized path).
{
	const attachments = fakeAttachments(4096);
	const { adapter, calls } = makeAdapter(() => sseResponse([
		'data: {"candidates":[{"content":{"parts":[{"text":"seen"}]}}]}\n\n',
		'data: {"candidates":[{"finishReason":"STOP"}]}\n\n',
	]), defaultConnection(), {
		resolveAttachments: () => attachments,
		resolveImageAccess: (provider, ref) => {
			assert.equal(provider, attachments, 'access resolution receives the provider resolved once per call');
			return accessFacts();
		},
	});
	for await (const chunk of adapter.stream(requestOptions([imageMessage()]))) void chunk;

	assert.deepEqual(attachments.staged[0].target, { width: 2364, height: 1773, maxBytes: 1048576 });
	const parts = JSON.parse(calls[0].init.body).contents[0].parts;
	assert.match(parts[0].text, /request preview 2364x1773px/);
	assert.match(parts[0].text, /\/tmp\/dsh\/normalized\.png/);
	assert.equal(parts[1].inlineData.mimeType, 'image/webp');
	assert.equal(parts[1].inlineData.data, Buffer.from([1, 2, 3]).toString('base64'));
}

// C. A request that still exceeds the route budget reports the shortfall.
{
	const attachments = fakeAttachments(24 * 1024 * 1024);
	const { adapter, calls } = makeAdapter(() => { throw new Error('must not fetch'); }, defaultConnection(), {
		resolveAttachments: () => attachments,
		resolveImageAccess: () => accessFacts(),
	});
	await assert.rejects(
		(async () => { for await (const chunk of adapter.stream(requestOptions([imageMessage()]))) void chunk; })(),
		(error) => error.failure.code === 'IMAGE_OFFLOAD_REQUIRED' && error.failure.offloadImages === 1,
	);
	assert.equal(calls.length, 0);
}

// D. An occurrence an earlier surface offloaded is replaced by its placeholder;
// nothing is staged for it and the request still goes out.
{
	const attachments = fakeAttachments(4096);
	const { adapter, calls } = makeAdapter(() => sseResponse([
		'data: {"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}\n\n',
		'data: {"candidates":[{"finishReason":"STOP"}]}\n\n',
	]), defaultConnection(), {
		resolveAttachments: () => attachments,
		resolveImageAccess: () => accessFacts(),
	});
	const offloaded = imageMessage({ offloaded: true });
	for await (const chunk of adapter.stream(requestOptions([offloaded]))) void chunk;

	assert.equal(attachments.staged.length, 0, 'offloaded occurrences are never staged');
	const parts = JSON.parse(calls[0].init.body).contents[0].parts;
	assert.match(parts[0].text, /image omitted to fit request image limits/);
	assert.match(parts[0].text, /"shot\.png" \(sha256:image-1\)/);
	assert.equal(parts[1], undefined);
}

// E. prepareCall binds the connection snapshot it prepared from.
{
	const connection = defaultConnection();
	const { adapter, calls } = makeAdapter(() => sseResponse([
		'data: {"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}\n\n',
		'data: {"candidates":[{"finishReason":"STOP"}]}\n\n',
	]), connection);
	const prepared = await adapter.prepareCall(ROUTE, 'gemini-3.8-flash');
	assert.equal(prepared.model.id, 'gemini-3.8-flash');
	for await (const chunk of prepared.stream(requestOptions([userText('hi')]))) void chunk;
	assert.match(calls[0].url, /aiplatform\.googleapis\.com/);
}

console.log('adapter.test.mjs: all assertions passed');
