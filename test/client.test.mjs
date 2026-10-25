// The client bundle against the current slot and configuration contracts.
//
// `lib/client.js` is a browser bundle loaded through `window.__ModuleLoader__`,
// so this file stands in for the loader, React, and the two client services the
// bundle consumes: it proves the module id, the required services, the slots it
// registers (and their keys), and that the migrated card renders from the shared
// config-form snapshot.
import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_IMAGE_MODEL, IMAGE_ASPECT_RATIOS, IMAGE_MODELS, MAX_IMAGE_COUNT } from '../lib/image-catalog.js';

/**
 * Flatten a shim-rendered element tree into its element list.
 * @param {unknown} node - one rendered node.
 * @param {object[]} [out] - accumulator.
 * @returns {object[]} every element in render order.
 */
function flatten(node, out = []) {
	if (node === null || node === undefined || typeof node === 'boolean') return out;
	if (Array.isArray(node)) {
		for (const child of node) flatten(child, out);
		return out;
	}
	if (typeof node === 'object' && node.type !== undefined) {
		out.push(node);
		flatten(node.props?.children, out);
	}
	return out;
}

/** Minimal React shim: the bundle only needs the hooks and the jsx factories. */
const rendering = { hooks: [], index: 0 };
function useState(initial) {
	const index = rendering.index++;
	if (!(index in rendering.hooks)) {
		rendering.hooks[index] = typeof initial === 'function' ? initial() : initial;
	}
	return [rendering.hooks[index], (next) => {
		rendering.hooks[index] = typeof next === 'function' ? next(rendering.hooks[index]) : next;
	}];
}
function useEffect(effect) {
	const dispose = effect();
	if (typeof dispose === 'function') dispose();
}
const reactShim = {
	useState,
	useEffect,
	useCallback: (fn) => fn,
	useMemo: (fn) => fn(),
	useRef: (initial) => ({ current: initial }),
};
const jsxRuntimeShim = {
	Fragment: Symbol('Fragment'),
	jsx: (type, props, key) => ({ type, props, key }),
	jsxs: (type, props, key) => ({ type, props, key }),
};

const loaded = {};
globalThis.window = {
	__ModuleLoader__: {
		load(spec) {
			loaded.spec = spec;
		},
	},
};
globalThis.document = undefined;

await import('../lib/client.js');
/** Let the mirror subscription settle before asserting on what was installed. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * A settings-mirror stub: the snapshot the entry reads served namespaces from, the
 * subscription it follows, and a setter that replays a later host answer.
 * @param namespaces - namespaces the host serves at first.
 * @returns the mirror stub plus its mutation helper.
 */
function mirrorOf(namespaces) {
	let current = [...namespaces];
	const listeners = [];
	return {
		listeners,
		ensure: () => {},
		getSnapshot: () => ({
			status: current.length === 0 ? 'idle' : 'ready',
			view: current.length === 0 ? undefined : { namespaces: current.map((ns) => ({ ns })) },
			error: null,
		}),
		subscribe: (listener) => {
			listeners.push(listener);
			return () => {
				const index = listeners.indexOf(listener);
				if (index >= 0) listeners.splice(index, 1);
			};
		},
		set(next) {
			current = [...next];
			for (const listener of [...listeners]) listener();
		},
	};
}

/** A ready config-form controller with the stored values the card renders. */
const readyController = () => ({
	getSnapshot: () => ({
		status: 'ready',
		value: {
			authMode: 'express',
			region: 'global',
			tier: 'standard',
			imageToolEnabled: true,
			imageModel: 'gemini-3-pro-image',
			imageAspectRatio: '16:9',
			imageCount: 2,
		},
		revision: 3,
		writable: true,
	}),
	subscribe: () => () => {},
	mutate: async () => true,
});

/**
 * A client context stub covering the services the entry touches.
 * @param options - the mount id, the mirror, the controller, and the served set the
 *   `whileServed` stub reports (defaults to everything it was asked about).
 * @returns the context plus the recording arrays the assertions read.
 */
function clientContext({ entryId = 'google-cloud', mirror, controller = readyController(), served }) {
	const requestedNamespaces = [];
	const watched = [];
	const injected = [];
	const registrations = [];
	const effects = [];
	const ctx = {
		fiber: { entry: { options: { id: entryId } } },
		configForms: {
			describe: () => mirror,
			get: (ns) => {
				requestedNamespaces.push(ns);
				return controller;
			},
			whileServed: (namespaces, register) => {
				watched.push(namespaces);
				return register(served ?? new Set(namespaces));
			},
		},
		slots: {
			inject: (name, body) => {
				injected.push(name);
				const iterator = body();
				iterator.next();
				return () => {};
			},
			register: (options, component) => {
				registrations.push({ options, component });
				return () => {};
			},
		},
		effect: (body, label) => {
			effects.push(label);
			return body();
		},
	};
	return { ctx, requestedNamespaces, watched, injected, registrations, effects };
}

