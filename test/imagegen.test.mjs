// Unit tests for the generate_image tool: the wire shape each family sends, the
// response parsing that turns provider bytes into durable attachments, the
// content blocks the conversation renders, and every refusal path.
//
// The transport is stubbed, so these tests are offline and deterministic; the
// real attachment store, tool runtime, and endpoint are exercised by
// plugin.integration.test.mjs.
import assert from 'node:assert/strict';
import test from 'node:test';
import { AttachmentError } from '@deepseek-ai/dsh-attachment';
import { DEFAULT_IMAGE_MODEL, MAX_IMAGE_COUNT } from '../lib/image-catalog.js';
import { generateImageContent, imageDimensions, registerGenerateImageTool } from '../lib/imagegen.js';

/** A 2x2 PNG, produced by the same codec the deployment's attachment store uses. */
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVQImWM4ISd3Qk6OAUIBAB8mBBGFRCvEAAAAAElFTkSuQmCC';
/** A 2x2 JPEG, the media type the Flash-Lite image model returns. */
const JPEG_BASE64 = '/9j/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAACAAIDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAACP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AJ0ASY6P/9k=';

/**
 * Build the tool definition the way the plugin registers it, over a fake tools
 * service. The returned definition is the real `defineTool` result, so its
 * argument validation and render callback are the production ones.
 * @param {object} deps - the tool deps.
 * @returns {{definition: object, disposer: () => void}} the registration.
 */
function toolDefinition(deps) {
	let definition;
	const disposer = registerGenerateImageTool({
		tools: {
			register(value) {
				definition = value;
				return () => {};
			},
		},
	}, deps);
	return { definition, disposer };
}

/**
 * A live connection snapshot shaped exactly like the plugin's
 * `currentConnection()`.
 * @param {object} [overrides] - fields to replace.
 * @returns {object} the connection.
 */
function connection(overrides = {}) {
	return {
		displayName: 'Google Vertex AI',
		authMode: 'express',
		endpoint: '',
		region: 'global',
		projectId: '',
		tier: 'standard',
		imageToolEnabled: true,
		imageModel: DEFAULT_IMAGE_MODEL,
		imageAspectRatio: '1:1',
		imageCount: 1,
		resolveApiKey: async () => 'test-api-key',
		...overrides,
	};
}

/**
 * A stub attachment store with the real store's contract: `saveImages` returns
 * references in input order, and the deployment limits are advertised.
 * @param {object} [overrides] - store members to replace.
 * @returns {object} the stub, with the submitted inputs on `saved`.
 */
function stubAttachments(overrides = {}) {
	const saved = [];
	return {
		saved,
		imageLimits: {
			maxImageBytes: 20971520,
			maxImagesPerMessage: 20,
			maxMessageImageBytes: 209715200,
			maxImagePixels: 64000000,
			maxImageDimension: 8192,
			mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
		},
		async saveImages(inputs) {
			return inputs.map((input, index) => {
				saved.push(input);
				return {
					attachmentId: `sha256:test${index}`,
					mediaType: input.mediaType,
					bytes: input.data.byteLength,
					width: 2,
					height: 2,
					...(input.name === undefined ? {} : { name: input.name }),
				};
			});
		},
		imageHostPath: (ref) => `C:\\host\\attachments\\${String(ref.attachmentId).replace(':', '-')}.png`,
		...overrides,
	};
}

/**
 * A stub transport recording every call as `{url, init, body}`.
 * @param {(call: object, index: number) => Response | Promise<Response>} handler - the response per call.
 * @returns {{calls: object[], fetch: typeof fetch}} the recorder and its fetch.
 */
function stubFetch(handler) {
	const calls = [];
	return {
		calls,
		fetch: async (url, init) => {
			const call = { url, init, body: JSON.parse(init.body) };
			calls.push(call);
			return handler(call, calls.length - 1);
		},
	};
}

/**
 * One Gemini success body.
 * @param {object[]} parts - the response parts.
 * @returns {Response} the response.
 */
