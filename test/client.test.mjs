// The client bundle against the current slot and configuration contracts.
//
// `lib/client.js` is a browser bundle loaded through `window.__ModuleLoader__`,
// so this file stands in for the loader, React, and the two client services the
// bundle consumes: it proves the module id, the required services, the slots it
// registers (and their keys), and that the migrated card renders from the shared
// config-form snapshot.
import assert from 'node:assert/strict';
import test from 'node:test';

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

test('apply() registers the row configuration page and the models card', () => {
	const exported = loaded.spec.factory((specifier) => (specifier === 'react' ? reactShim : jsxRuntimeShim));

	const controller = {
		getSnapshot: () => ({ status: 'ready', value: { authMode: 'express', region: 'global', tier: 'standard' }, revision: 3, writable: true }),
		subscribe: () => () => {},
		mutate: async () => true,
	};
	const requestedNamespaces = [];
	const watched = [];
	const injected = [];
	const registrations = [];
	const effects = [];
	const ctx = {
		fiber: { entry: { options: { id: 'google-cloud' } } },
		configForms: {
			get: (ns) => {
				requestedNamespaces.push(ns);
				return controller;
			},
			whileServed: (namespaces, register) => {
				watched.push(namespaces);
				return register(new Set(namespaces));
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

	exported.apply(ctx);

	assert.deepEqual(requestedNamespaces, ['google-cloud'], 'the entry namespace drives the form controller');
	assert.equal(watched.length, 2, 'both pages wait until the host serves the namespace');
	assert.ok(watched.every((namespaces) => namespaces.length === 1 && namespaces[0] === 'google-cloud'));
	assert.deepEqual(injected, ['plugins.row.config', 'settings.models.provider-card']);
	assert.equal(registrations.length, 2);

	const row = registrations.find((entry) => entry.options.name === 'plugins.row.config');
	assert.deepEqual(row.options.key, 'dsh-plugin-google-cloud#google-cloud', 'the row key is <package>#<row id>');
	assert.equal(row.options.inject().scope, controller);
	assert.equal(row.options.inject().ctx, ctx);

	const models = registrations.find((entry) => entry.options.name === 'settings.models.provider-card');
	assert.equal(models.options.key, 'google-cloud', 'the models card is keyed by the settings namespace');
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

	const page = row.component({ ...row.options.inject(), view: 'page' });
	assert.equal(page.type, 'div');
	assert.match(page.props.className, /dsh-gc-card/);
});

test('the card reports a page that cannot reach host configuration instead of rendering undefined values', () => {
	const exported = loaded.spec.factory((specifier) => (specifier === 'react' ? reactShim : jsxRuntimeShim));
	const controller = {
		getSnapshot: () => ({ status: 'unavailable', value: undefined, revision: undefined, writable: false, mode: 'memory' }),
		subscribe: () => () => {},
		mutate: async () => false,
	};
	const registered = [];
	const ctx = {
		fiber: { entry: { options: { id: 'google-cloud' } } },
		configForms: {
			get: () => controller,
			whileServed: (namespaces, register) => register(new Set(namespaces)),
		},
		slots: {
			inject: (name, body) => {
				const iterator = body();
				iterator.next();
				return () => {};
			},
			register: (options, component) => {
				registered.push({ options, component });
				return () => {};
			},
		},
		effect: (body) => body(),
	};
	exported.apply(ctx);

	rendering.hooks = [];
	rendering.index = 0;
	const page = registered[0].component({ ...registered[0].options.inject(), view: 'page' });
	assert.equal(page.type, 'p');
	assert.match(page.props.children, /无法读写本机配置/);
});

console.log('client.test.mjs: all assertions passed');