test('the bundle registers under the package name and requires the current services', () => {
	assert.equal(loaded.spec.id, 'dsh-plugin-google-cloud');
	const exported = loaded.spec.factory((specifier) => {
		if (specifier === 'react') return reactShim;
		if (specifier === 'react/jsx-runtime') return jsxRuntimeShim;
		throw new Error(`unexpected require: ${specifier}`);
	});
	assert.equal(typeof exported.apply, 'function');
	assert.deepEqual(exported.inject, ['slots', 'remote', 'remote.credentials', 'configForms']);
	assert.ok(!exported.inject.includes('settingsScope'), 'the removed service must not be required');
});

test('apply() keys both cards by the namespace the host serves, not by a guessed id', async () => {
	const exported = loaded.spec.factory((specifier) => (specifier === 'react' ? reactShim : jsxRuntimeShim));
	// The row a user-plugin loader inserted carries an id it generated itself, so the
	// bundle's own ids never name it: only the mirror's served list does.
	const servedNs = 'tavern-user-plugin-dsh-plugin-google-cloud';
	const mirror = mirrorOf(['llm-deepseek', servedNs]);
	const { ctx, requestedNamespaces, watched, injected, registrations, effects } = clientContext({
		entryId: 'dsh-plugin-google-cloud',
		mirror,
		served: new Set([servedNs]),
	});

	exported.apply(ctx);
	await flush();

	assert.deepEqual(effects, ['dsh-plugin-google-cloud: settings surfaces']);
	assert.deepEqual(watched, [[servedNs, 'google-cloud', 'dsh-plugin-google-cloud']]);
	assert.deepEqual(requestedNamespaces, [servedNs], 'the controller is the served namespace\'s, never a guessed one');
	assert.deepEqual(injected, ['plugins.row.config', 'settings.models.provider-card']);
	assert.equal(registrations.length, 2);

	const row = registrations.find((entry) => entry.options.name === 'plugins.row.config');
	assert.equal(row.options.key, `dsh-plugin-google-cloud#${servedNs}`, 'the row key is <package>#<row id>');
	assert.equal(row.options.inject().scope, ctx.configForms.get(servedNs));
	assert.equal(row.options.inject().ctx, ctx);

	const models = registrations.find((entry) => entry.options.name === 'settings.models.provider-card');
	assert.equal(models.options.key, servedNs, 'the models card is keyed by the served settings namespace');
	assert.equal(typeof models.component, 'function');

	// The migrated card renders from the shared snapshot: `summary` is one line,
	// and the page view reads the same controller.
	rendering.hooks = [];
	rendering.index = 0;
	const summary = row.component({ ...row.options.inject(), view: 'summary' });
	assert.equal(summary.type, 'span');
	assert.match(summary.props.children, /Google Cloud Vertex AI/);
	assert.match(summary.props.children, /快速模式 \(Key\)/);
	assert.match(summary.props.children, /区域 global/);
	assert.match(summary.props.children, /档位 standard/);

	rendering.hooks = [];
	rendering.index = 0;
	const page = row.component({ ...row.options.inject(), view: 'page' });
	assert.equal(page.type, 'div');
	assert.match(page.props.className, /dsh-gc-card/);

	// The card renders its body only while the disclosure is open. The shim keeps
	// hook state by index, so seed the open flag and render the page again: that
	// yields the body component, which is where every field lives.
	rendering.hooks = [true];
	rendering.index = 0;
	const opened = row.component({ ...row.options.inject(), view: 'page' });
	const body = flatten(opened).find((element) => typeof element.type === 'function');
	assert.ok(body, 'the disclosure renders the configuration form');

	rendering.hooks = [];
	rendering.index = 0;
	// The image-generation controls live on this page, and the stored values
	// reach them exactly as the schema resolved them.
	const elements = flatten(body.type(body.props));
	const labels = elements
		.filter((element) => element.type === 'span' && typeof element.props.className === 'string' && element.props.className.includes('dsh-gc-field-label'))
		.map((element) => element.props.children);
	assert.ok(labels.includes('图像生成工具 (generate_image)'), 'the image field is on the page');

	const checkbox = elements.find((element) => element.type === 'input' && element.props.type === 'checkbox');
	assert.equal(checkbox.props.checked, true, 'the tool ships enabled');

	// The form carries several dropdowns (region among them), so each image
	// control is identified by the choice set it offers, not by position.
	const selects = elements.filter((element) => element.type === 'select');
	const modelSelect = selects.find((element) => element.props.children.some((option) => option.props.value === DEFAULT_IMAGE_MODEL));
	assert.ok(modelSelect, 'the image model dropdown is on the page');
	assert.equal(modelSelect.props.value, 'gemini-3-pro-image', 'the stored image model is selected');
	assert.deepEqual(
		modelSelect.props.children.map((option) => option.props.value),
		IMAGE_MODELS.map((model) => model.id),
		'every catalog image model is offered',
	);

	const aspectSelect = selects.find((element) =>
		element.props.children.length === IMAGE_ASPECT_RATIOS.length
		&& element.props.children.every((option, index) => option.props.value === IMAGE_ASPECT_RATIOS[index]),
	);
	assert.ok(aspectSelect, 'the aspect-ratio dropdown offers exactly the verified ratios');
	assert.equal(aspectSelect.props.value, '16:9', 'the stored aspect ratio is selected');

	const count = elements.find((element) =>
		element.type === 'input' && element.props.type === 'number' && Number(element.props.max) === MAX_IMAGE_COUNT,
	);
	assert.ok(count, 'the batch-size control caps at the deployment limit');
	assert.equal(Number(count.props.value), 2, 'the stored count reaches the control');
	assert.equal(Number(count.props.min), 1);
});