function geminiOk(parts) {
	return new Response(JSON.stringify({ candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }] }), {
		status: 200,
		headers: { 'content-type': 'application/json' },
	});
}

/** One Gemini inline-image part. */
function inlinePng() {
	return { inlineData: { mimeType: 'image/png', data: PNG_BASE64 } };
}

/**
 * The deps one test runs against.
 * @param {object} facts - the resolved facts.
 * @returns {object} the deps.
 */
function depsFor(facts) {
	return {
		resolveConnection: () => facts.connection,
		resolveAttachments: () => facts.attachments,
		fetch: facts.fetch,
	};
}

test('a Gemini call sends responseModalities, honours the live settings, and returns image blocks', async () => {
	const attachments = stubAttachments();
	const transport = stubFetch(() => geminiOk([{ text: 'Here you go' }, inlinePng()]));
	const { definition } = toolDefinition(depsFor({
		connection: connection({ imageAspectRatio: '16:9', imageCount: 2 }),
		attachments,
		fetch: transport.fetch,
	}));

	const args = { prompt: '  a red circle on white  ' };
	const value = await definition.execute(args, {});

	assert.equal(value.model, DEFAULT_IMAGE_MODEL);
	assert.equal(value.family, 'gemini');
	assert.equal(value.prompt, 'a red circle on white', 'the prompt is trimmed');
	assert.equal(value.aspectRatio, '16:9', 'the live settings supply the aspect ratio');
	assert.equal(value.images.length, 2, 'candidateCount is refused for images, so each image is its own request');
	assert.equal(transport.calls.length, 2);

	const [first] = transport.calls;
	const url = new URL(first.url);
	assert.equal(
		`${url.origin}${url.pathname}`,
		`https://aiplatform.googleapis.com/v1/publishers/google/models/${DEFAULT_IMAGE_MODEL}:generateContent`,
	);
	assert.equal(url.searchParams.get('key'), 'test-api-key');
	assert.equal(first.init.headers.accept, 'application/json');
	assert.equal(first.init.headers['content-type'], 'application/json');
	assert.ok(first.init.headers['user-agent'].length > 0, 'attribution headers ride every request');
	assert.equal(first.init.headers['x-vertex-ai-llm-request-type'], undefined, 'standard tier sends no tier headers');
	assert.deepEqual(first.body, {
		contents: [{ role: 'user', parts: [{ text: 'a red circle on white' }] }],
		generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: '16:9' } },
	});

	assert.equal(attachments.saved.length, 2);
	assert.equal(attachments.saved[0].mediaType, 'image/png');
	assert.equal(attachments.saved[0].data.byteLength, Buffer.from(PNG_BASE64, 'base64').byteLength);
	assert.match(attachments.saved[0].name, /^vertex-gemini-\d+-1\.png$/);

	const blocks = definition.output.render(args, value);
	assert.equal(blocks.length, 3, 'one text envelope, then one block per image');
	assert.equal(blocks[0].type, 'text');
	assert.match(blocks[0].text, new RegExp(`${DEFAULT_IMAGE_MODEL} generated 2 images at 16:9\\.`));
	assert.match(blocks[0].text, /<path>C:\\host\\attachments\\sha256-test0\.png<\/path>/);
	assert.match(blocks[0].text, /image\/png image, 2x2 px, 96 bytes/);
	for (const block of blocks.slice(1)) {
		assert.equal(block.type, 'image');
		assert.equal(block.attachment.mediaType, 'image/png');
		assert.equal(block.attachment.width, 2);
		assert.equal(block.attachment.height, 2);
	}
});

