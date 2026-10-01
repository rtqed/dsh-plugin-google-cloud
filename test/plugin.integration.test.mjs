// Integration: the plugin's real `apply` against a real Cordis context and the
// real `llm` service (`LlmRuntime`), which validates every registration the
// plugin makes — the adapter route and its metadata, the configurable-provider
// directory entry, and model discovery.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { isVolatile, updateVolatile } from '@deepseek-ai/cosmokit';
import LlmRuntime from '@deepseek-ai/dsh-llm';
import {
	Config,
	NS,
	ROUTE,
	apply,
	inject,
	name as pluginName,
} from '../lib/index.js';

/**
 * Mount the plugin on a fresh context whose `llm` service is the real runtime,
 * capturing the plugin context and the config reference the schema resolved to.
 * @param {object} [config] - the mounting entry's raw config block.
 * @returns {Promise<{ ctx: object, pluginCtx: object, configRef: object }>} the harness.
 */
async function mount(config = {}) {
	const ctx = new Context();
	await ctx.plugin(LlmRuntime);

	let pluginCtx;
	let configRef;
	await ctx.plugin({
		name: pluginName,
		inject,
		Config,
		apply(childCtx, childConfig) {
			pluginCtx = childCtx;
			configRef = childConfig;
			return apply(childCtx, childConfig);
		},
	}, config);

	assert.ok(pluginCtx, 'the plugin activated');
	return { ctx, pluginCtx, configRef };
}

test('apply() registers one live adapter with the real runtime', async () => {
	const { ctx, configRef } = await mount({ region: 'us-central1', projectId: 'vertex-proj' });

	assert.ok(isVolatile(configRef), 'a root-volatile Config hands the plugin a live reference');
	assert.equal(configRef.get().region, 'us-central1');
	assert.equal(configRef.get().tier, 'standard', 'defaults are resolved for the plugin');

	assert.deepEqual(ctx.llm.listProviders(), [{ id: ROUTE, name: 'Google Vertex AI' }]);

	const models = await ctx.llm.listModels(ROUTE);
	assert.ok(models.length >= 10);
	assert.ok(models.every((model) => model.provider === ROUTE && typeof model.id === 'string' && model.name.length > 0));

	const resolved = await ctx.llm.resolveModelInfo(ROUTE, 'gemini-2.5-pro');
	assert.equal(resolved.provider, ROUTE);
	assert.equal(resolved.name, 'Gemini 2.5 Pro');
	assert.deepEqual(resolved.inputModalities, ['text', 'image']);
	assert.equal(resolved.context.contextWindow, 1048576);
	assert.equal(resolved.defaultMaxTokens, 65536);
	assert.deepEqual(resolved.reasoning.efforts.map((effort) => effort.id), ['minimal', 'low', 'medium', 'high']);

	const unlisted = await ctx.llm.resolveModelInfo(ROUTE, 'gemini-future-model');
	assert.equal(unlisted.name, 'gemini-future-model');
	assert.equal(unlisted.reasoning, undefined, 'an unknown model advertises no reasoning control');

	const directory = ctx.llm.listConfigurableProviders();
	assert.deepEqual(directory, [{
		provider: ROUTE,
		displayName: 'Google Vertex AI',
		settingsNs: NS,
		settingsPath: [],
		declared: false,
	}]);
});

test('discovery serves the catalog through the runtime', async () => {
	const { ctx } = await mount({ region: 'global', customModels: ['my-tuned-model'] });

	const discovered = await ctx.llm.discoverModels(NS, { provider: ROUTE });
	assert.ok(discovered.length > 0);
	assert.ok(discovered.some((model) => model.id === 'gemini-2.5-pro'));
	assert.ok(discovered.some((model) => model.id === 'my-tuned-model'), 'configured custom models are advertised');
	assert.equal(new Set(discovered.map((model) => model.id)).size, discovered.length, 'ids are deduplicated');

	await assert.rejects(
		ctx.llm.discoverModels('a-namespace-nobody-registered', { provider: ROUTE }),
		(error) => error.code === 'NO_DISCOVERY',
	);
});

test('a live config update reaches the adapter and the directory without a remount', async () => {
	const { ctx, pluginCtx, configRef } = await mount({ displayName: 'Google Vertex AI', region: 'global' });

	// This is exactly what the loader's volatile-only commit does for a root ref.
	const next = Config['~standard'].validate({ displayName: 'Vertex After Edit', region: 'europe-west1' });
	updateVolatile(configRef, next.value);
	pluginCtx.emit('loader/volatile-update', [[]]);

	assert.equal(configRef.get().displayName, 'Vertex After Edit');
	assert.deepEqual(ctx.llm.listProviders(), [{ id: ROUTE, name: 'Vertex After Edit' }]);
	assert.equal(ctx.llm.listConfigurableProviders()[0].displayName, 'Vertex After Edit');

	const discovered = await ctx.llm.discoverModels(NS, { provider: ROUTE });
	assert.ok(discovered.length > 0, 'discovery keeps serving after an edit');
});

