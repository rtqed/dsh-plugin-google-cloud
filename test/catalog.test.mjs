import assert from 'node:assert/strict';
import test from 'node:test';
import {
	CATALOG,
	DEFAULT_REGION_MODELS,
	catalogModel,
	flexPaygoServes,
	geminiMajorVersion,
	listModelsForRegion,
	formatGeminiName,
	reasoningFamilyOf,
	requiresToolCallId,
	thinkingConfigFor,
} from '../lib/catalog.js';

test('catalog exports and formatGeminiName', () => {
	assert.ok(Array.isArray(CATALOG));
	assert.ok(CATALOG.length >= 10);
	assert.equal(formatGeminiName('gemini-2.5-pro'), 'Gemini 2.5 Pro');
	assert.equal(formatGeminiName('gemini-3.8-flash'), 'Gemini 3.8 Flash');
	assert.equal(formatGeminiName('claude-3-5-sonnet'), 'Claude 3 5 Sonnet');
});

test('gemini-4-argon carries its unified 1M window and three thinking levels', () => {
	const entry = catalogModel('gemini-4-argon');
	assert.ok(entry, 'the frontier model is in the static catalog');
	assert.equal(entry.name, 'Gemini 4 Argon');
	assert.equal(entry.contextWindow, 1048576);
	assert.equal(entry.maxTokens, 65536);
	assert.equal(formatGeminiName('gemini-4-argon'), 'Gemini 4 Argon');

	// Vertex serves Argon on the global endpoint and the us/eu multi-regions only.
	assert.ok(DEFAULT_REGION_MODELS.global.includes('gemini-4-argon'));
	assert.ok(DEFAULT_REGION_MODELS.us.includes('gemini-4-argon'));
	assert.ok(DEFAULT_REGION_MODELS.eu.includes('gemini-4-argon'));
	assert.ok(listModelsForRegion('global').some((model) => model.id === 'gemini-4-argon'));
	assert.ok(!listModelsForRegion('asia-northeast1').some((model) => model.id === 'gemini-4-argon'));

	// A Gemini 4 id: function calls carry ids and take full JSON Schema parameters.
	assert.equal(geminiMajorVersion('gemini-4-argon'), 4);
	assert.equal(requiresToolCallId('gemini-4-argon'), true);

	// Argon is tunable across low/medium/high, so minimal floors to LOW.
	assert.equal(reasoningFamilyOf('gemini-4-argon'), 'gemini4-argon');
	assert.deepEqual(thinkingConfigFor('gemini-4-argon', 'minimal'), { includeThoughts: true, thinkingLevel: 'LOW' });
	assert.deepEqual(thinkingConfigFor('gemini-4-argon', 'low'), { includeThoughts: true, thinkingLevel: 'LOW' });
	assert.deepEqual(thinkingConfigFor('gemini-4-argon', 'medium'), { includeThoughts: true, thinkingLevel: 'MEDIUM' });
	assert.deepEqual(thinkingConfigFor('gemini-4-argon', 'high'), { includeThoughts: true, thinkingLevel: 'HIGH' });

	// An unlisted Argon snapshot still resolves to the same wire family.
	assert.equal(reasoningFamilyOf('gemini-4-argon-exp-2026-10-13'), 'gemini4-argon');

	// Vertex serves Argon through Standard and Priority PayGo only, never Flex.
	assert.equal(flexPaygoServes('gemini-4-argon'), false);
	assert.equal(flexPaygoServes('gemini-4-argon-exp-2026-10-13'), false);
	assert.equal(flexPaygoServes('gemini-3.8-flash'), true);
	assert.equal(flexPaygoServes('gemini-2.5-pro'), true);
});

test('listModelsForRegion default and region filtering', () => {
	const globalModels = listModelsForRegion('global');
	assert.ok(globalModels.length >= 15);
	assert.ok(globalModels.some((m) => m.id === 'gemini-2.5-pro'));

	const tokyoModels = listModelsForRegion('asia-northeast1');
	assert.ok(tokyoModels.length > 0);
	assert.ok(tokyoModels.length <= globalModels.length);
	assert.ok(tokyoModels.some((m) => m.id === 'gemini-2.5-flash'));
});

test('listModelsForRegion customModels integration', () => {
	const base = listModelsForRegion('asia-northeast1');
	const customList = ['my-tuned-model', 'gemini-2.5-pro-exp-02-05'];
	const combined = listModelsForRegion('asia-northeast1', customList);

	assert.equal(combined.length, base.length + 2);
	assert.ok(combined.some((m) => m.id === 'my-tuned-model'));
	assert.ok(combined.some((m) => m.id === 'gemini-2.5-pro-exp-02-05'));

	const customEntry = combined.find((m) => m.id === 'my-tuned-model');
	assert.equal(customEntry.contextWindow, 1048576);
	assert.equal(customEntry.maxTokens, 65536);

	// Deduplication: adding an already existing model shouldn't duplicate
	const withDuplicate = listModelsForRegion('asia-northeast1', ['gemini-2.5-flash', 'new-model']);
	assert.equal(withDuplicate.length, base.length + 1);
});
