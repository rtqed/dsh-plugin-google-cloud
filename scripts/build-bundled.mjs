/**
 * Build the self-contained distribution of this plugin.
 *
 * DSH installs a bundle with `pnpm add`, and its one-click installer refuses a
 * package whose manifest declares runtime `dependencies` — it cannot resolve
 * them without a package manager, so it asks the author to ship the code
 * instead. `npm pack` cannot answer that: it strips `node_modules` even when
 * the directory is listed in `files`, so a tarball can never carry the closure.
 *
 * This script produces a zip that can. It stages the payload the published
 * package declares, materializes the dependency closure next to it, and then
 * rewrites the staged manifest without `dependencies` so the installer has
 * nothing left to resolve. Peers are skipped on purpose: `@deepseek-ai/dsh-*`
 * and `@deepseek-ai/cordis` are the host's own instances and must not be
 * vendored, or the plugin would load a second copy of the runtime.
 *
 * Run it with `npm run bundle`. Both artifacts land in `dist/`.
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

await rm(STAGE, { recursive: true, force: true });
await mkdir(STAGE, { recursive: true });

for (const file of await payload(pkg)) {
	await mkdir(dirname(join(STAGE, file)), { recursive: true });
	await cp(join(ROOT, file), join(STAGE, file));
}

// The manifest goes in with its dependencies so `npm install` has something to
// resolve; it is rewritten below, before anything is zipped.
await writeFile(join(STAGE, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');

if (dependencies.length > 0) {
	// `--legacy-peer-deps` keeps npm from auto-installing the host packages:
	// a vendored copy of the runtime would load beside the real one.
	run('npm', ['install', '--omit=dev', '--legacy-peer-deps', '--no-audit', '--no-fund', '--ignore-scripts', '--no-package-lock'], { cwd: STAGE });
}

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

for (const name of dependencies) {
	if (!bundled.includes(name)) throw new Error(`${name} is declared but was not bundled`);
}

// The installer rejects the package on sight if this key is present, so it is
// dropped from the shipped manifest. The code still imports the package; the
// vendored copy next to it is what resolves.
const shipped = { ...pkg };
delete shipped.dependencies;
await writeFile(join(STAGE, 'package.json'), JSON.stringify(shipped, null, 2) + '\n');

const probe = spawnSync(process.execPath, ['-e', `import(${JSON.stringify(dependencies[0] ?? 'node:fs')}).then(() => console.log('resolved'))`], {
	cwd: STAGE,
	encoding: 'utf8',
});
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
console.log(`bundled: ${bundled.join(', ') || '(none)'}`);
