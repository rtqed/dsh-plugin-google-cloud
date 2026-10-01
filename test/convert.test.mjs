// convert.js unit tests: message conversion, request body, SSE translation.
import assert from 'node:assert/strict';
import { buildRequestBody, convertMessages, translatePayloads } from '../lib/convert.js';

const ROUTE = 'vertexai';
const MODEL = 'gemini-3.8-flash';
const noImages = new Map();
const noAccess = () => undefined;
const noFile = () => undefined;

function base(messages, extra = {}) {
	return {
		messages,
		system: undefined,
		provider: ROUTE,
		model: MODEL,
		requestImages: noImages,
		resolveImageAccess: noAccess,
		resolveFileText: noFile,
		...extra,
	};
}

const user = (text) => ({ id: 'm1', role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } });
const system = (text) => ({ id: 'm0', role: 'system', content: [{ type: 'text', text }], source: { kind: 'plugin', plugin: 'test' } });
const assistant = (content, source) => ({
	id: 'm2', role: 'assistant', content, source: source ?? { kind: 'model', provider: ROUTE, model: MODEL },
});
const toolResult = (callId, name, text, isError = false) => ({
	id: 'm3', role: 'user', content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }], isError }],
	source: { kind: 'tool', callId },
});

// 1. Leading system message becomes systemInstruction.
{
	const { systemInstruction, contents } = convertMessages(base([system('You are helpful.'), user('hi')]));
	assert.equal(systemInstruction, 'You are helpful.');
	assert.equal(contents.length, 1);
	assert.equal(contents[0].role, 'user');
}

// 2. Explicit system wins; leading system message folds into a user turn.
{
	const { systemInstruction, contents } = convertMessages(base([system('A.'), user('hi')], { system: 'B.' }));
	assert.equal(systemInstruction, 'B.');
	const roles = contents.map((c) => c.role);
	assert.deepEqual(roles, ['user', 'user']);
	assert.deepEqual(contents[0].parts, [{ text: 'A.' }]);
}

// 3. Assistant tool-call converts with parsed args and an id on Gemini 3.
{
	const call = { type: 'tool-call', id: 'call_x_0', name: 'read_file', arguments: '{"path":"a.txt"}' };
	const { contents } = convertMessages(base([user('read it'), assistant([call]), toolResult('call_x_0', 'read_file', 'data')]));
	const modelContent = contents.find((c) => c.role === 'model');
	assert.deepEqual(modelContent.parts[0].functionCall, { name: 'read_file', args: { path: 'a.txt' }, id: 'call_x_0' });
	const responseContent = contents.filter((c) => c.role === 'user').at(-1);
	const responsePart = responseContent.parts[0].functionResponse;
	assert.equal(responsePart.name, 'read_file');
	assert.deepEqual(responsePart.response, { output: 'data' });
	assert.equal(responsePart.id, 'call_x_0');
}

// 4. Unparseable tool arguments degrade to an empty object, never throw.
{
	const call = { type: 'tool-call', id: 'call_x_1', name: 't', arguments: '{broken' };
	const { contents } = convertMessages(base([assistant([call])]));
	assert.deepEqual(contents[0].parts[0].functionCall.args, {});
}

// 5. thoughtSignature restores only from this route's replay envelope.
{
	const withSig = assistant(
		[{ type: 'text', text: 'answer' }],
		{ kind: 'model', provider: ROUTE, model: MODEL, replayState: { v: 1, response: { responseId: 'r1' }, blocks: [{ thoughtSignature: 'c2ln' }] } },
	);
	const { contents } = convertMessages(base([withSig]));
	assert.equal(contents[0].parts[0].thoughtSignature, 'c2ln');

	const foreign = assistant(
		[{ type: 'text', text: 'answer' }],
		{ kind: 'model', provider: 'deepseek-official', model: 'deepseek-chat', replayState: { v: 1, blocks: [{ thoughtSignature: 'c2ln' }] } },
	);
	const foreignResult = convertMessages(base([foreign]));
	assert.equal(foreignResult.contents[0].parts[0].thoughtSignature, undefined);
}

// 6. Full request body: tools use parametersJsonSchema on Gemini 3, thinking maps to level.
{
	const body = buildRequestBody(
		base([system('sys'), user('plan')]),
		{ temperature: 0.5, maxTokens: 512, stop: ['END'], reasoningEffort: 'high' },
		[{ name: 'tool_a', description: 'A tool', parameters: { type: 'object', $schema: 'https://json-schema.org/draft/2020-12/schema', properties: { p: { type: 'string' } }, additionalProperties: true } }],
	);
	assert.deepEqual(body.systemInstruction, { parts: [{ text: 'sys' }] });
	assert.equal(body.tools[0].functionDeclarations[0].name, 'tool_a');
	assert.ok('parametersJsonSchema' in body.tools[0].functionDeclarations[0]);
	assert.equal(body.tools[0].functionDeclarations[0].parametersJsonSchema.$schema, undefined);
	assert.equal(body.generationConfig.thinkingConfig.thinkingLevel, 'HIGH');
	assert.equal(body.generationConfig.maxOutputTokens, 512);
	assert.deepEqual(body.generationConfig.stopSequences, ['END']);
}

