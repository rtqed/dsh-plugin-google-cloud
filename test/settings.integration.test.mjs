// Integration: the plugin's Config as the settings namespace it registers on the
// REAL settings service — the same code a running host uses to build the
// configuration page and to persist one form edit.
//
// DSH 0.1.5-rc.2 has no volatile config root: a plugin registers a namespace
// whose composition entry is the base layer and whose user layer lives in the
// settings document. These tests drive `describe()`, `mutate()`, the revision
// guard, and the write-through to the plugin's live surfaces directly.
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local';
import LlmRuntime from '@deepseek-ai/dsh-llm';
import { SettingsConflictError } from '@deepseek-ai/dsh-settings';
import FileSettingsProvider from '@deepseek-ai/dsh-settings-file';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import { DEFAULT_IMAGE_MODEL } from '../lib/image-catalog.js';
import { Config, NS, ROUTE, apply, inject, name as pluginName } from '../lib/index.js';

/** Isolated service homes for this run, outside the real `~/.dsh`. */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '_artifact-check');
const SETTINGS_DIR = join(ROOT, 'tmp-settings');
const SETTINGS_FILE = join(SETTINGS_DIR, 'settings-integration.yaml');
const ATTACHMENTS_HOME = join(ROOT, 'tmp-attachments');

/** Every field the Config declares, as the settings schema publishes them. */
const FIELDS = [
	'apiKeyEnv', 'authMode', 'customModels', 'displayName', 'endpoint',
	'imageAspectRatio', 'imageCount', 'imageModel', 'imageToolEnabled',
	'projectId', 'region', 'serviceAccountJsonEnv', 'streamIdleTimeoutMs', 'tier',
];

/**
 * Mount the plugin on a real context whose settings service is the file-backed
 * provider, so registration, resolution, persistence, and the plugin's own
 * re-derivation are all production paths.
 * @param {object} [config] - the mounting entry's raw config block.
 * @returns {Promise<object>} the mounted context.
 */
async function mount(config = {}) {
	rmSync(SETTINGS_DIR, { recursive: true, force: true });
	const ctx = new Context();
	await ctx.plugin(SystemPrompt);
	await ctx.plugin(ToolRuntime);
	await ctx.plugin(LocalAttachmentStore, { dshHome: ATTACHMENTS_HOME });
	await ctx.plugin(LlmRuntime);
	await ctx.plugin(FileSettingsProvider, { path: SETTINGS_FILE, watch: false });
	await ctx.plugin({ name: pluginName, inject, Config, apply }, config);
	return ctx;
}

/** Let the service's queued watcher tails run: they notify on a microtask. */
const settle = () => new Promise((resolve) => { setTimeout(resolve, 0); });

test('describe() publishes the whole Config as one live section', async () => {
	const ctx = await mount({ region: 'us-central1' });

	const [descriptor, ...rest] = ctx.settings.describe();
	assert.equal(rest.length, 0, 'the plugin registers exactly one namespace');
	assert.ok(descriptor, 'the namespace is configurable');
	assert.equal(descriptor.ns, NS);
	assert.equal(descriptor.applies, 'live');
	assert.equal(descriptor.revision, 0);
	assert.equal(descriptor.value.region, 'us-central1', 'stored values reach the form');
	assert.equal(descriptor.value.tier, 'standard', 'defaults are projected');
	assert.equal(descriptor.value.apiKeyEnv, 'GOOGLE_CLOUD_API_KEY');
	assert.deepEqual(Object.keys(descriptor.value).sort(), [...FIELDS].sort());
	assert.equal(descriptor.base.region, 'us-central1', 'the mounting entry is the composition layer');
	assert.equal(descriptor.user, undefined, 'nothing is overridden yet');
	assert.match(JSON.stringify(descriptor.schema), /streamIdleTimeoutMs/, 'the schema describes the declared fields');
	assert.match(JSON.stringify(descriptor.schema), /imageModel/, 'the schema publishes the image settings');

	// The image-generation fields are ordinary live config: the tool reads them
	// through the same source on every call, so an edit needs no remount.
	assert.equal(descriptor.value.imageToolEnabled, true, 'the image tool ships enabled');
	assert.equal(descriptor.value.imageModel, DEFAULT_IMAGE_MODEL);
	assert.equal(descriptor.value.imageAspectRatio, '1:1');
	assert.equal(descriptor.value.imageCount, 1);
});

test('mutate() persists the sparse user layer and refuses a stale revision', async () => {
	const ctx = await mount({ region: 'global', apiKeyEnv: 'GOOGLE_CLOUD_API_KEY' });
	const first = ctx.settings.describe()[0];
	assert.equal(first.revision, 0);

	await ctx.settings.mutate(NS, [{ op: 'set', path: ['region'], value: 'us-central1' }], first.revision);
	const after = ctx.settings.describe()[0];
	assert.equal(after.revision, 1, 'the revision bumps once per committed write');
	assert.equal(after.value.region, 'us-central1');
	assert.equal(after.value.tier, 'standard', 'untouched fields keep resolving from the entry');
	assert.deepEqual(after.user, { region: 'us-central1' }, 'only the touched field is stored');

	const document = readFileSync(SETTINGS_FILE, 'utf8');
	assert.match(document, new RegExp(`^${NS}:`, 'm'), 'the section is persisted under its namespace');
	assert.match(document, /region: us-central1/);
	assert.ok(!document.includes('apiKeyEnv'), 'untouched fields stay inherited from the entry');

	await assert.rejects(
		ctx.settings.mutate(NS, [{ op: 'set', path: ['region'], value: 'europe-west1' }], first.revision),
		(error) => error instanceof SettingsConflictError,
	);
	assert.equal(ctx.settings.get(NS).region, 'us-central1', 'the refused write changed nothing');
});

test('a committed write reaches the plugin live: the surfaces follow without a remount', async () => {
	const ctx = await mount({ displayName: 'Google Vertex AI', region: 'global' });
	assert.deepEqual(ctx.llm.listProviders(), [{ id: ROUTE, name: 'Google Vertex AI' }]);

	await ctx.settings.update(NS, { displayName: 'Vertex After Edit', region: 'europe-west1' });
	await settle();

	assert.equal(ctx.settings.get(NS).displayName, 'Vertex After Edit');
	assert.deepEqual(ctx.llm.listProviders(), [{ id: ROUTE, name: 'Vertex After Edit' }], 'the route kept its place');
	assert.equal(ctx.llm.listConfigurableProviders()[0].displayName, 'Vertex After Edit');

	const discovered = await ctx.llm.discoverModels(NS, { provider: ROUTE });
	assert.ok(discovered.length > 0, 'discovery keeps serving after an edit');
});
