// Integration: the plugin's Config against the REAL settings service
// (`@deepseek-ai/dsh-settings`) — the same code the running host uses to build
// the configuration surface and to persist one form edit.
//
// `SettingsForms` only reads a handful of members from its owner context, so
// this file drives the real `describe()` / `configure()` / `mutate()` paths
// directly: root-volatile Config fields, the `auto: false` presentation policy
// the plugin registers, the projected value, and the config block one write
// persists.
import assert from 'node:assert/strict';
import test from 'node:test';
import { isVolatile, updateVolatile, volatileEntries } from '@deepseek-ai/cosmokit';
import { resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm';
import SettingsForms from '@deepseek-ai/dsh-settings';
import { Config, NS } from '../lib/index.js';

/** Resolve the plugin Config exactly as the loader does for a volatile root. */
function resolveConfig(raw) {
	const result = Config['~standard'].validate(raw);
	assert.equal(result.issues, undefined, `config must validate: ${JSON.stringify(result.issues)}`);
	return result.value;
}

/**
 * The members `SettingsForms` reads from its owner context, plus a fake profile
 * entry whose config block is the stored authority.
 * @param {object} config - the entry's raw config block.
 * @returns {{ ctx: object, entry: object, written: object[] }} the harness.
 */
function makeOwner(config) {
	const written = [];
	const entry = {
		id: NS,
		options: { id: NS, config },
		fiber: {
			state: 2,
			uid: 'uid-1',
			runtime: { Config },
			ctx: {},
			config: resolveConfig(config),
		},
	};
	const ctx = {
		fiber: { state: 2 },
		reflect: { provide() {}, get: () => undefined },
		logger: { info() {}, warn() {}, error() {}, debug() {} },
		profileContext: { home: 'C:\\nonexistent-profile-for-tests' },
		effect(fn) { const off = fn(); return typeof off === 'function' ? off : () => {}; },
		on() { return () => {}; },
		emit() {},
		configEditor: {
			configuration: () => [{ entry, inherited: undefined, override: undefined }],
			entries: () => [entry],
			edit: async (target, change) => {
				written.push(change({ ...(target.options.config ?? {}) }, {}));
			},
		},
	};
	ctx.root = { ...ctx, loader: { await: async () => {} } };
	return { ctx, entry, written };
}

test('a root-volatile Config is edited live: the mounting reference updates in place', () => {
	const ref = resolveConfig({ region: 'global' });
	assert.ok(isVolatile(ref), 'the resolved Config is a reference object');
	const refs = volatileEntries(ref);
	assert.equal(refs.length, 1, 'exactly one reference');
	assert.deepEqual(refs[0].path, [], 'the reference is the config root');

	// This is the loader's volatile-only commit path, verbatim.
	updateVolatile(ref, resolveConfig({ region: 'us-central1', tier: 'priority' }));
	assert.equal(ref.get().region, 'us-central1', 'the mounting plugin observes the new value');
	assert.equal(ref.get().tier, 'priority');
	assert.equal(ref.get().apiKeyEnv, 'GOOGLE_CLOUD_API_KEY', 'defaults survive the update');
});

test('describe() publishes the whole Config as one live form and honours auto: false', () => {
	const { ctx, entry } = makeOwner({ region: 'us-central1' });
	const forms = new SettingsForms(ctx);

	const [descriptor, ...rest] = forms.describe();
	assert.equal(rest.length, 0);
	assert.ok(descriptor, 'the namespace is configurable');
	assert.equal(descriptor.ns, NS);
	assert.equal(descriptor.applies, 'live');
	assert.equal(descriptor.autoGenerate, true, 'no presentation policy registered yet');
	assert.equal(descriptor.value.region, 'us-central1', 'stored values reach the form');
	assert.equal(descriptor.value.apiKeyEnv, 'GOOGLE_CLOUD_API_KEY', 'defaults are projected');
	assert.deepEqual(Object.keys(descriptor.value).sort(), [
		'apiKeyEnv', 'authMode', 'customModels', 'displayName', 'endpoint',
		'projectId', 'region', 'serviceAccountJsonEnv', 'streamIdleTimeoutMs', 'tier',
	]);
	assert.ok(descriptor.schema, 'the form schema is published to clients');
	assert.match(JSON.stringify(descriptor.schema), /streamIdleTimeoutMs/, 'the schema describes the declared fields');

	// The plugin ships its own page, so its `apply` opts the entry out.
	forms.configure({ auto: false }, entry.fiber);
	assert.equal(forms.describe()[0].autoGenerate, false, 'the page policy is reported to clients');
});

test('mutate() persists the projected config block and refuses a stale revision', async () => {
	const { ctx, entry, written } = makeOwner({ region: 'global', apiKeyEnv: 'GOOGLE_CLOUD_API_KEY' });
	const forms = new SettingsForms(ctx);
	const first = forms.describe()[0];
	assert.equal(first.revision, 0);

	await forms.mutate(NS, [{ op: 'set', path: ['region'], value: 'us-central1' }], first.revision);
	assert.equal(written.length, 1, 'one config write');
	// The persisted block is the sparse override: the fields the entry already
	// carried plus the edit. Untouched fields that were never stored stay
	// schema-level defaults and are resolved from the schema on the next load.
	assert.deepEqual(written[0], { region: 'us-central1', apiKeyEnv: 'GOOGLE_CLOUD_API_KEY' });

	// An out-of-band change to the stored block moves the revision on; the next
	// write that still names the old revision is refused.
	entry.options.config = { ...written[0], region: 'europe-west1' };
	const moved = forms.describe()[0];
	assert.equal(moved.revision, first.revision + 1, 'a changed stored block advances the revision');
	await assert.rejects(
		forms.mutate(NS, [{ op: 'set', path: ['region'], value: 'eu' }], first.revision),
		(error) => error.code === 'SETTINGS_CONFLICT',
	);
	assert.equal(written.length, 1, 'the refused write persisted nothing');
});

test('image access resolves through the shared attachment helper', () => {
	const provider = {
		imageHostPath: (ref) => (ref.attachmentId === 'sha256:a' ? '/host/a.png' : undefined),
	};
	assert.deepEqual(
		resolveImageAttachmentAccess(provider, (hostPath) => hostPath.replace('/host', '/world'), { attachmentId: 'sha256:a' }),
		{ readonlyPath: '/world/a.png' },
	);
	assert.equal(
		resolveImageAttachmentAccess(provider, () => undefined, { attachmentId: 'sha256:a' }),
		undefined,
		'a mapping that yields no execution-world path reports no access',
	);
	assert.equal(
		resolveImageAttachmentAccess(provider, (hostPath) => hostPath, { attachmentId: 'sha256:b' }),
		undefined,
		'an unknown reference reports no access',
	);
});

console.log('settings.integration.test.mjs: all assertions passed');
