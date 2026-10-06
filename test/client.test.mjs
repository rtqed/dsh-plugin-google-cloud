// The client bundle against this runtime's slot and settings contracts.
//
// `lib/client.js` is a browser bundle loaded through `window.__ModuleLoader__`,
// so this file stands in for the loader, React, and the two client services the
// bundle consumes: it proves the module id, the required services, the slots it
// registers (and their keys), and that the card renders from the namespace scope
// it binds.
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

/**
 * One bound namespace scope, as the settings service hands it to a card.
 * @param {object} snapshot - the snapshot the scope reports.
 * @returns {object} the scope stand-in.
 */
function fakeScope(snapshot) {
	return {
		getSnapshot: () => snapshot,
		subscribe: () => () => {},
		mutate: async () => true,
	};
}

/**
 * The members `apply` reads from its context, capturing every registration.
 * @param {object} scope - the scope `bind()` resolves to.
 * @returns {object} the context stand-in plus its capture arrays.
 */
function fakeCtx(scope) {
	const bound = [];
	const injected = [];
	const registrations = [];
	return {
		bound,
		injected,
		registrations,
		settingsScope: {
			bind: (spec) => {
				bound.push(spec);
				return scope;
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
	};
}

test('the bundle registers under the package name and requires the current services', () => {
	assert.equal(loaded.spec.id, 'dsh-plugin-google-cloud');
	const exported = loaded.spec.factory((specifier) => {
		if (specifier === 'react') return reactShim;
		if (specifier === 'react/jsx-runtime') return jsxRuntimeShim;
		throw new Error(`unexpected require: ${specifier}`);
	});
	assert.equal(typeof exported.apply, 'function');
	assert.deepEqual(exported.inject, ['slots', 'remote', 'remote.credentials', 'settingsScope']);
});

test('apply() binds the namespace scope and registers both cards', () => {
	const exported = loaded.spec.factory((specifier) => (specifier === 'react' ? reactShim : jsxRuntimeShim));

	const snapshot = {
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
	};
	const scope = fakeScope(snapshot);
	const ctx = fakeCtx(scope);

	exported.apply(ctx);

	assert.deepEqual(ctx.bound, [{ namespace: 'google-cloud' }], 'the namespace drives the bound scope');
	assert.deepEqual(ctx.injected, ['settings.plugin.item', 'settings.models.provider-card']);
	assert.equal(ctx.registrations.length, 2);

	const card = ctx.registrations.find((entry) => entry.options.name === 'settings.plugin.item');
	assert.equal(card.options.key, 'google-cloud', 'the card is keyed by the namespace it edits');
	assert.equal(card.options.inject().scope, scope);
	assert.equal(card.options.inject().ctx, ctx);

	const models = ctx.registrations.find((entry) => entry.options.name === 'settings.models.provider-card');
	assert.equal(models.options.key, 'google-cloud', 'the models card is keyed by the settings namespace');
	assert.equal(typeof models.component, 'function');

	// The card renders from the bound snapshot, and its body holds every field.
	rendering.hooks = [];
	rendering.index = 0;
	const rendered = card.component({ ...card.options.inject() });
	assert.equal(rendered.type, 'div');
	assert.match(rendered.props.className, /dsh-gc-card/);

	// The card renders its body only while the disclosure is open. The shim keeps
	// hook state by index, so seed the open flag and render again: that yields the
	// body component, which is where every field lives.
	rendering.hooks = [true];
	rendering.index = 0;
	const opened = card.component({ ...card.options.inject() });
	const body = flatten(opened).find((element) => typeof element.type === 'function');
	assert.ok(body, 'the disclosure renders the configuration form');

	rendering.hooks = [];
	rendering.index = 0;
	// The image-generation controls live on this card, and the stored values
	// reach them exactly as the settings section resolved them.
	const elements = flatten(body.type(body.props));
	const labels = elements
		.filter((element) => element.type === 'span' && typeof element.props.className === 'string' && element.props.className.includes('dsh-gc-field-label'))
		.map((element) => element.props.children);
	assert.ok(labels.includes('图像生成工具 (generate_image)'), 'the image field is on the card');

	const checkbox = elements.find((element) => element.type === 'input' && element.props.type === 'checkbox');
	assert.equal(checkbox.props.checked, true, 'the tool ships enabled');

	// The form carries several dropdowns (region among them), so each image
	// control is identified by the choice set it offers, not by position.
	const selects = elements.filter((element) => element.type === 'select');
	const modelSelect = selects.find((element) => element.props.children.some((option) => option.props.value === DEFAULT_IMAGE_MODEL));
	assert.ok(modelSelect, 'the image model dropdown is on the card');
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

test('the card reports settings a page cannot reach instead of rendering undefined values', () => {
	const exported = loaded.spec.factory((specifier) => (specifier === 'react' ? reactShim : jsxRuntimeShim));
	const scope = fakeScope({ status: 'unavailable', value: undefined, revision: undefined, writable: false, mode: 'memory' });
	const ctx = fakeCtx(scope);

	exported.apply(ctx);

	rendering.hooks = [];
	rendering.index = 0;
	const card = ctx.registrations[0].component(ctx.registrations[0].options.inject());
	assert.equal(card.type, 'p');
	assert.match(card.props.children, /无法读写本机配置/);
});

console.log('client.test.mjs: all assertions passed');
