/**
 * Test-time resolver for the harness packages this plugin links against.
 *
 * The plugin declares the harness packages as `peerDependencies`, so a real
 * installation resolves them from the profile (or from whatever tree mounted
 * the plugin) and never from a copy of its own. This loader reproduces exactly
 * that resolution for the test run without installing anything: every
 * `@deepseek-ai/*` specifier is resolved as if it were requested from inside
 * the running application's own `node_modules`, which is one single instance
 * of each package — the same instance the host would hand the plugin.
 *
 * Point `DSH_APP_MODULES` at the application's `node_modules` directory when
 * the default location does not apply; when the directory does not exist the
 * loader stays inert and the ordinary resolution (an installed dependency
 * tree) is used.
 *
 * @module dsh-plugin-google-cloud/test/harness-loader
 */
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const appModules = process.env.DSH_APP_MODULES
	?? join(process.env.ProgramFiles ?? 'C:\\Program Files', 'DSH Desktop', 'resources', 'app', 'node_modules');

if (existsSync(join(appModules, '@deepseek-ai'))) {
	// A path inside the application tree: Node's own resolver walks up from it and
	// finds the application's `node_modules`, exactly as it does for the app.
	const probe = pathToFileURL(join(appModules, '@deepseek-ai', '__resolve-from-app__.js')).href;
	registerHooks({
		resolve(specifier, context, nextResolve) {
			if (specifier.startsWith('@deepseek-ai/')) {
				return nextResolve(specifier, { ...context, parentURL: probe });
			}
			return nextResolve(specifier, context);
		},
	});
}
