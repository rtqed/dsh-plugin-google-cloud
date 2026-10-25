/**
 * Build the self-contained distribution of this plugin.
 *
 * Two kinds of loader install this plugin, and they resolve modules differently.
 *
 * DSH itself installs a bundle with `pnpm add` and loads it through its own
 * runtime resolution, so `@deepseek-ai/dsh-*` peers arrive from the host. That
 * is the `.tgz`, and it stays as it is.
 *
 * Tavern copies a zip into `profile-data/<profile>/data/plugins/<name>/` and
 * loads it through a generated `.tavern-entry.mjs` that does a bare `import()`
 * of `lib/index.js`. Nothing there maps the host packages — they live inside
 * the app's `app.asar`, with no directory on disk to resolve from — so a plugin
 * that imports them fails with `Cannot find package`. The only way to satisfy
 * that loader is to carry the host packages in the zip, which is what this
 * script builds.
 *
 * `npm pack` cannot help: it strips `node_modules` even when the directory is
 * listed in `files`. A zip can, and Tavern extracts it verbatim (its skip list
 * only drops `.git`, `.github` and `node_modules/.cache`).
 *
 * Vendoring the host packages duplicates code that also runs in the host
 * process. That is tolerable here because nothing in this plugin's use of them
 * depends on module identity: `LlmError` is never compared with `instanceof`,
 * `registerAdapter` and `ctx.tools.register` are structural, and `dsh-brand`
 * documents itself as duplicate-install-safe. Keep it that way — an
 * `instanceof` against a host class would silently break the zip.
 *
 * The vendored copies are pinned to the DSH version they were taken from, so a
 * runtime upgrade needs a rebuild. Override with `DSH_HOST_VERSION`.
 *
 * Run it with `npm run bundle`.
 *
 * @module dsh-plugin-google-cloud/scripts/build-bundled
 */
import { spawnSync } from 'node:child_process';
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const STAGE = join(ROOT, '_build', 'bundled');
const DIST = join(ROOT, 'dist');

/** The DSH release the vendored host packages are taken from. */
const HOST_VERSION = process.env.DSH_HOST_VERSION ?? '0.2.1-rc.3';

