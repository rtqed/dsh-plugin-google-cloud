/**
 * The manifest contract a DSH profile enforces before it imports a plugin.
 *
 * `evaluatePluginCompatibility` is the runtime's own check, so this file asks
 * the running installation rather than restating its rules: a plugin whose
 * declared range does not cover the runtime is rejected outright, its modules
 * never imported. The declaration below is therefore load-bearing, and an
 * exact pin on a prerelease is the way it breaks — a pin to one rc excludes
 * every later rc of the same version.
 *
 * Which declaration decides depends on the runtime. From 0.2.1 on an own
 * `engines.dsh` wins outright; the 0.2.0 line has no notion of that field and
 * checks `peerDependencies` instead. Both are asserted against the same floor
 * so neither runtime can reject a manifest the other accepts.
 *
 * @module dsh-plugin-google-cloud/test/manifest.test
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

/** The runtime packages this plugin links against, all supplied by the host. */
const HOST_PACKAGES = [
	'@deepseek-ai/dsh-attachment',
	'@deepseek-ai/dsh-launch-environment',
	'@deepseek-ai/dsh-llm',
	'@deepseek-ai/dsh-tools',
];

test('the manifest declares the current dsh manifest format and a bundle patch', () => {
	assert.equal(manifest.dsh?.manifestVersion, 1);
	assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml');
	assert.equal(manifest.dsh?.client?.platform, 'web');
	assert.equal(manifest.main, 'lib/index.js');
	assert.equal(manifest.exports?.['./client'], './lib/client.js');
});

test('the manifest declares a dsh version range instead of exact prerelease pins', () => {
	// The floor has to live in both places. Runtimes from 0.2.1 on let an own
	// `engines.dsh` decide alone, but the 0.2.0 line predates that field and
	// reads only the dsh peers, so widening `engines.dsh` without widening the
	// peers leaves the plugin rejected on 0.2.0 while looking compatible here.
	assert.equal(typeof manifest.engines?.dsh, 'string');
	assert.ok(manifest.engines.dsh.trim().length > 0);
	assert.match(manifest.engines.dsh, /^[\^~]|>=/, 'a caret, tilde, or comparator range, not an exact pin');

	for (const name of HOST_PACKAGES) {
		const range = manifest.peerDependencies?.[name];
		assert.equal(typeof range, 'string', `${name} must stay a peer dependency`);
		assert.match(range, /^[\^~]|>=/, `${name} must not pin one prerelease: ${range}`);
		assert.equal(range, manifest.engines.dsh, `${name} must declare the same floor as engines.dsh`);
	}
});

test('the running dsh runtime satisfies the declared range', async (t) => {
	const { evaluatePluginCompatibility, getDshRuntimeVersion } = await import('@deepseek-ai/dsh-app-boot')
		.catch(() => ({}));
	if (evaluatePluginCompatibility === undefined) {
		t.skip('this installation does not expose the compatibility checker');
		return;
	}
	const runtimeVersion = getDshRuntimeVersion();
	assert.equal(
		evaluatePluginCompatibility(manifest, {}, runtimeVersion),
		undefined,
		`dsh ${runtimeVersion} rejects this plugin's declared requirements`,
	);
});