test('the entry follows the mirror from empty to served, and installs once when the set settles', async () => {
	const exported = loaded.spec.factory((specifier) => (specifier === 'react' ? reactShim : jsxRuntimeShim));
	const servedNs = 'tavern-user-plugin-dsh-plugin-google-cloud';
	const mirror = mirrorOf([]);
	const { ctx, registrations, watched } = clientContext({
		entryId: 'dsh-plugin-google-cloud',
		mirror,
		served: new Set([servedNs]),
	});

	exported.apply(ctx);
	await flush();
	assert.equal(watched.length, 1, 'an empty mirror still installs a watch on the ids this bundle names');
	assert.equal(registrations.length, 0, 'nothing is registered while no namespace is served');

	// The host answers later, exactly as the shared describe read settles after boot.
	mirror.set(['llm-deepseek', servedNs]);
	assert.deepEqual(watched.at(-1), [servedNs, 'google-cloud', 'dsh-plugin-google-cloud']);
	assert.equal(registrations.length, 2, 'the served namespace keys both cards');
	assert.equal(registrations.find((entry) => entry.options.name === 'settings.models.provider-card').options.key, servedNs);

	// A second identical answer changes nothing.
	mirror.set(['llm-deepseek', servedNs]);
	assert.equal(registrations.length, 2, 'the installed key set is not re-registered');
});

test('a bundle mount keeps the ids it already named', async () => {
	const exported = loaded.spec.factory((specifier) => (specifier === 'react' ? reactShim : jsxRuntimeShim));
	const mirror = mirrorOf(['llm-deepseek', 'google-cloud']);
	const { ctx, watched, registrations } = clientContext({
		// The client Loader names the entry it creates for a bundle mount with a
		// generated id; the patch's row id is the one the host serves.
		entryId: '253304e5',
		mirror,
		served: new Set(['google-cloud']),
	});

	exported.apply(ctx);
	await flush();

	assert.deepEqual(watched, [['google-cloud', '253304e5']], 'the mirror answer adds no id the bundle already named');
	assert.equal(registrations.length, 2);
	assert.equal(registrations.find((entry) => entry.options.name === 'settings.models.provider-card').options.key, 'google-cloud');
	assert.equal(registrations.find((entry) => entry.options.name === 'plugins.row.config').options.key, 'dsh-plugin-google-cloud#google-cloud');
});

test('the card reports a page that cannot reach host configuration instead of rendering undefined values', async () => {
	const exported = loaded.spec.factory((specifier) => (specifier === 'react' ? reactShim : jsxRuntimeShim));
	const controller = {
		getSnapshot: () => ({ status: 'unavailable', value: undefined, revision: undefined, writable: false, mode: 'memory' }),
		subscribe: () => () => {},
		mutate: async () => false,
	};
	const { ctx, registrations } = clientContext({
		entryId: 'google-cloud',
		mirror: mirrorOf(['google-cloud']),
		controller,
		served: new Set(['google-cloud']),
	});
	exported.apply(ctx);
	await flush();

	rendering.hooks = [];
	rendering.index = 0;
	const page = registrations[0].component({ ...registrations[0].options.inject(), view: 'page' });
	assert.equal(page.type, 'p');
	assert.match(page.props.children, /无法读写本机配置/);
});

console.log('client.test.mjs: all assertions passed');