/** Host packages this plugin imports, which a bare loader cannot resolve. */
const HOST_PACKAGES = [
	'@deepseek-ai/dsh-attachment',
	'@deepseek-ai/dsh-launch-environment',
	'@deepseek-ai/dsh-llm',
	'@deepseek-ai/dsh-tools',
];
/** Run a command and fail loudly with its output when it does not succeed. */
function run(command, args, options = {}) {
	const result = spawnSync(command, args, { stdio: 'inherit', shell: process.platform === 'win32', ...options });
	if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited with ${result.status}`);
}

/** Every file the published package declares, as paths relative to the root. */
async function payload(pkg) {
	const files = [];
	for (const entry of pkg.files ?? []) {
		const slash = entry.lastIndexOf('/');
		if (slash === -1) {
			files.push(entry);
			continue;
		}
		// Only the `dir/*.ext` shape is used here; anything fancier would need a
		// real glob matcher, and the manifest does not ask for one.
		const directory = entry.slice(0, slash);
		const pattern = entry.slice(slash + 1);
		if (!pattern.startsWith('*.')) throw new Error(`unsupported files entry: ${entry}`);
		const extension = pattern.slice(1);
		for (const name of await readdir(join(ROOT, directory))) {
			if (name.endsWith(extension)) files.push(`${directory}/${name}`);
		}
	}
	return files;
}

/** Locate a Python interpreter able to write the zip. */
function python() {
	for (const candidate of ['python', 'python3', 'py']) {
		const probe = spawnSync(candidate, ['-c', 'import zipfile'], { stdio: 'ignore' });
		if (probe.status === 0) return candidate;
	}
	throw new Error('no Python interpreter found to write the zip');
}

/** Write a directory into a zip with forward-slash names and no extra root. */
async function zip(directory, target) {
	const script = `
import os, sys, zipfile
root, target = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
    for base, dirs, names in os.walk(root):
        dirs.sort()
        for name in sorted(names):
            path = os.path.join(base, name)
            archive.write(path, os.path.relpath(path, root).replace(os.sep, "/"))
`;
	// No shell here: the program is multi-line and would be re-split on the way
	// through cmd.exe, which mangles it.
	const result = spawnSync(python(), ['-c', script, directory, target], { stdio: 'inherit' });
	if (result.status !== 0) throw new Error(`zip exited with ${result.status}`);
}

const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
const dependencies = Object.keys(pkg.dependencies ?? {});

// The host packages go into `dependencies` for the install only: npm has no
// other way to be told to fetch them, and `--legacy-peer-deps` would skip them
// if they were left as peers. The shipped manifest drops the whole field.
//
// `cordis` comes along because the host packages take it as a peer, so
// `--legacy-peer-deps` would otherwise leave it out and nothing would load.
// Duplicating it is safe: its `symbols` are registered through `Symbol.for`,
// so two copies agree on every key.
const vendored = Object.fromEntries(HOST_PACKAGES.map(name => [name, HOST_VERSION]));
vendored['@deepseek-ai/cordis'] = pkg.peerDependencies['@deepseek-ai/cordis'];
const installDependencies = { ...(pkg.dependencies ?? {}), ...vendored };

await rm(STAGE, { recursive: true, force: true });
await mkdir(STAGE, { recursive: true });

for (const file of await payload(pkg)) {
	await mkdir(dirname(join(STAGE, file)), { recursive: true });
	await cp(join(ROOT, file), join(STAGE, file));
}

await writeFile(join(STAGE, 'package.json'), JSON.stringify({ ...pkg, dependencies: installDependencies }, null, 2) + '\n');

// Peers are resolved rather than skipped here: the host packages themselves
// take peers (`cordis`, `dsh-scope`, …), and a loader with no resolver needs
// every one of them present. The plugin's own peers are already pinned in
// `installDependencies`, so npm uses those versions for the whole tree.
run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--ignore-scripts', '--no-package-lock'], { cwd: STAGE });

// Bookkeeping npm leaves behind, plus absolute paths that mean nothing here.
for (const junk of ['node_modules/.package-lock.json', 'node_modules/.bin']) {
	await rm(join(STAGE, junk), { recursive: true, force: true });
}

const bundled = [];
try {
	for (const scope of await readdir(join(STAGE, 'node_modules'))) {
		if (!scope.startsWith('@')) {
			bundled.push(scope);
			continue;
		}
		for (const name of await readdir(join(STAGE, 'node_modules', scope))) bundled.push(`${scope}/${name}`);
	}
} catch {
	// No dependencies at all: nothing to bundle, nothing to check.
}

for (const name of [...dependencies, ...Object.keys(vendored)]) {
	if (!bundled.includes(name)) throw new Error(`${name} is declared but was not bundled`);
}

// The installer rejects the package on sight if this key is present, so it is
// dropped from the shipped manifest. The code still imports the package; the
// vendored copy next to it is what resolves.
const shipped = { ...pkg };
delete shipped.dependencies;
await writeFile(join(STAGE, 'package.json'), JSON.stringify(shipped, null, 2) + '\n');

// Prove the shipped tree is loadable on its own: with `dependencies` gone, the
// only thing that can resolve these specifiers is the vendored copy beside it.
const specifiers = [...dependencies, ...Object.keys(vendored)];
const probe = spawnSync(
	process.execPath,
	['-e', `Promise.all(${JSON.stringify(specifiers)}.map(s => import(s))).then(() => console.log('resolved'))`],
	{ cwd: STAGE, encoding: 'utf8' },
);
if (probe.status !== 0) throw new Error(`the bundled closure does not resolve from the staged package:\n${probe.stderr}`);

await mkdir(DIST, { recursive: true });
const base = `${pkg.name}-${pkg.version}`;
const target = join(DIST, `${base}-bundled.zip`);
await zip(STAGE, target);

const size = (await stat(target)).size;
const staged = [];
async function walk(directory) {
	for (const name of await readdir(directory, { withFileTypes: true })) {
		const path = join(directory, name.name);
		if (name.isDirectory()) await walk(path);
		else staged.push(relative(STAGE, path).split(sep).join('/'));
	}
}
await walk(STAGE);

console.log(`\n${relative(ROOT, target)}  ${(size / 1024).toFixed(1)} KiB  ${staged.length} files`);
console.log(`host packages from dsh ${HOST_VERSION}: ${HOST_PACKAGES.join(', ')}`);
console.log(`plus @deepseek-ai/cordis ${pkg.peerDependencies['@deepseek-ai/cordis']}`);
console.log(`bundled: ${bundled.join(', ') || '(none)'}`);