test('an Imagen call batches through :predict sampleCount and keeps the declared media type', async () => {
	const attachments = stubAttachments();
	const transport = stubFetch(() => new Response(JSON.stringify({
		predictions: [
			{ bytesBase64Encoded: PNG_BASE64, mimeType: 'image/png' },
			{ bytesBase64Encoded: JPEG_BASE64, mimeType: 'image/jpeg' },
		],
	}), { status: 200, headers: { 'content-type': 'application/json' } }));
	const { definition } = toolDefinition(depsFor({
		connection: connection({ imageModel: 'imagen-4.0-generate-001' }),
		attachments,
		fetch: transport.fetch,
	}));

	const args = { prompt: 'a blue square', aspect_ratio: '4:3', count: 2 };
	const value = await definition.execute(args, {});

	assert.equal(value.model, 'imagen-4.0-generate-001');
	assert.equal(value.family, 'imagen');
	assert.equal(transport.calls.length, 1, 'Imagen batches natively in one request');
	const url = new URL(transport.calls[0].url);
	assert.equal(url.pathname, '/v1/publishers/google/models/imagen-4.0-generate-001:predict');
	assert.deepEqual(transport.calls[0].body, {
		instances: [{ prompt: 'a blue square' }],
		parameters: { sampleCount: 2, aspectRatio: '4:3' },
	});
	assert.deepEqual(value.images.map((image) => image.mediaType), ['image/png', 'image/jpeg']);
	assert.equal(attachments.saved[1].mediaType, 'image/jpeg', 'the declared media type reaches the store');
	assert.match(attachments.saved[1].name, /\.jpg$/);

	const blocks = generateImageContent(value);
	assert.equal(blocks.length, 3);
	assert.match(blocks[0].text, /image\/jpeg image, 2x2 px/);
});

test('full auth mode sends a bearer token and carries the project into the URL', async () => {
	const transport = stubFetch(() => geminiOk([inlinePng()]));
	const { definition } = toolDefinition(depsFor({
		connection: connection({
			authMode: 'full',
			region: 'us-central1',
			resolveAuth: async () => ({ mode: 'full', accessToken: 'token-1', projectId: 'proj-1' }),
		}),
		attachments: stubAttachments(),
		fetch: transport.fetch,
	}));

	await definition.execute({ prompt: 'a circle' }, {});
	const url = new URL(transport.calls[0].url);
	assert.equal(url.pathname, '/v1/projects/proj-1/locations/us-central1/publishers/google/models/gemini-2.5-flash-image:generateContent');
	assert.equal(url.searchParams.get('key'), null);
	assert.equal(transport.calls[0].init.headers.authorization, 'Bearer token-1');
});

test('a non-standard tier rides the shared request headers, and its endpoint rules still bind', async () => {
	const transport = stubFetch(() => geminiOk([inlinePng()]));
	const { definition } = toolDefinition(depsFor({
		connection: connection({ tier: 'priority' }),
		attachments: stubAttachments(),
		fetch: transport.fetch,
	}));
	await definition.execute({ prompt: 'a circle' }, {});
	assert.equal(transport.calls[0].init.headers['x-vertex-ai-llm-request-type'], 'shared');
	assert.equal(transport.calls[0].init.headers['x-vertex-ai-llm-shared-request-type'], 'priority');

	const flex = toolDefinition(depsFor({
		connection: connection({ tier: 'flex', region: 'us-central1', projectId: 'proj-1' }),
		attachments: stubAttachments(),
		fetch: transport.fetch,
	}));
	await assert.rejects(
		flex.definition.execute({ prompt: 'a circle' }, {}),
		(error) => error.code === 'INVALID_REQUEST' && /Flex PayGo only supports the global endpoint/.test(error.message),
	);
});

test('provider refusals map onto the harness failure taxonomy', async () => {
	const cases = [
		{ status: 429, code: 'RATE_LIMIT', headers: { 'retry-after': '7' } },
		{ status: 401, code: 'AUTH' },
		{ status: 404, code: 'MODEL_NOT_FOUND' },
		{ status: 500, code: 'SERVER' },
		{ status: 400, code: 'INVALID_REQUEST' },
	];
	for (const { status, code, headers } of cases) {
		const transport = stubFetch(() => new Response(JSON.stringify({ error: { message: 'provider said no', status: 'FAILED_PRECONDITION' } }), {
			status,
			headers: { 'content-type': 'application/json', ...headers },
		}));
		const { definition } = toolDefinition(depsFor({
			connection: connection(),
			attachments: stubAttachments(),
			fetch: transport.fetch,
		}));
		await assert.rejects(
			definition.execute({ prompt: 'a circle' }, {}),
			(error) => error.code === code && /provider said no/.test(error.message),
		);
	}
});

