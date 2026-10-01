// endpoint.js unit tests: region/project endpoint derivation matrix.
import assert from 'node:assert/strict';
import { GLOBAL_ENDPOINT, endpointFor } from '../lib/endpoint.js';

// 1. Global is the default and normalizes case/whitespace.
assert.equal(endpointFor({}), GLOBAL_ENDPOINT);
assert.equal(endpointFor({ region: 'global' }), GLOBAL_ENDPOINT);
assert.equal(endpointFor({ region: ' GLOBAL ' }), GLOBAL_ENDPOINT);
assert.equal(endpointFor({ region: 'global', projectId: 'ignored' }), GLOBAL_ENDPOINT, 'global needs no project');

// 2. Concrete regions put the project in the path and keep ?key= auth upstream.
assert.equal(
	endpointFor({ region: 'us-central1', projectId: 'vertex-proj' }),
	'https://us-central1-aiplatform.googleapis.com/v1/projects/vertex-proj/locations/us-central1',
);
assert.equal(
	endpointFor({ region: 'Europe-West4', projectId: 'vertex-proj' }),
	'https://europe-west4-aiplatform.googleapis.com/v1/projects/vertex-proj/locations/europe-west4',
	'region ids normalize to lowercase',
);

// 3. Multi-region hosts follow Google's regional/multi-region host pattern.
assert.equal(
	endpointFor({ region: 'us', projectId: 'vertex-proj' }),
	'https://aiplatform.us.rep.googleapis.com/v1/projects/vertex-proj/locations/us',
);
assert.equal(
	endpointFor({ region: 'eu', projectId: 'vertex-proj' }),
	'https://aiplatform.eu.rep.googleapis.com/v1/projects/vertex-proj/locations/eu',
);

// 4. Non-global regions without a projectId fail loud, naming the setting.
assert.throws(
	() => endpointFor({ region: 'us-central1' }),
	(error) => error.code === 'INVALID_REQUEST' && /projectId/.test(error.message),
);

// 5. An explicit endpoint override wins and never requires a project.
assert.equal(endpointFor({ endpoint: 'https://proxy.example.com/v1/', region: 'us-central1' }), 'https://proxy.example.com/v1');

console.log('endpoint.test.mjs: all assertions passed');