// 7. Gemini 2.5 maps effort to a token budget and uses the OpenAPI parameters field.
{
	const body = buildRequestBody(
		base([], { model: 'gemini-2.5-pro' }),
		{ reasoningEffort: 'medium' },
		[{ name: 't', description: 'd', parameters: { type: 'object', properties: { p: { type: 'string', anyOf: [{ type: 'string' }] } } } }],
	);
	assert.equal(body.generationConfig.thinkingConfig.thinkingBudget, 8192);
	const decl = body.tools[0].functionDeclarations[0];
	assert.ok('parameters' in decl && !('parametersJsonSchema' in decl));
	assert.deepEqual(decl.parameters.properties.p.anyOf, [{ type: 'string' }], 'non-meta keys survive sanitization like pi-ai');
}

// 8. SSE translation: text, reasoning, tool calls, usage, finish, replay envelope.
async function runTranslate(events) {
	async function* payloads() { for (const event of events) yield event; }
	const chunks = [];
	for await (const chunk of translatePayloads(payloads(), MODEL)) chunks.push(chunk);
	return chunks;
}

{
	const chunks = await runTranslate([
		JSON.stringify({ responseId: 'resp1', candidates: [{ content: { parts: [{ thought: true, text: 'thinking...' }] } }] }),
		JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Hello' }, { text: ' world', thoughtSignature: 'c2ln' }] } }], usageMetadata: { promptTokenCount: 100, cachedContentTokenCount: 40, candidatesTokenCount: 9, thoughtsTokenCount: 5, totalTokenCount: 114 } }),
		JSON.stringify({ candidates: [{ content: { parts: [{ functionCall: { name: 'get_time', args: { tz: 'utc' } } }] }, finishReason: 'STOP' }] }),
	]);
	const kinds = chunks.map((c) => c.type);
	assert.deepEqual(kinds, ['block-start', 'reasoning-delta', 'block-start', 'text-delta', 'text-delta', 'block-start', 'tool-call-delta', 'block-end', 'block-end', 'block-end', 'usage', 'finish']);
	const toolDelta = chunks.find((c) => c.type === 'tool-call-delta');
	assert.match(toolDelta.id, /^call_resp1_0$/);
	assert.equal(toolDelta.name, 'get_time');
	assert.equal(toolDelta.argumentsDelta, '{"tz":"utc"}');
	const toolEnd = chunks.filter((c) => c.type === 'block-end').map((c) => c.block).find((b) => b.type === 'tool-call');
	assert.equal(toolEnd.arguments, '{"tz":"utc"}');
	assert.deepEqual(chunks.find((c) => c.type === 'usage').usage, { inputTokens: 60, outputTokens: 9, totalTokens: 114, cacheReadTokens: 40, reasoningTokens: 5 });
	assert.equal(chunks.at(-1).reason.kind, 'tool-calls');
	const signatureEnd = chunks.filter((c) => c.type === 'block-end').map((c) => c.block).find((b) => b.type === 'text');
	assert.ok(signatureEnd.text.includes('world'));
	assert.deepEqual(chunks.at(-1).replayState.blocks[1], { thoughtSignature: 'c2ln' }, 'text block carries its part signature');
}

// 9. Finish mapping: MAX_TOKENS, refusals, and empty responses are distinct.
{
	const maxTokens = await runTranslate([
		JSON.stringify({ candidates: [{ content: { parts: [{ text: 'partial' }] }, finishReason: 'MAX_TOKENS' }] }),
	]);
	assert.equal(maxTokens.at(-1).reason.kind, 'max-tokens');

	const safety = await runTranslate([
		JSON.stringify({ candidates: [{ finishReason: 'SAFETY' }] }),
	]);
	assert.equal(safety.at(-1).reason.kind, 'error');
	assert.equal(safety.at(-1).reason.failure.code, 'PROVIDER_REFUSED');

	const empty = await runTranslate([
		JSON.stringify({ candidates: [{ finishReason: 'STOP' }] }),
	]);
	assert.equal(empty.at(-1).reason.kind, 'error');
	assert.equal(empty.at(-1).reason.failure.code, 'EMPTY_RESPONSE');

	const blocked = await runTranslate([
		JSON.stringify({ promptFeedback: { blockReason: 'SAFETY' } }),
	]);
	assert.equal(blocked.at(-1).reason.failure.code, 'PROVIDER_REFUSED');
}

// 10. Mid-stream provider errors throw a coded error.
{
	await assert.rejects(
		runTranslate([JSON.stringify({ error: { code: 429, message: 'Resource exhausted' } })]),
		(error) => error.code === 'INVALID_RESPONSE' && error.status === 429,
	);
}

console.log('convert.test.mjs: all assertions passed');