test('a tier refusal names the tier setting', async () => {
	const transport = stubFetch(() => new Response(JSON.stringify({ error: { message: 'Flex API is not supported for project: 123 or selected region.' } }), { status: 400 }));
	const { definition } = toolDefinition(depsFor({
		connection: connection({ tier: 'flex' }),
		attachments: stubAttachments(),
		fetch: transport.fetch,
	}));
	await assert.rejects(
		definition.execute({ prompt: 'a circle' }, {}),
		(error) => error.code === 'INVALID_REQUEST'
			&& /Flex API is not supported/.test(error.message)
			&& /select the flex PayGo tier/.test(error.message)
			&& /set tier to "standard"/.test(error.message),
	);
});

test('a text-only answer is reported as no image, not as a silent empty result', async () => {
	const transport = stubFetch(() => geminiOk([{ text: 'I cannot draw that.' }]));
	const { definition } = toolDefinition(depsFor({
		connection: connection(),
		attachments: stubAttachments(),
		fetch: transport.fetch,
	}));
	await assert.rejects(
		definition.execute({ prompt: 'a circle' }, {}),
		(error) => /returned no image/.test(error.message) && /I cannot draw that\./.test(error.message),
	);
});

test('a blocked prompt reports the safety refusal', async () => {
	const transport = stubFetch(() => new Response(JSON.stringify({ promptFeedback: { blockReason: 'SAFETY' } }), { status: 200 }));
	const { definition } = toolDefinition(depsFor({
		connection: connection(),
		attachments: stubAttachments(),
		fetch: transport.fetch,
	}));
	await assert.rejects(
		definition.execute({ prompt: 'a circle' }, {}),
		(error) => /no image/.test(error.message) && /SAFETY/.test(error.message) && /safety filter/.test(error.message),
	);
});

test('an Imagen prediction filtered by RAI is named', async () => {
	const transport = stubFetch(() => new Response(JSON.stringify({ predictions: [{ raiFilteredReason: 'Celebrity likeness' }] }), { status: 200 }));
	const { definition } = toolDefinition(depsFor({
		connection: connection({ imageModel: 'imagen-4.0-generate-001' }),
		attachments: stubAttachments(),
		fetch: transport.fetch,
	}));
	await assert.rejects(
		definition.execute({ prompt: 'a celebrity' }, {}),
		(error) => /prediction without image bytes/.test(error.message) && /Celebrity likeness/.test(error.message),
	);
});

test('attachment refusals become actionable messages', async () => {
	const transport = stubFetch(() => geminiOk([inlinePng()]));
	const attachments = stubAttachments({
		async saveImages() {
			throw new AttachmentError('too big', 'IMAGE_TOO_LARGE');
		},
	});
	const { definition } = toolDefinition(depsFor({ connection: connection(), attachments, fetch: transport.fetch }));
	await assert.rejects(
		definition.execute({ prompt: 'a circle' }, {}),
		(error) => /cannot hold within this deployment's byte limits/.test(error.message),
	);
});

test('the deployment limits refuse a batch before anything is written', async () => {
	const transport = stubFetch(() => geminiOk([inlinePng()]));
	const attachments = stubAttachments({
		imageLimits: {
			maxImageBytes: 16,
			maxImagesPerMessage: 20,
			maxMessageImageBytes: 209715200,
			maxImagePixels: 64000000,
			maxImageDimension: 8192,
			mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
		},
	});
	const { definition } = toolDefinition(depsFor({ connection: connection(), attachments, fetch: transport.fetch }));
	await assert.rejects(
		definition.execute({ prompt: 'a circle' }, {}),
		(error) => /beyond this deployment's 16-byte image limit/.test(error.message),
	);
	assert.equal(attachments.saved.length, 0, 'the refusal happens before any store call');
});