test('an invalid config never activates the plugin', async () => {
	const ctx = new Context();
	await ctx.plugin(LlmRuntime);
	let applied = 0;
	const fiber = ctx.plugin({
		name: pluginName,
		inject,
		Config,
		apply(...args) {
			applied += 1;
			return apply(...args);
		},
	}, { streamIdleTimeoutMs: 10 });
	// The runtime reports the rejected config on the fiber; the plugin must not
	// have registered anything from it.
	await (fiber.await?.() ?? Promise.resolve()).catch(() => {});
	await new Promise((resolve) => { setTimeout(resolve, 10); });
	assert.equal(applied, 0, 'a config that fails validation never activates the plugin');
	assert.deepEqual(ctx.llm.listProviders(), [], 'nothing was registered');
});

test('a full runtime call reaches Vertex and returns harness chunks', async () => {
	const encoder = new TextEncoder();
	const calls = [];
	globalThis.fetch = async (url, init) => {
		calls.push({ url, init });
		return new Response(new ReadableStream({
			start(controller) {
				for (const frame of [
					'data: {"candidates":[{"content":{"parts":[{"text":"Hi there"}]}}]}\n\n',
					'data: {"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":3,"totalTokenCount":13}}\n\n',
					'data: {"candidates":[{"finishReason":"STOP"}]}\n\n',
				]) controller.enqueue(encoder.encode(frame));
				controller.close();
			},
		}), { status: 200, headers: { 'content-type': 'text/event-stream' } });
	};
	process.env.GOOGLE_CLOUD_API_KEY = 'test-api-key';
	try {
		const { ctx } = await mount({ region: 'global' });
		const chunks = [];
		for await (const chunk of ctx.llm.stream({
			provider: ROUTE,
			model: 'gemini-3.8-flash',
			system: 'be brief',
			messages: [{ id: 'm1', role: 'user', content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }],
		})) chunks.push(chunk);

		assert.deepEqual(chunks.map((chunk) => chunk.type), ['block-start', 'text-delta', 'block-end', 'usage', 'finish']);
		assert.equal(chunks[1].text, 'Hi there');
		assert.deepEqual(chunks[2].block, { type: 'text', text: 'Hi there' });
		assert.deepEqual(chunks[3].usage, { inputTokens: 10, outputTokens: 3, totalTokens: 13 });
		assert.deepEqual(chunks[4].reason, { kind: 'stop' });

		const [call] = calls;
		const url = new URL(call.url);
		assert.equal(`${url.origin}${url.pathname}`, 'https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-3.8-flash:streamGenerateContent');
		assert.equal(url.searchParams.get('alt'), 'sse');
		assert.equal(url.searchParams.get('key'), 'test-api-key');
		assert.equal(call.init.headers['content-type'], 'application/json');
		assert.ok(call.init.headers['user-agent'].length > 0, 'attribution headers ride every request');
		assert.deepEqual(JSON.parse(call.init.body), {
			contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
			systemInstruction: { parts: [{ text: 'be brief' }] },
			generationConfig: { maxOutputTokens: 65536 },
		});
	} finally {
		delete process.env.GOOGLE_CLOUD_API_KEY;
	}
});

test('a missing credential surfaces as a failure chunk, not a thrown request', async () => {
	globalThis.fetch = async () => {
		throw new Error('the adapter must not fetch without a credential');
	};
	const { ctx } = await mount({ apiKeyEnv: 'GOOGLE_CLOUD_API_KEY_ABSENT_FROM_THE_ENVIRONMENT' });
	const chunks = [];
	for await (const chunk of ctx.llm.stream({
		provider: ROUTE,
		model: 'gemini-3.8-flash',
		messages: [{ id: 'm1', role: 'user', content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }],
	})) chunks.push(chunk);
	assert.deepEqual(chunks.map((chunk) => chunk.type), ['finish']);
	assert.equal(chunks[0].reason.kind, 'error');
	assert.equal(chunks[0].reason.failure.code, 'MISSING_CREDENTIAL');
	assert.match(chunks[0].reason.failure.message, /GOOGLE_CLOUD_API_KEY_ABSENT_FROM_THE_ENVIRONMENT/);
});

console.log('plugin.integration.test.mjs: all assertions passed');
