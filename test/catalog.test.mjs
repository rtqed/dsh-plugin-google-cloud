import assert from 'node:assert/strict';
import test from 'node:test';
import {
	CATALOG,
	DEFAULT_REGION_MODELS,
	listModelsForRegion,
	formatGeminiName,
} from '../lib/catalog.js';

test('catalog exports and formatGeminiName', () => {
	assert.ok(Array.isArray(CATALOG));
	assert.ok(CATALOG.length >= 10);
	assert.equal(formatGeminiName('gemini-2.5-pro'), 'Gemini 2.5 Pro');
	assert.equal(formatGeminiName('gemini-3.8-flash'), 'Gemini 3.8 Flash');
	assert.equal(formatGeminiName('claude-3-5-sonnet'), 'Claude 3 5 Sonnet');
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