test('a missing credential surfaces as MISSING_CREDENTIAL without a request', async () => {
	const transport = stubFetch(() => {
		throw new Error('the tool must not fetch without a credential');
	});
	const { definition } = toolDefinition(depsFor({
		connection: connection({
			resolveApiKey: async () => {
				const { LlmError } = await import('@deepseek-ai/dsh-llm');
				throw new LlmError('google-cloud: no API key for provider route "vertexai"', 'MISSING_CREDENTIAL');
			},
		}),
		attachments: stubAttachments(),
		fetch: transport.fetch,
	}));
	await assert.rejects(
		definition.execute({ prompt: 'a circle' }, {}),
		(error) => error.code === 'MISSING_CREDENTIAL',
	);
	assert.equal(transport.calls.length, 0);
});

test('argument and setting validation refuses what the provider would reject', async () => {
	const transport = stubFetch(() => geminiOk([inlinePng()]));
	const attachments = stubAttachments();
	const make = (overrides) => {
		const { definition } = toolDefinition(depsFor({
			connection: connection(overrides),
			attachments,
			fetch: transport.fetch,
		}));
		return (args) => definition.execute(args, {});
	};

	await assert.rejects(make()({ prompt: '   ' }, {}), /requires a non-empty prompt/);

	await assert.rejects(
		make()({ prompt: 'a circle', aspect_ratio: '21:9' }, {}),
		(error) => /invalid arguments/.test(error.message),
		'the parameter schema restricts the aspect ratio to the verified set',
	);

	await assert.rejects(
		make({ imageAspectRatio: '21:9' })({ prompt: 'a circle' }, {}),
		(error) => /unsupported aspect ratio "21:9"/.test(error.message) && /imageAspectRatio/.test(error.message),
	);

	await assert.rejects(
		make()({ prompt: 'a circle', count: MAX_IMAGE_COUNT + 1 }, {}),
		(error) => new RegExp(`exceeds the ${MAX_IMAGE_COUNT}-image ceiling`).test(error.message),
	);

	await assert.rejects(
		make({ imageCount: 0 })({ prompt: 'a circle' }, {}),
		(error) => /count must be an integer from 1 through/.test(error.message),
	);

	await assert.rejects(
		make({ imageToolEnabled: false })({ prompt: 'a circle' }, {}),
		(error) => /turned off in the google-cloud settings/.test(error.message),
	);

	await make()({ prompt: 'a circle', model: '  gemini-3.1-flash-lite-image  ' }, {});
	assert.match(new URL(transport.calls.at(-1).url).pathname, /gemini-3\.1-flash-lite-image:generateContent$/);
});

test('imageDimensions reads the headers this tool commits', () => {
	assert.deepEqual(imageDimensions(new Uint8Array(Buffer.from(PNG_BASE64, 'base64'))), { width: 2, height: 2 });
	assert.deepEqual(imageDimensions(new Uint8Array(Buffer.from(JPEG_BASE64, 'base64'))), { width: 2, height: 2 });
	assert.equal(imageDimensions(new Uint8Array([1, 2, 3])), undefined);
});

test('registration exposes one validate-able definition and its disposer', () => {
	const { definition, disposer } = toolDefinition(depsFor({
		connection: connection(),
		attachments: stubAttachments(),
		fetch: stubFetch(() => geminiOk([inlinePng()])).fetch,
	}));
	assert.equal(definition.name, 'generate_image');
	assert.equal(definition.parameters.type, 'object');
	assert.deepEqual(definition.parameters.required, ['prompt']);
	assert.deepEqual(definition.parameters.properties.aspect_ratio.enum, ['1:1', '16:9', '9:16', '4:3', '3:4']);
	assert.equal(definition.parameters.properties.count.type, 'integer');
	assert.equal(typeof definition.output.render, 'function');
	assert.equal(typeof definition.presentCall, 'function');
	assert.equal(typeof disposer, 'function');
});

console.log('imagegen.test.mjs: all assertions passed');
