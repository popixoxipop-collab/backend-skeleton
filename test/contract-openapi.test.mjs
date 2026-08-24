// A1: pure unit tests for contracts/openapi.mjs -- no git repo, no CLI, no real filesystem
// except loadOpenApiDocument's own file-reading tests (temp files only).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import {
	loadOpenApiDocument, indexOpenApiDocument, inferPathPrefix, reconcileModule,
	normalizeRoute, OPERATION_ID_RE, PATH_PREFIX_RE,
	inlineSchema, COMPONENT_SCHEMA_NAME_RE, SCHEMA_PROPERTY_NAME_RE,
	snapshotFromReconciliation, hasBskelExportMarker, BSKEL_PASSTHROUGH_EXTENSION, BSKEL_GENERATED_EXTENSION,
	RESPONSE_STATUS_KEY_RE, MEDIA_TYPE_RE, PER_STATUS_NO_DESCRIPTION_STANDIN,
} from '../contracts/openapi.mjs';
import { BARE_UUID_PATTERN } from '../contracts/emit.mjs';

function writeTempDoc(doc) {
	const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-openapi-')), 'api-docs.json');
	fs.writeFileSync(file, JSON.stringify(doc));
	return file;
}

function oneControllerModule(endpoints) {
	return { module: 'x', controllers: [{ className: 'X', basePath: '/', file: null, endpoints }] };
}

// --- indexing ---

test('indexing ignores non-verb keys (parameters/summary/description) and $ref path items', () => {
	const doc = {
		paths: {
			'/api/v0/widgets': {
				parameters: [{ name: 'x' }],
				summary: 'ignored',
				get: { operationId: 'findWidgets' },
			},
			'/api/v0/refd': { $ref: '#/components/pathItems/Refd' },
		},
	};
	const indexed = indexOpenApiDocument(doc);
	assert.equal(indexed.ok, true);
	assert.equal(indexed.stats.path_count, 1, 'the $ref path item must not count as a real path');
	assert.equal(indexed.stats.operation_count, 1);
	assert.equal(indexed.stats.skipped_path_refs, 1);
	assert.ok(indexed.byOperationId.has('findWidgets'));
});

// --- prefix inference ---

test('inferPathPrefix: a single consistent delta across anchors is inferred', () => {
	const result = inferPathPrefix(['/api/v0', '/api/v0', '/api/v0']);
	assert.equal(result.value, '/api/v0');
	assert.equal(result.origin, 'inferred');
	assert.deepEqual(result.deltas, { '/api/v0': 3 });
	assert.deepEqual(result.conflicting, []);
});

test('inferPathPrefix: conflicting deltas refuse to guess', () => {
	const result = inferPathPrefix(['/api/v0', '/api/v1']);
	assert.equal(result.value, null);
	assert.equal(result.origin, 'none');
	assert.deepEqual(result.conflicting.sort(), ['/api/v0', '/api/v1']);
});

test('inferPathPrefix: no anchors is origin:none, not an error', () => {
	const result = inferPathPrefix([]);
	assert.equal(result.value, null);
	assert.equal(result.origin, 'none');
	assert.deepEqual(result.deltas, {});
});

test('reconcileModule: an explicit pathPrefix overrides inference (origin:flag), even with conflicting anchors', () => {
	const doc = {
		paths: {
			'/api/v0/a': { get: { operationId: 'opA' } },
			'/api/v1/b': { get: { operationId: 'opB' } },
		},
	};
	const indexed = indexOpenApiDocument(doc);
	const module = oneControllerModule([
		{ verb: 'GET', path: '/a', operationId: 'opA', method: 'a' },
		{ verb: 'GET', path: '/b', operationId: 'opB', method: 'b' },
	]);
	const recon = reconcileModule({ index: indexed, module, pathPrefix: '/api/v0' });
	assert.equal(recon.prefix.value, '/api/v0');
	assert.equal(recon.prefix.origin, 'flag');
});

test('segment-boundary safety: a scan path is never treated as a suffix of an unrelated longer path', () => {
	const doc = {
		paths: {
			'/api/v0/organizations': { get: { operationId: 'findOrganizations' } }, // anchor
			'/api/v0/suborganizations': { get: { operationId: 'findSuborgs' } },
		},
	};
	const indexed = indexOpenApiDocument(doc);
	const module = oneControllerModule([
		{ verb: 'GET', path: '/organizations', operationId: 'findOrganizations', method: 'findOrganizations' },
		{ verb: 'GET', path: '/organizations', operationId: null, method: 'somethingElse' }, // won't matter, just needs an unmatched entry
	]);
	const recon = reconcileModule({ index: indexed, module, pathPrefix: null });
	assert.equal(recon.prefix.value, '/api/v0');
	// '/api/v0/suborganizations' must not have contributed a bogus delta -- only one distinct
	// delta value should exist, from the real anchor.
	assert.deepEqual(Object.keys(recon.prefix.deltas), ['/api/v0']);
});

// --- resolution kinds ---

test('matched: operationId agrees, path differs only by the inferred prefix', () => {
	const doc = { paths: { '/api/v0/organizations/{id}': { get: { operationId: 'findOrganization' } } } };
	const indexed = indexOpenApiDocument(doc);
	const module = oneControllerModule([{ verb: 'GET', path: '/organizations/{id}', operationId: 'findOrganization', method: 'findOrganization' }]);
	const recon = reconcileModule({ index: indexed, module, pathPrefix: '/api/v0' });
	const result = recon.byEndpoint.get('0:0');
	assert.equal(result.kind, 'matched');
	assert.equal(result.path, '/api/v0/organizations/{id}');
	assert.equal(result.scanPath, '/organizations/{id}');
});

test('drift(verb): operationId agrees, verb disagrees -- not resolved, reported', () => {
	const doc = { paths: { '/api/v0/widgets/{id}': { post: { operationId: 'findWidget' } } } };
	const indexed = indexOpenApiDocument(doc);
	const module = oneControllerModule([{ verb: 'GET', path: '/widgets/{id}', operationId: 'findWidget', method: 'findWidget' }]);
	const recon = reconcileModule({ index: indexed, module, pathPrefix: '/api/v0' });
	const result = recon.byEndpoint.get('0:0');
	assert.equal(result.kind, 'drift');
	assert.equal(result.reason, 'verb');
	assert.equal(result.openapi.verb, 'POST');
});

test('drift(path): operationId and verb agree, path disagrees in a way the prefix cannot explain', () => {
	const doc = { paths: { '/totally/unrelated': { get: { operationId: 'findWidget' } } } };
	const indexed = indexOpenApiDocument(doc);
	const module = oneControllerModule([{ verb: 'GET', path: '/widgets/{id}', operationId: 'findWidget', method: 'findWidget' }]);
	const recon = reconcileModule({ index: indexed, module, pathPrefix: '/api/v0' });
	const result = recon.byEndpoint.get('0:0');
	assert.equal(result.kind, 'drift');
	assert.equal(result.reason, 'path');
});

test('missing: scan operationId is not in the document anywhere', () => {
	const doc = { paths: {} };
	const indexed = indexOpenApiDocument(doc);
	const module = oneControllerModule([{ verb: 'GET', path: '/ghosts/{id}', operationId: 'findGhost', method: 'findGhost' }]);
	const recon = reconcileModule({ index: indexed, module, pathPrefix: '/api/v0' });
	assert.equal(recon.byEndpoint.get('0:0').kind, 'missing');
});

test('adopted: unmatched endpoint resolves to a single OpenAPI operation that HAS an operationId', () => {
	const doc = { paths: { '/api/v0/widgets': { post: { operationId: 'createWidget' } } } };
	const indexed = indexOpenApiDocument(doc);
	const module = oneControllerModule([{ verb: 'POST', path: '/widgets', operationId: null, method: 'createWidget' }]);
	const recon = reconcileModule({ index: indexed, module, pathPrefix: '/api/v0' });
	const result = recon.byEndpoint.get('0:0');
	assert.equal(result.kind, 'adopted');
	assert.equal(result.operationId, 'createWidget');
});

test('unresolved(document-missing-operation-id): single route match, but that OpenAPI operation has no operationId itself', () => {
	const doc = { paths: { '/api/v0/gadgets': { post: {} } } };
	const indexed = indexOpenApiDocument(doc);
	const module = oneControllerModule([{ verb: 'POST', path: '/gadgets', operationId: null, method: 'createGadget' }]);
	const recon = reconcileModule({ index: indexed, module, pathPrefix: '/api/v0' });
	const result = recon.byEndpoint.get('0:0');
	assert.equal(result.kind, 'unresolved');
	assert.equal(result.reason, 'document-missing-operation-id');
});

test('unresolved(no-candidate): unmatched endpoint has no route match at all', () => {
	const doc = { paths: {} };
	const indexed = indexOpenApiDocument(doc);
	const module = oneControllerModule([{ verb: 'GET', path: '/nothing', operationId: null, method: 'nothing' }]);
	const recon = reconcileModule({ index: indexed, module, pathPrefix: '/api/v0' });
	assert.equal(recon.byEndpoint.get('0:0').kind, 'unresolved');
	assert.equal(recon.byEndpoint.get('0:0').reason, 'no-candidate');
});

test('unresolved(prefix-inconclusive): unmatched endpoint, but no prefix could be inferred and none was given', () => {
	const doc = { paths: {} };
	const indexed = indexOpenApiDocument(doc);
	const module = oneControllerModule([{ verb: 'GET', path: '/nothing', operationId: null, method: 'nothing' }]);
	const recon = reconcileModule({ index: indexed, module, pathPrefix: null }); // no anchors, no flag
	assert.equal(recon.byEndpoint.get('0:0').kind, 'unresolved');
	assert.equal(recon.byEndpoint.get('0:0').reason, 'prefix-inconclusive');
});

test('ambiguous: an unmatched endpoint matches both a prefixed and a bare candidate -- never guessed', () => {
	const doc = {
		paths: {
			'/api/v0/reports': { get: { operationId: 'findReportsPrefixed' } },
			'/reports': { get: { operationId: 'findReportsBare' } },
			'/api/v0/anchor': { get: { operationId: 'anchorOp' } },
		},
	};
	const indexed = indexOpenApiDocument(doc);
	const module = oneControllerModule([
		{ verb: 'GET', path: '/anchor', operationId: 'anchorOp', method: 'anchor' },
		{ verb: 'GET', path: '/reports', operationId: null, method: 'reports' },
	]);
	const recon = reconcileModule({ index: indexed, module, pathPrefix: null });
	const result = recon.byEndpoint.get('0:1');
	assert.equal(result.kind, 'ambiguous');
	assert.equal(result.candidates.length, 2);
});

// --- prototype-pollution safety ---

test('OPERATION_ID_RE rejects __proto__ (leading underscore) but not constructor/toString (letters only)', () => {
	assert.equal(OPERATION_ID_RE.test('__proto__'), false);
	assert.equal(OPERATION_ID_RE.test('constructor'), true);
	assert.equal(OPERATION_ID_RE.test('toString'), true);
});

test('a document with __proto__/constructor operationIds indexes safely into Maps, no prototype pollution', () => {
	const doc = {
		paths: {
			'/a': { get: { operationId: '__proto__' } },
			'/b': { get: { operationId: 'constructor' } },
		},
	};
	const indexed = indexOpenApiDocument(doc);
	assert.equal(indexed.byOperationId.has('__proto__'), false, '__proto__ must be rejected by OPERATION_ID_RE');
	assert.equal(indexed.byOperationId.has('constructor'), true, 'constructor is a syntactically valid id, safely held in a Map');
	assert.equal(indexed.stats.rejected_operation_ids, 1);
	// eslint-disable-next-line no-extra-boolean-cast
	assert.equal(({}).polluted, undefined, 'no global prototype pollution occurred');
});

// --- input distrust: size/count limits, malformed input, no exceptions escape ---

test('loadOpenApiDocument: missing file, oversized file, unparseable JSON, and non-object root all return {ok:false} without throwing', () => {
	assert.equal(loadOpenApiDocument('/tmp/bskel-openapi-does-not-exist-xyz.json').ok, false);

	const bigFile = writeTempDoc({});
	fs.writeFileSync(bigFile, Buffer.alloc(17 * 1024 * 1024, 'x'));
	assert.equal(loadOpenApiDocument(bigFile).ok, false);

	const brokenFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-openapi-')), 'broken.json');
	fs.writeFileSync(brokenFile, '{not valid json');
	const brokenResult = loadOpenApiDocument(brokenFile);
	assert.equal(brokenResult.ok, false);
	assert.match(brokenResult.error, /could not parse/);

	const arrayFile = writeTempDoc([]);
	assert.equal(loadOpenApiDocument(arrayFile).ok, false);

	const nullFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-openapi-')), 'null.json');
	fs.writeFileSync(nullFile, 'null');
	assert.equal(loadOpenApiDocument(nullFile).ok, false);
});

test('indexOpenApiDocument: exceeding MAX_PATHS or MAX_OPERATIONS returns {ok:false}, not a partial index', () => {
	const manyPaths = {};
	for (let i = 0; i < 5001; i++) manyPaths[`/p${i}`] = { get: { operationId: `op${i}` } };
	const result = indexOpenApiDocument({ paths: manyPaths });
	assert.equal(result.ok, false);
	assert.match(result.error, /5000-path limit/);
});

test('PATH_PREFIX_RE rejects template params and empty segments, accepts clean multi-segment prefixes', () => {
	assert.equal(PATH_PREFIX_RE.test('/api/v0'), true);
	assert.equal(PATH_PREFIX_RE.test('/a/b/c'), true);
	assert.equal(PATH_PREFIX_RE.test('/api/{v}'), false);
	assert.equal(PATH_PREFIX_RE.test('//api'), false);
	assert.equal(PATH_PREFIX_RE.test(''), false);
});

test('normalizeRoute collapses repeated slashes and strips a trailing slash (but not the root)', () => {
	assert.equal(normalizeRoute('/a//b/'), '/a/b');
	assert.equal(normalizeRoute('/'), '/');
	assert.equal(normalizeRoute('/a'), '/a');
});

// ===== A2: request body JSON Schema projection =====

// --- component-schema indexing ---

test('indexOpenApiDocument: components.schemas indexes into a Map, component_schema_count matches', () => {
	const doc = { components: { schemas: { A: { type: 'object' }, B: { type: 'string' } } } };
	const indexed = indexOpenApiDocument(doc);
	assert.equal(indexed.ok, true);
	assert.equal(indexed.componentSchemas.size, 2);
	assert.equal(indexed.stats.component_schema_count, 2);
	assert.ok(indexed.componentSchemas.has('A'));
});

test('indexOpenApiDocument: a __proto__ component-schema name is rejected, no pollution', () => {
	// JSON.parse, not a JS object literal -- `{ __proto__: x }` as literal SYNTAX sets the
	// prototype rather than creating an own property (a JS-only quirk), which would make this
	// test pass for the wrong reason. JSON.parse('{"__proto__":...}') creates a genuine own
	// property, matching the real attack surface (loadOpenApiDocument parses untrusted JSON).
	const doc = JSON.parse('{"components":{"schemas":{"__proto__":{"type":"object"},"Real":{"type":"string"}}}}');
	const indexed = indexOpenApiDocument(doc);
	assert.equal(indexed.ok, true);
	assert.equal(indexed.componentSchemas.has('__proto__'), false);
	assert.equal(indexed.stats.rejected_component_schemas, 1);
	assert.equal(indexed.componentSchemas.size, 1);
	assert.equal(({}).polluted, undefined, 'no global prototype pollution occurred');
});

test('indexOpenApiDocument: constructor/toString component names are accepted, safely held in a Map', () => {
	const doc = { components: { schemas: { constructor: { type: 'object' }, toString: { type: 'string' } } } };
	const indexed = indexOpenApiDocument(doc);
	assert.equal(indexed.componentSchemas.has('constructor'), true);
	assert.equal(indexed.componentSchemas.has('toString'), true);
	assert.equal(indexed.stats.rejected_component_schemas, 0);
});

test('indexOpenApiDocument: non-object component-schema values (array/null/string) are skipped without throwing', () => {
	const doc = { components: { schemas: { Weird1: [1, 2], Weird2: null, Weird3: 'nope', Real: { type: 'object' } } } };
	const indexed = indexOpenApiDocument(doc);
	assert.equal(indexed.ok, true);
	assert.equal(indexed.componentSchemas.size, 1);
	assert.ok(indexed.componentSchemas.has('Real'));
});

test('indexOpenApiDocument: exceeding MAX_COMPONENT_SCHEMAS returns {ok:false}, not a partial index', () => {
	const schemas = {};
	for (let i = 0; i < 5001; i++) schemas[`S${i}`] = { type: 'object' };
	const result = indexOpenApiDocument({ components: { schemas } });
	assert.equal(result.ok, false);
	assert.match(result.error, /5000-schema limit/);
});

// --- inlineSchema: happy paths ---

test('inlineSchema: a flat object schema (real CreateOrganizationRequest shape) round-trips every constraint', () => {
	const schema = {
		type: 'object',
		required: ['dataRetentionDays', 'name'],
		properties: {
			name: { type: 'string', minLength: 1 },
			dataRetentionDays: { type: 'integer', format: 'int32', enum: [90, 180, 365] },
			emailDomain: { type: ['string', 'null'], pattern: '^[a-z]+$' },
		},
	};
	const result = inlineSchema(schema, new Map());
	assert.equal(result.ok, true);
	assert.deepEqual(result.schema.required, ['dataRetentionDays', 'name']);
	assert.deepEqual(result.schema.properties.dataRetentionDays.enum, [90, 180, 365]);
	assert.equal(result.schema.properties.dataRetentionDays.format, 'int32');
	assert.deepEqual(result.schema.properties.emailDomain.type, ['string', 'null']);
	assert.equal(result.schema.properties.emailDomain.pattern, '^[a-z]+$');
});

test('inlineSchema: a single $ref resolves and no $ref remains anywhere in the output', () => {
	const components = new Map([['Widget', { type: 'object', properties: { name: { type: 'string' } } }]]);
	const result = inlineSchema({ '$ref': '#/components/schemas/Widget' }, components);
	assert.equal(result.ok, true);
	assert.equal(JSON.stringify(result.schema).includes('$ref'), false);
	assert.equal(result.schema.type, 'object');
	assert.equal(result.schema.properties.name.type, 'string');
});

test('inlineSchema: oneOf:[{$ref},{type:null}] -- the real springdoc nullable-object idiom (41 occurrences) -- inlines correctly', () => {
	const components = new Map([['Cal', { type: 'object', properties: { version: { type: 'integer' } } }]]);
	const schema = { oneOf: [{ '$ref': '#/components/schemas/Cal' }, { type: 'null' }] };
	const result = inlineSchema(schema, components);
	assert.equal(result.ok, true);
	assert.equal(result.schema.oneOf.length, 2);
	assert.equal(result.schema.oneOf[0].properties.version.type, 'integer');
	assert.equal(result.schema.oneOf[1].type, 'null');
});

test('inlineSchema: additionalProperties:{$ref} -- the real Map<UUID,DTO> shape -- resolves', () => {
	const components = new Map([['Report', { type: 'object', properties: { id: { type: 'string' } } }]]);
	const schema = { type: 'object', additionalProperties: { '$ref': '#/components/schemas/Report' } };
	const result = inlineSchema(schema, components);
	assert.equal(result.ok, true);
	assert.equal(result.schema.additionalProperties.properties.id.type, 'string');
});

test('inlineSchema: additionalProperties:true/false (boolean) is copied verbatim, not recursed', () => {
	assert.equal(inlineSchema({ type: 'object', additionalProperties: true }, new Map()).schema.additionalProperties, true);
	assert.equal(inlineSchema({ type: 'object', additionalProperties: false }, new Map()).schema.additionalProperties, false);
});

test('inlineSchema: items:{$ref} inside minItems -- the real RegisterTraineesRequest.trainees shape -- resolves', () => {
	const components = new Map([['Trainee', { type: 'object', properties: { name: { type: 'string', maxLength: 200 } } }]]);
	const schema = { type: 'array', minItems: 1, items: { '$ref': '#/components/schemas/Trainee' } };
	const result = inlineSchema(schema, components);
	assert.equal(result.ok, true);
	assert.equal(result.schema.minItems, 1);
	assert.equal(result.schema.items.properties.name.maxLength, 200);
});

test('inlineSchema: diamond fan-out (two sibling properties referencing the SAME component) succeeds -- proves visiting is delete-on-exit', () => {
	const components = new Map([['Shared', { type: 'object', properties: { x: { type: 'string' } } }]]);
	const schema = {
		type: 'object',
		properties: {
			a: { '$ref': '#/components/schemas/Shared' },
			b: { '$ref': '#/components/schemas/Shared' },
		},
	};
	const result = inlineSchema(schema, components);
	assert.equal(result.ok, true);
	assert.equal(result.schema.properties.a.properties.x.type, 'string');
	assert.equal(result.schema.properties.b.properties.x.type, 'string');
});

// --- inlineSchema: fail-closed ---

test('inlineSchema: direct self-cycle (A -> A) fails closed with cycle-detected, does not hang or throw', () => {
	const components = new Map([['A', { '$ref': '#/components/schemas/A' }]]);
	const result = inlineSchema({ '$ref': '#/components/schemas/A' }, components);
	assert.equal(result.ok, false);
	assert.equal(result.reason, 'cycle-detected');
});

test('inlineSchema: indirect cycle (A -> B -> A) fails closed with cycle-detected', () => {
	const components = new Map([
		['A', { type: 'object', properties: { b: { '$ref': '#/components/schemas/B' } } }],
		['B', { type: 'object', properties: { a: { '$ref': '#/components/schemas/A' } } }],
	]);
	const result = inlineSchema({ '$ref': '#/components/schemas/A' }, components);
	assert.equal(result.ok, false);
	assert.equal(result.reason, 'cycle-detected');
});

test('inlineSchema: nesting past MAX_SCHEMA_DEPTH fails closed with max-depth-exceeded', () => {
	let schema = { type: 'string' };
	for (let i = 0; i < 40; i++) schema = { type: 'object', properties: { next: schema } };
	const result = inlineSchema(schema, new Map());
	assert.equal(result.ok, false);
	assert.equal(result.reason, 'max-depth-exceeded');
});

test('inlineSchema: wide-but-acyclic fan-out past MAX_SCHEMA_NODES fails closed with too-many-nodes', () => {
	const properties = {};
	for (let i = 0; i < 2100; i++) properties[`p${i}`] = { type: 'string' };
	const result = inlineSchema({ type: 'object', properties }, new Map());
	assert.equal(result.ok, false);
	assert.equal(result.reason, 'too-many-nodes');
});

test('inlineSchema: a large enum array counts toward the node budget and can exceed it', () => {
	const enumValues = Array.from({ length: 2100 }, (_, i) => `v${i}`);
	const result = inlineSchema({ type: 'string', enum: enumValues }, new Map());
	assert.equal(result.ok, false);
	assert.equal(result.reason, 'too-many-nodes');
});

test('inlineSchema: a pattern longer than MAX_PATTERN_LENGTH fails closed with pattern-too-long', () => {
	const result = inlineSchema({ type: 'string', pattern: `^${'a'.repeat(301)}$` }, new Map());
	assert.equal(result.ok, false);
	assert.equal(result.reason, 'pattern-too-long');
});

test('inlineSchema: a syntactically invalid pattern fails closed with invalid-pattern, not a thrown SyntaxError', () => {
	const result = inlineSchema({ type: 'string', pattern: '(' }, new Map());
	assert.equal(result.ok, false);
	assert.equal(result.reason, 'invalid-pattern');
});

test('inlineSchema: unsupported keywords fail closed by name, never silently dropped', () => {
	const cases = [
		['discriminator', { type: 'object', discriminator: { propertyName: 'kind' } }],
		['patternProperties', { type: 'object', patternProperties: { '^x-': { type: 'string' } } }],
		['not', { not: { type: 'string' } }],
		['if', { if: { type: 'string' }, then: {} }],
		['propertyNames', { propertyNames: { pattern: '^x' } }],
		['$dynamicRef', { '$dynamicRef': '#meta' }],
		['$id', { '$id': 'urn:sbf:envelope:1', type: 'object' }],
	];
	for (const [keyword, schema] of cases) {
		const result = inlineSchema(schema, new Map());
		assert.equal(result.ok, false, `${keyword} must fail closed`);
		assert.match(result.reason, new RegExp(`unsupported-keyword:${keyword.replace('$', '\\$')}`));
	}
});

test('inlineSchema: $ref to an external URL or to #/components/requestBodies/* is unsupported', () => {
	const external = inlineSchema({ '$ref': 'https://evil.example/x.json' }, new Map());
	assert.equal(external.ok, false);
	assert.equal(external.reason, 'unsupported-ref');

	const requestBodyRef = inlineSchema({ '$ref': '#/components/requestBodies/X' }, new Map());
	assert.equal(requestBodyRef.ok, false);
	assert.equal(requestBodyRef.reason, 'unsupported-ref');
});

test('inlineSchema: $ref to a component name not in componentSchemas fails closed with component-not-found', () => {
	const result = inlineSchema({ '$ref': '#/components/schemas/Ghost' }, new Map());
	assert.equal(result.ok, false);
	assert.equal(result.reason, 'component-not-found');
});

test('inlineSchema: a properties key of __proto__ fails the WHOLE schema closed, not a per-property drop', () => {
	// JSON.parse for the same reason as the component-schema-name test above -- a JS object
	// literal `{ __proto__: x }` sets the prototype instead of creating an own property.
	const schema = JSON.parse('{"type":"object","properties":{"__proto__":{"type":"string"},"name":{"type":"string"}}}');
	const result = inlineSchema(schema, new Map());
	assert.equal(result.ok, false);
	assert.equal(result.reason, 'unsupported-property-name');
});

test('inlineSchema: a required[] entry of __proto__ also fails closed', () => {
	const schema = { type: 'object', required: ['__proto__'], properties: { name: { type: 'string' } } };
	const result = inlineSchema(schema, new Map());
	assert.equal(result.ok, false);
	assert.equal(result.reason, 'unsupported-property-name');
});

// --- uuid / format ---

test('inlineSchema: format:uuid is rewritten to BARE_UUID_PATTERN, format key removed -- D-security-2 one layer down', () => {
	const result = inlineSchema({ type: 'string', format: 'uuid' }, new Map());
	assert.equal(result.ok, true);
	assert.equal(result.schema.pattern, BARE_UUID_PATTERN);
	assert.equal('format' in result.schema, false);
	// The exact regression: a urn:uuid: value (accepted by ajv-formats' uuid format) must be
	// rejected by the bare pattern, a plain UUID must be accepted.
	const bareRe = new RegExp(result.schema.pattern);
	assert.equal(bareRe.test('urn:uuid:550e8400-e29b-41d4-a716-446655440000'), false);
	assert.equal(bareRe.test('550e8400-e29b-41d4-a716-446655440000'), true);
});

test('inlineSchema: format:uuid together with an explicit pattern fails closed (no merge guessed)', () => {
	const result = inlineSchema({ type: 'string', format: 'uuid', pattern: '^[a-f]+$' }, new Map());
	assert.equal(result.ok, false);
	assert.equal(result.reason, 'uuid-format-with-pattern');
});

test('inlineSchema: an unmeasured format value fails closed rather than being guessed as safe', () => {
	const result = inlineSchema({ type: 'string', format: 'ipv4' }, new Map());
	assert.equal(result.ok, false);
	assert.match(result.reason, /unsupported-format:ipv4/);
});

// --- dialect gate + reconcile integration ---

function moduleWithRequestBody(schema, { operationId = 'createWidget', verb = 'POST', path: p = '/widgets' } = {}) {
	return oneControllerModule([{ verb, path: p, operationId, method: operationId }]);
}

test('reconcileModule: an OpenAPI 3.0 document disables schema projection entirely, with no per-operation warnings flood', () => {
	const doc = {
		openapi: '3.0.1',
		components: { schemas: { CreateWidgetRequest: { type: 'object', properties: { name: { type: 'string' } } } } },
		paths: { '/api/v0/widgets': { post: {
			operationId: 'createWidget',
			requestBody: { required: true, content: { 'application/json': { schema: { '$ref': '#/components/schemas/CreateWidgetRequest' } } } },
		} } },
	};
	const indexed = indexOpenApiDocument(doc);
	assert.equal(indexed.schemaDialectSupported, false);
	const module = moduleWithRequestBody();
	const recon = reconcileModule({ index: indexed, module, pathPrefix: '/api/v0' });
	assert.equal(recon.schemaProjection.enabled, false);
	assert.equal(recon.schemaProjection.reason, 'unsupported-openapi-version');
	assert.equal(recon.stats.schema_resolved, 0);
	assert.equal(recon.stats.schema_unresolved, 0);
	const result = recon.byEndpoint.get('0:0');
	assert.equal(result.kind, 'matched'); // path/verb reconciliation is dialect-independent, stays active
	assert.equal(result.requestBodySchema, undefined);
});

test('reconcileModule: matched + a resolvable JSON request body -> requestBodySchema attached, schema_resolved counted', () => {
	const doc = {
		openapi: '3.1.0',
		components: { schemas: { CreateWidgetRequest: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } } } },
		paths: { '/api/v0/widgets': { post: {
			operationId: 'createWidget',
			requestBody: { required: true, content: { 'application/json': { schema: { '$ref': '#/components/schemas/CreateWidgetRequest' } } } },
		} } },
	};
	const indexed = indexOpenApiDocument(doc);
	const module = moduleWithRequestBody();
	const recon = reconcileModule({ index: indexed, module, pathPrefix: '/api/v0' });
	const result = recon.byEndpoint.get('0:0');
	assert.equal(result.kind, 'matched');
	assert.equal(result.requestBodySchema.required[0], 'name');
	assert.equal(result.requestBodyRequired, true);
	assert.equal(recon.stats.schema_resolved, 1);
});

test('reconcileModule: drift/missing/ambiguous/unresolved never get a requestBodySchema, even with a perfectly resolvable body in the doc', () => {
	const doc = {
		openapi: '3.1.0',
		components: { schemas: { X: { type: 'object' } } },
		paths: { '/totally/unrelated': { post: {
			operationId: 'createWidget',
			requestBody: { content: { 'application/json': { schema: { '$ref': '#/components/schemas/X' } } } },
		} } },
	};
	const indexed = indexOpenApiDocument(doc);
	const module = moduleWithRequestBody();
	const recon = reconcileModule({ index: indexed, module, pathPrefix: '/api/v0' });
	const result = recon.byEndpoint.get('0:0');
	assert.equal(result.kind, 'drift'); // path disagrees, prefix can't explain it
	assert.equal(result.requestBodySchema, undefined);
	assert.equal(recon.stats.schema_resolved, 0);
});

test('reconcileModule: multipart/form-data content is skipped (schema_skipped_media_type), no requestBody at all is schema_none', () => {
	const doc = {
		openapi: '3.1.0',
		paths: {
			'/api/v0/widgets': { post: {
				operationId: 'uploadWidget',
				requestBody: { content: { 'multipart/form-data': { schema: { type: 'object' } } } },
			} },
			'/api/v0/plain': { get: { operationId: 'findWidget' } },
		},
	};
	const indexed = indexOpenApiDocument(doc);
	const module = oneControllerModule([
		{ verb: 'POST', path: '/widgets', operationId: 'uploadWidget', method: 'uploadWidget' },
		{ verb: 'GET', path: '/plain', operationId: 'findWidget', method: 'findWidget' },
	]);
	const recon = reconcileModule({ index: indexed, module, pathPrefix: '/api/v0' });
	assert.equal(recon.stats.schema_skipped_media_type, 1);
	assert.equal(recon.stats.schema_none, 1);
	assert.equal(recon.byEndpoint.get('0:0').requestBodySchema, undefined);
	assert.equal(recon.byEndpoint.get('0:1').requestBodySchema, undefined);
});

// ===== A3: response/error JSON Schema projection =====

function createWidgetModule() {
	return oneControllerModule([{ verb: 'POST', path: '/widgets', operationId: 'createWidget', method: 'createWidget' }]);
}

function docWithResponses(responses, { components = {}, openapiVersion = '3.1.0' } = {}) {
	return {
		openapi: openapiVersion,
		components: { schemas: components },
		paths: { '/api/v0/widgets': { post: { operationId: 'createWidget', responses } } },
	};
}

function reconcileCreateWidget(doc) {
	const indexed = indexOpenApiDocument(doc);
	assert.equal(indexed.ok, true);
	const recon = reconcileModule({ index: indexed, module: createWidgetModule(), pathPrefix: '/api/v0' });
	return { recon, result: recon.byEndpoint.get('0:0') };
}

test('indexOpenApiDocument retains responses verbatim on each entry; null when absent/non-object', () => {
	const doc = {
		paths: {
			'/a': { get: { operationId: 'x', responses: { '200': { description: 'ok' } } } },
			'/b': { get: { operationId: 'y' } },
		},
	};
	const indexed = indexOpenApiDocument(doc);
	assert.deepEqual(indexed.byOperationId.get('x').responses, { '200': { description: 'ok' } });
	assert.equal(indexed.byOperationId.get('y').responses, null);
});

test('matched + one 2xx JSON schema -> responseSchema attached, response_schema_resolved counted', () => {
	const doc = docWithResponses(
		{ '201': { content: { 'application/json': { schema: { '$ref': '#/components/schemas/Widget' } } } } },
		{ components: { Widget: { type: 'object', properties: { id: { type: 'string' } } } } },
	);
	const { recon, result } = reconcileCreateWidget(doc);
	assert.equal(result.kind, 'matched');
	assert.equal(result.responseSchema.properties.id.type, 'string');
	assert.equal(recon.stats.response_schema_resolved, 1);
});

test('400 and 500 sharing the identical $ref node -> a single errorSchema, no anyOf (raw-node dedupe before resolving)', () => {
	const doc = docWithResponses(
		{
			'400': { content: { 'application/json': { schema: { '$ref': '#/components/schemas/ErrorResponse' } } } },
			'500': { content: { 'application/json': { schema: { '$ref': '#/components/schemas/ErrorResponse' } } } },
		},
		{ components: { ErrorResponse: { type: 'object', properties: { code: { type: 'string' } } } } },
	);
	const { recon, result } = reconcileCreateWidget(doc);
	assert.equal('anyOf' in result.errorSchema, false);
	assert.equal(result.errorSchema.properties.code.type, 'string');
	assert.equal(recon.stats.error_schema_resolved, 1);
});

test('two 2xx sharing the identical $ref node (the real findCurrentProject shape) -> a single responseSchema, no anyOf', () => {
	const doc = docWithResponses(
		{
			'200': { content: { 'application/json': { schema: { '$ref': '#/components/schemas/Widget' } } } },
			'204': { content: { 'application/json': { schema: { '$ref': '#/components/schemas/Widget' } } } },
		},
		{ components: { Widget: { type: 'object' } } },
	);
	const { result } = reconcileCreateWidget(doc);
	assert.equal('anyOf' in result.responseSchema, false);
});

test('two 2xx with genuinely different schemas -> anyOf union of 2, responseSchemaSources === 2', () => {
	const doc = docWithResponses(
		{
			'200': { content: { 'application/json': { schema: { '$ref': '#/components/schemas/Full' } } } },
			'202': { content: { 'application/json': { schema: { '$ref': '#/components/schemas/Partial' } } } },
		},
		{
			components: {
				Full: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
				Partial: { type: 'object', properties: { b: { type: 'string' } } },
			},
		},
	);
	const { result } = reconcileCreateWidget(doc);
	assert.equal(result.responseSchema.anyOf.length, 2);
	assert.equal(result.responseSchemaSources, 2);
});

test('two distinct $refs that resolve to the identical schema collapse to 1 via canonicalJson comparison (proves resolved-shape dedup, not just raw-node dedup)', () => {
	const doc = docWithResponses(
		{
			'200': { content: { 'application/json': { schema: { '$ref': '#/components/schemas/A' } } } },
			'201': { content: { 'application/json': { schema: { '$ref': '#/components/schemas/B' } } } },
		},
		{
			components: {
				A: { type: 'object', properties: { x: { type: 'string' } } },
				B: { type: 'object', properties: { x: { type: 'string' } } },
			},
		},
	);
	const { result } = reconcileCreateWidget(doc);
	assert.equal('anyOf' in result.responseSchema, false);
	assert.equal(result.responseSchemaSources, 1);
});

test('anyOf semantics regression: a payload matching two overlapping branches validates -- oneOf would reject it', () => {
	const doc = docWithResponses(
		{
			'200': { content: { 'application/json': { schema: { '$ref': '#/components/schemas/Full' } } } },
			'202': { content: { 'application/json': { schema: { '$ref': '#/components/schemas/Minimal' } } } },
		},
		{
			components: {
				Full: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
				Minimal: { type: 'object', properties: { a: { type: 'string' }, b: { type: 'string' } }, required: ['a'] },
			},
		},
	);
	const { result } = reconcileCreateWidget(doc);
	const schema = result.responseSchema;
	assert.ok(schema.anyOf, 'must be a union');
	assert.equal('oneOf' in schema, false);
	const ajv = new Ajv2020({ allErrors: true, strict: false });
	const validateFn = ajv.compile(schema);
	assert.equal(validateFn({ a: 'x' }), true, 'a payload matching both overlapping branches must validate under anyOf');
});

test('a 2xx with only text/csv content -> response_schema_skipped_media_type, no key, no warning-worthy failure', () => {
	const doc = docWithResponses({ '200': { content: { 'text/csv': { schema: { type: 'string' } } } } });
	const { recon, result } = reconcileCreateWidget(doc);
	assert.equal(recon.stats.response_schema_skipped_media_type, 1);
	assert.equal('responseSchema' in result, false);
});

test('a 204 with no content at all -> response_schema_none, not a failure', () => {
	const doc = docWithResponses({ '204': { description: 'no content' } });
	const { recon, result } = reconcileCreateWidget(doc);
	assert.equal(recon.stats.response_schema_none, 1);
	assert.equal('responseSchema' in result, false);
});

// A6 (D-openapi-export): this test previously asserted the OPPOSITE for the error half -- that a
// `default` response contributed to NEITHER bucket. That was the real shipped behavior through A3,
// and it silently dropped a genuine error schema for any document written the (entirely ordinary)
// `default` way, with no warning anywhere, since "no status matched" is correctly not a failure.
// A6 folds `default` into the ERROR side only. The SUCCESS half of the original assertion is
// unchanged and is the load-bearing one: `default` means "every status not otherwise listed", so
// letting it become a success schema would let an error shape satisfy success validation, while
// widening the error union is something A3's own `anyOf` design already tolerates by construction.
test('a response documented only under "default" contributes to the error bucket, and never to the success one', () => {
	const doc = docWithResponses(
		{ default: { content: { 'application/json': { schema: { '$ref': '#/components/schemas/X' } } } } },
		{ components: { X: { type: 'object' } } },
	);
	const { recon, result } = reconcileCreateWidget(doc);
	assert.equal(recon.stats.response_schema_none, 1);
	assert.equal('responseSchema' in result, false, '`default` must never become a success schema');
	assert.equal(recon.stats.error_schema_resolved, 1);
	assert.deepEqual(result.errorSchema, { type: 'object' });
});

test('one 2xx resolves, another has an unsupported keyword -> the WHOLE responseSchema fails closed, no partial union', () => {
	const doc = docWithResponses(
		{
			'200': { content: { 'application/json': { schema: { '$ref': '#/components/schemas/Good' } } } },
			'201': { content: { 'application/json': { schema: { '$ref': '#/components/schemas/Bad' } } } },
		},
		{
			components: {
				Good: { type: 'object' },
				Bad: { type: 'object', discriminator: { propertyName: 'kind' } },
			},
		},
	);
	const { recon, result } = reconcileCreateWidget(doc);
	assert.equal('responseSchema' in result, false);
	assert.match(result.responseSchemaUnresolvedReason, /unsupported-keyword:discriminator/);
	assert.equal(recon.stats.response_schema_unresolved, 1);
});

test('exceeding MAX_RESPONSES_PER_OPERATION fails closed with too-many-responses, for both response and error', () => {
	const responses = {};
	for (let i = 0; i < 65; i++) responses[`2${String(i).padStart(2, '0')}`] = { description: 'x' };
	const doc = docWithResponses(responses);
	const { result } = reconcileCreateWidget(doc);
	assert.equal(result.responseSchemaUnresolvedReason, 'too-many-responses');
	assert.equal(result.errorSchemaUnresolvedReason, 'too-many-responses');
});

test('a 302 with a JSON schema contributes to neither success nor error bucket', () => {
	const doc = docWithResponses(
		{ '302': { content: { 'application/json': { schema: { '$ref': '#/components/schemas/X' } } } } },
		{ components: { X: { type: 'object' } } },
	);
	const { recon } = reconcileCreateWidget(doc);
	assert.equal(recon.stats.response_schema_none, 1);
	assert.equal(recon.stats.error_schema_none, 1);
});

test('drift never gets responseSchema/errorSchema, even with perfectly resolvable ones in the doc', () => {
	const doc = {
		openapi: '3.1.0',
		components: { schemas: { X: { type: 'object' } } },
		paths: { '/api/v0/widgets/{id}': { post: { // verb drift: doc says POST, scan says GET
			operationId: 'findWidget',
			responses: { '200': { content: { 'application/json': { schema: { '$ref': '#/components/schemas/X' } } } } },
		} } },
	};
	const indexed = indexOpenApiDocument(doc);
	const module = oneControllerModule([{ verb: 'GET', path: '/widgets/{id}', operationId: 'findWidget', method: 'findWidget' }]);
	const recon = reconcileModule({ index: indexed, module, pathPrefix: '/api/v0' });
	const result = recon.byEndpoint.get('0:0');
	assert.equal(result.kind, 'drift');
	assert.equal('responseSchema' in result, false);
	assert.equal('errorSchema' in result, false);
});

test('an OpenAPI 3.0 document disables response/error projection too -- all 8 new counters stay 0', () => {
	const doc = docWithResponses(
		{ '200': { content: { 'application/json': { schema: { '$ref': '#/components/schemas/X' } } } } },
		{ components: { X: { type: 'object' } }, openapiVersion: '3.0.1' },
	);
	const { recon } = reconcileCreateWidget(doc);
	assert.equal(recon.schemaProjection.enabled, false);
	for (const k of [
		'response_schema_resolved', 'response_schema_unresolved', 'response_schema_none', 'response_schema_skipped_media_type',
		'error_schema_resolved', 'error_schema_unresolved', 'error_schema_none', 'error_schema_skipped_media_type',
	]) {
		assert.equal(recon.stats[k], 0, k);
	}
});

test('genuine oneOf polymorphism (the real MySubmissionResponse.content shape) resolves with zero code change, both branches inlined', () => {
	const doc = docWithResponses(
		{ '200': { content: { 'application/json': { schema: { '$ref': '#/components/schemas/MySubmissionResponse' } } } } },
		{
			components: {
				MySubmissionResponse: {
					type: 'object',
					properties: {
						content: {
							oneOf: [
								{ '$ref': '#/components/schemas/GithubSubmissionContent' },
								{ '$ref': '#/components/schemas/ZipSubmissionContent' },
							],
						},
					},
				},
				GithubSubmissionContent: { type: 'object', properties: { repoUrl: { type: 'string' } }, required: ['repoUrl'] },
				ZipSubmissionContent: { type: 'object', properties: { fileName: { type: 'string' } }, required: ['fileName'] },
			},
		},
	);
	const { result } = reconcileCreateWidget(doc);
	const schema = result.responseSchema;
	assert.equal(JSON.stringify(schema).includes('$ref'), false);
	assert.equal(schema.properties.content.oneOf.length, 2);
	assert.equal(schema.properties.content.oneOf[0].properties.repoUrl.type, 'string');
	assert.equal(schema.properties.content.oneOf[1].properties.fileName.type, 'string');
});

test('additionalProperties with a primitive value (real Map<K,Long> response shape) resolves', () => {
	const doc = docWithResponses(
		{ '200': { content: { 'application/json': { schema: { '$ref': '#/components/schemas/CountsResponse' } } } } },
		{ components: { CountsResponse: { type: 'object', additionalProperties: { type: 'integer', format: 'int64' } } } },
	);
	const { result } = reconcileCreateWidget(doc);
	assert.deepEqual(result.responseSchema.additionalProperties, { type: 'integer', format: 'int64' });
});

test('a component with properties+required and no type (the real ErrorResponse root shape) resolves, required preserved', () => {
	const doc = docWithResponses(
		{ '400': { content: { 'application/json': { schema: { '$ref': '#/components/schemas/ErrorResponse' } } } } },
		{ components: { ErrorResponse: { properties: { code: { type: 'string' }, message: { type: 'string' } }, required: ['code', 'message'] } } },
	);
	const { result } = reconcileCreateWidget(doc);
	assert.equal('type' in result.errorSchema, false);
	assert.deepEqual(result.errorSchema.required, ['code', 'message']);
});

// ===== A7: source-backed OpenAPI field passthrough =====

// --- inlineSchema learns `default` ---

test('inlineSchema: `default` is copied verbatim on a plain (non-$ref) node -- the 22 real direct occurrences', () => {
	const result = inlineSchema({ type: 'string', default: 'READINESS' }, new Map());
	assert.equal(result.ok, true);
	assert.equal(result.schema.default, 'READINESS');
});

test('inlineSchema: `default` alongside `$ref` used to fail closed (ref-with-siblings) -- now tolerated AND merged onto the resolved schema, the real 9 occurrences (e.g. ProjectListSort)', () => {
	const components = new Map([['ProjectListSort', { type: 'string', enum: ['READINESS', 'NAME'] }]]);
	const result = inlineSchema({ '$ref': '#/components/schemas/ProjectListSort', default: 'READINESS' }, components);
	assert.equal(result.ok, true);
	assert.equal(JSON.stringify(result.schema).includes('$ref'), false);
	assert.deepEqual(result.schema.enum, ['READINESS', 'NAME']);
	assert.equal(result.schema.default, 'READINESS');
});

test('inlineSchema: a $ref sibling that is NOT `default` (and not a DROPPED_KEYWORDS entry) still fails ref-with-siblings -- the `default` tolerance did not widen generally', () => {
	const components = new Map([['X', { type: 'string' }]]);
	const result = inlineSchema({ '$ref': '#/components/schemas/X', minLength: 1 }, components);
	assert.equal(result.ok, false);
	assert.equal(result.reason, 'ref-with-siblings');
});

// --- indexOpenApiDocument: securitySchemes indexing ---

test('indexOpenApiDocument: components.securitySchemes indexes into a Map, security_scheme_count matches', () => {
	const doc = { components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' }, apiKey: { type: 'apiKey', in: 'header', name: 'X-Api-Key' } } } };
	const indexed = indexOpenApiDocument(doc);
	assert.equal(indexed.ok, true);
	assert.equal(indexed.securitySchemes.size, 2);
	assert.equal(indexed.stats.security_scheme_count, 2);
	assert.deepEqual(indexed.securitySchemes.get('bearerAuth'), { type: 'http', scheme: 'bearer' });
});

test('indexOpenApiDocument: a __proto__ security-scheme name is rejected, no pollution', () => {
	const doc = JSON.parse('{"components":{"securitySchemes":{"__proto__":{"type":"http"},"bearerAuth":{"type":"http"}}}}');
	const indexed = indexOpenApiDocument(doc);
	assert.equal(indexed.ok, true);
	assert.equal(indexed.securitySchemes.has('__proto__'), false);
	assert.equal(indexed.stats.rejected_security_schemes, 1);
	assert.equal(indexed.securitySchemes.size, 1);
	assert.equal(({}).polluted, undefined, 'no global prototype pollution occurred');
});

test('indexOpenApiDocument: exceeding MAX_SECURITY_SCHEMES returns {ok:false}, not a partial index', () => {
	const securitySchemes = {};
	for (let i = 0; i < 65; i++) securitySchemes[`scheme${i}`] = { type: 'http', scheme: 'bearer' };
	const result = indexOpenApiDocument({ components: { securitySchemes } });
	assert.equal(result.ok, false);
	assert.match(result.error, /64-scheme limit/);
});

test('indexOpenApiDocument retains parameters/security/summary/tags verbatim; a real explicit security:[] is preserved distinctly from absent', () => {
	const doc = {
		paths: {
			'/a': { get: { operationId: 'x', parameters: [{ name: 'q', in: 'query', schema: { type: 'string' } }], security: [], summary: 'find things', tags: ['Widgets'] } },
			'/b': { get: { operationId: 'y' } },
		},
	};
	const indexed = indexOpenApiDocument(doc);
	const x = indexed.byOperationId.get('x');
	assert.deepEqual(x.security, []);
	assert.equal(x.summary, 'find things');
	assert.deepEqual(x.tags, ['Widgets']);
	assert.equal(x.parameters.length, 1);
	const y = indexed.byOperationId.get('y');
	assert.equal(y.security, null, 'absent security must not be confused with an explicit []');
	assert.equal(y.summary, null);
	assert.equal(y.tags, null);
	assert.equal(y.parameters, null);
});

// --- applyParameters / copyParameter, via reconcileModule integration ---

function docWithOperationFields(fields, { componentSchemas = {}, securitySchemes = {}, openapiVersion = '3.1.0' } = {}) {
	return {
		openapi: openapiVersion,
		components: { schemas: componentSchemas, securitySchemes },
		paths: { '/api/v0/widgets': { post: { operationId: 'createWidget', ...fields } } },
	};
}

test('matched: query/header/cookie parameters are copied with schema resolved; a path-shaped entry in parameters[] is never copied here', () => {
	const doc = docWithOperationFields({
		parameters: [
			{ name: 'q', in: 'query', required: false, description: 'search term', schema: { type: 'string', maxLength: 10 } },
			{ name: 'X-Trace-Id', in: 'header', schema: { type: 'string' } },
			{ name: 'session', in: 'cookie', schema: { type: 'string' } },
			{ name: 'widgetId', in: 'path', schema: { type: 'string' } },
		],
	});
	const { recon, result } = reconcileCreateWidget(doc);
	assert.equal(result.sourceParameters.length, 3);
	assert.ok(result.sourceParameters.every((p) => p.in !== 'path'));
	const q = result.sourceParameters.find((p) => p.name === 'q');
	assert.equal(q.description, 'search term');
	assert.equal(q.schema.maxLength, 10);
	assert.equal(recon.stats.parameters_copied, 1);
	assert.equal('parametersUnresolved' in result, false);
});

test('dedup: two parameters sharing (name,in) in the source keep only the first, source order', () => {
	const doc = docWithOperationFields({
		parameters: [
			{ name: 'q', in: 'query', schema: { type: 'string', maxLength: 5 } },
			{ name: 'q', in: 'query', schema: { type: 'string', maxLength: 999 } },
		],
	});
	const { result } = reconcileCreateWidget(doc);
	assert.equal(result.sourceParameters.length, 1);
	assert.equal(result.sourceParameters[0].schema.maxLength, 5);
});

test('a $ref parameter and a content-keyed parameter both fail closed for that ONE parameter, never the whole operation', () => {
	const doc = docWithOperationFields({
		parameters: [
			{ '$ref': '#/components/parameters/Widget' },
			{ name: 'x', in: 'query', content: { 'application/json': { schema: { type: 'string' } } } },
			{ name: 'ok', in: 'query', schema: { type: 'string' } },
		],
	});
	const { recon, result } = reconcileCreateWidget(doc);
	assert.equal(result.sourceParameters.length, 1, 'the one clean parameter still gets copied');
	assert.equal(result.sourceParameters[0].name, 'ok');
	assert.equal(result.parametersUnresolved.length, 2);
	assert.deepEqual(result.parametersUnresolved.map((p) => p.reason).sort(), ['content-parameter', 'ref-parameter']);
	assert.equal(recon.stats.parameters_unresolved, 1, 'per-OPERATION tally, not per-parameter');
});

test('an unknown parameter keyword fails that parameter closed by name, never silently dropped without a reason', () => {
	const doc = docWithOperationFields({ parameters: [{ name: 'x', in: 'query', schema: { type: 'string' }, style: 'form', explode: true, weirdKeyword: 1 }] });
	const { result } = reconcileCreateWidget(doc);
	assert.equal('sourceParameters' in result, false);
	assert.equal(result.parametersUnresolved[0].reason, 'unsupported-keyword:weirdKeyword');
});

test('style/explode/allowReserved/allowEmptyValue/deprecated are COPIED verbatim (real, if rare, keys this policy explicitly allows)', () => {
	const doc = docWithOperationFields({
		parameters: [{ name: 'x', in: 'query', schema: { type: 'string' }, style: 'form', explode: true, allowReserved: true, allowEmptyValue: true, deprecated: true }],
	});
	const { result } = reconcileCreateWidget(doc);
	const p = result.sourceParameters[0];
	assert.equal(p.style, 'form');
	assert.equal(p.explode, true);
	assert.equal(p.allowReserved, true);
	assert.equal(p.allowEmptyValue, true);
	assert.equal(p.deprecated, true);
});

test('example/examples are DROPPED silently (annotation-only), not a copy failure', () => {
	const doc = docWithOperationFields({ parameters: [{ name: 'x', in: 'query', schema: { type: 'string' }, example: 'abc', examples: { a: { value: 'abc' } } }] });
	const { result } = reconcileCreateWidget(doc);
	assert.equal('parametersUnresolved' in result, false);
	assert.equal('example' in result.sourceParameters[0], false);
	assert.equal('examples' in result.sourceParameters[0], false);
});

test('a parameter whose schema fails to resolve is STILL copied (every other field is real and safe), just without a `schema` key -- and it drives the warning', () => {
	const doc = docWithOperationFields({ parameters: [{ name: 'x', in: 'query', required: true, schema: { type: 'object', discriminator: { propertyName: 'kind' } } }] });
	const { recon, result } = reconcileCreateWidget(doc);
	assert.equal(result.sourceParameters.length, 1);
	assert.equal(result.sourceParameters[0].name, 'x');
	assert.equal(result.sourceParameters[0].required, true);
	assert.equal('schema' in result.sourceParameters[0], false);
	assert.match(result.parametersUnresolved[0].reason, /unsupported-keyword:discriminator/);
	assert.equal(recon.stats.parameters_unresolved, 1);
});

test('exceeding MAX_PARAMETERS_PER_OPERATION fails the WHOLE parameter set closed for this operation, never the whole reconciliation', () => {
	const parameters = [];
	for (let i = 0; i < 65; i++) parameters.push({ name: `q${i}`, in: 'query', schema: { type: 'string' } });
	const doc = docWithOperationFields({ parameters });
	const { recon, result } = reconcileCreateWidget(doc);
	assert.equal(result.kind, 'matched', 'the operation itself is unaffected -- only its parameter passthrough fails');
	assert.equal('sourceParameters' in result, false);
	assert.equal(result.parametersUnresolved.length, 65);
	assert.ok(result.parametersUnresolved.every((p) => p.reason === 'too-many-parameters'));
	assert.equal(recon.stats.parameters_unresolved, 1);
});

test('parameters ride the schema-bearing dialect gate: a 3.0 document skips parameter passthrough entirely, parametersSkippedDialect true', () => {
	const doc = docWithOperationFields({ parameters: [{ name: 'q', in: 'query', schema: { type: 'string' } }] }, { openapiVersion: '3.0.1' });
	const { recon, result } = reconcileCreateWidget(doc);
	assert.equal(recon.schemaProjection.enabled, false);
	assert.equal('sourceParameters' in result, false);
	assert.equal(result.parametersSkippedDialect, true);
	assert.equal(recon.stats.parameters_skipped_dialect, 1);
});

test('no non-path parameters at all -> parameters_none, no sourceParameters/parametersUnresolved keys', () => {
	const doc = docWithOperationFields({});
	const { recon, result } = reconcileCreateWidget(doc);
	assert.equal('sourceParameters' in result, false);
	assert.equal('parametersUnresolved' in result, false);
	assert.equal(recon.stats.parameters_none, 1);
});

test('drift never gets sourceParameters, even with a perfectly resolvable one in the doc', () => {
	const doc = {
		openapi: '3.1.0',
		paths: { '/api/v0/widgets/{id}': { post: { // verb drift: doc says POST, scan says GET
			operationId: 'findWidget',
			parameters: [{ name: 'q', in: 'query', schema: { type: 'string' } }],
		} } },
	};
	const indexed = indexOpenApiDocument(doc);
	const module = oneControllerModule([{ verb: 'GET', path: '/widgets/{id}', operationId: 'findWidget', method: 'findWidget' }]);
	const recon = reconcileModule({ index: indexed, module, pathPrefix: '/api/v0' });
	const result = recon.byEndpoint.get('0:0');
	assert.equal(result.kind, 'drift');
	assert.equal('sourceParameters' in result, false);
});

// --- applySecurity ---

test('security:[] (a real, explicit public endpoint) is preserved verbatim, counted security_public -- never treated as absent', () => {
	const doc = docWithOperationFields({ security: [] });
	const { recon, result } = reconcileCreateWidget(doc);
	assert.deepEqual(result.sourceSecurity, []);
	assert.equal(recon.stats.security_public, 1);
	assert.equal(recon.stats.security_copied, 0);
});

test('a non-empty security requirement naming a real scheme is copied verbatim, and the scheme name is accumulated for sourceSecuritySchemes', () => {
	const doc = docWithOperationFields({ security: [{ bearerAuth: [] }] }, { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } });
	const { recon, result } = reconcileCreateWidget(doc);
	assert.deepEqual(result.sourceSecurity, [{ bearerAuth: [] }]);
	assert.equal(recon.stats.security_copied, 1);
	assert.deepEqual([...recon.sourceSecuritySchemes.keys()], ['bearerAuth']);
});

test('a security requirement naming an UNDECLARED scheme drops the WHOLE security value for that operation -- never a dangling reference', () => {
	const doc = docWithOperationFields({ security: [{ apiKeyAuth: [] }] }); // no components.securitySchemes.apiKeyAuth
	const { recon, result } = reconcileCreateWidget(doc);
	assert.equal('sourceSecurity' in result, false);
	assert.equal(result.securityUnresolvedReason, 'unknown-scheme');
	assert.equal(recon.stats.security_unresolved, 1);
	assert.equal(recon.sourceSecuritySchemes.size, 0, 'nothing was actually referenced by a COPIED requirement');
});

test('a scheme declared in the document but never referenced by any copied security requirement is NOT included in sourceSecuritySchemes', () => {
	const doc = {
		openapi: '3.1.0',
		components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' }, unused: { type: 'http', scheme: 'basic' } } },
		paths: { '/api/v0/widgets': { post: { operationId: 'createWidget', security: [{ bearerAuth: [] }] } } },
	};
	const { recon } = reconcileCreateWidget(doc);
	assert.deepEqual([...recon.sourceSecuritySchemes.keys()], ['bearerAuth']);
});

test('exceeding MAX_SECURITY_REQUIREMENTS_PER_OPERATION fails closed with too-many-requirements', () => {
	const security = [];
	for (let i = 0; i < 33; i++) security.push({ bearerAuth: [] });
	const doc = docWithOperationFields({ security }, { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } });
	const { recon, result } = reconcileCreateWidget(doc);
	assert.equal('sourceSecurity' in result, false);
	assert.equal(result.securityUnresolvedReason, 'too-many-requirements');
	assert.equal(recon.stats.security_unresolved, 1);
});

test('no `security` key at all on the operation -> security_none, no sourceSecurity/securityUnresolvedReason keys', () => {
	const doc = docWithOperationFields({});
	const { recon, result } = reconcileCreateWidget(doc);
	assert.equal('sourceSecurity' in result, false);
	assert.equal('securityUnresolvedReason' in result, false);
	assert.equal(recon.stats.security_none, 1);
});

test('security is dialect-INDEPENDENT: a 3.0 document still copies it, unlike parameters (the deliberate asymmetry)', () => {
	const doc = docWithOperationFields({ security: [{ bearerAuth: [] }] }, { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } }, openapiVersion: '3.0.1' });
	const { recon, result } = reconcileCreateWidget(doc);
	assert.equal(recon.schemaProjection.enabled, false, 'schema-bearing projection IS disabled for this document');
	assert.deepEqual(result.sourceSecurity, [{ bearerAuth: [] }], 'but security copies anyway -- it carries no Schema Object');
});

test('drift never gets sourceSecurity, even with a perfectly resolvable one in the doc', () => {
	const doc = {
		openapi: '3.1.0',
		components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } },
		paths: { '/api/v0/widgets/{id}': { post: {
			operationId: 'findWidget',
			security: [{ bearerAuth: [] }],
		} } },
	};
	const indexed = indexOpenApiDocument(doc);
	const module = oneControllerModule([{ verb: 'GET', path: '/widgets/{id}', operationId: 'findWidget', method: 'findWidget' }]);
	const recon = reconcileModule({ index: indexed, module, pathPrefix: '/api/v0' });
	const result = recon.byEndpoint.get('0:0');
	assert.equal(result.kind, 'drift');
	assert.equal('sourceSecurity' in result, false);
});

// --- applySummaryAndTags ---

test('summary and tags are copied verbatim when present; non-string tag entries are filtered, not a failure', () => {
	const doc = docWithOperationFields({ summary: 'create a widget', tags: ['Widgets', 42, 'Admin'] });
	const { recon, result } = reconcileCreateWidget(doc);
	assert.equal(result.sourceSummary, 'create a widget');
	assert.deepEqual(result.sourceTags, ['Widgets', 'Admin']);
	assert.equal(recon.stats.summary_copied, 1);
	assert.equal(recon.stats.tags_copied, 1);
});

test('no summary/tags on the operation -> neither key appears, neither counter increments', () => {
	const doc = docWithOperationFields({});
	const { recon, result } = reconcileCreateWidget(doc);
	assert.equal('sourceSummary' in result, false);
	assert.equal('sourceTags' in result, false);
	assert.equal(recon.stats.summary_copied, 0);
	assert.equal(recon.stats.tags_copied, 0);
});

test('an empty tags array is never copied as an empty array -- omitted entirely, matching the "never null/[]" discipline', () => {
	const doc = docWithOperationFields({ tags: [] });
	const { result } = reconcileCreateWidget(doc);
	assert.equal('sourceTags' in result, false);
});

test('summary/tags are dialect-INDEPENDENT: a 3.0 document still copies them', () => {
	const doc = docWithOperationFields({ summary: 'x', tags: ['Y'] }, { openapiVersion: '3.0.1' });
	const { recon, result } = reconcileCreateWidget(doc);
	assert.equal(recon.schemaProjection.enabled, false);
	assert.equal(result.sourceSummary, 'x');
	assert.deepEqual(result.sourceTags, ['Y']);
});

// --- snapshotFromReconciliation: the four A7 decision fields ---

function snapshotOp(doc, featureId = '001-x') {
	const indexed = indexOpenApiDocument(doc);
	const recon = reconcileModule({ index: indexed, module: createWidgetModule(), pathPrefix: '/api/v0' });
	const reconciliation = {
		byEndpoint: recon.byEndpoint, prefix: recon.prefix, stats: recon.stats, schemaProjection: recon.schemaProjection,
		document: { hash: 'x', bytes: 1, path_count: 1, operation_count: 1, skipped_path_refs: 0, rejected_operation_ids: 0, component_schema_count: 0, rejected_component_schemas: 0, security_scheme_count: 0, rejected_security_schemes: 0, openapi_version: doc.openapi, servers: [] },
	};
	const snapshot = snapshotFromReconciliation(reconciliation, { featureId, sourceFile: { file: 'x.json', outsideRepo: false } });
	return snapshot.operations.createWidget;
}

test('snapshot decision fields: parameters "copied:N" / "partial:M-of-N" / "none" / "skipped:dialect"', () => {
	assert.equal(snapshotOp(docWithOperationFields({})).parameters, 'none');
	assert.equal(snapshotOp(docWithOperationFields({ parameters: [{ name: 'q', in: 'query', schema: { type: 'string' } }] })).parameters, 'copied:1');
	assert.equal(
		snapshotOp(docWithOperationFields({ parameters: [
			{ name: 'q', in: 'query', schema: { type: 'string' } },
			{ '$ref': '#/components/parameters/Bad' },
		] })).parameters,
		'partial:1-of-2',
	);
	assert.equal(snapshotOp(docWithOperationFields({ parameters: [{ name: 'q', in: 'query', schema: { type: 'string' } }] }, { openapiVersion: '3.0.1' })).parameters, 'skipped:dialect');
});

test('snapshot decision fields: security "copied:N" / "copied:public" / "unresolved:X" / "none"', () => {
	assert.equal(snapshotOp(docWithOperationFields({})).security, 'none');
	assert.equal(snapshotOp(docWithOperationFields({ security: [] })).security, 'copied:public');
	assert.equal(snapshotOp(docWithOperationFields({ security: [{ bearerAuth: [] }] }, { securitySchemes: { bearerAuth: { type: 'http' } } })).security, 'copied:1');
	assert.equal(snapshotOp(docWithOperationFields({ security: [{ ghost: [] }] })).security, 'unresolved:unknown-scheme');
});

test('snapshot decision fields: summary "copied" / "none", tags "copied:N" / "none"', () => {
	assert.equal(snapshotOp(docWithOperationFields({})).summary, 'none');
	assert.equal(snapshotOp(docWithOperationFields({})).tags, 'none');
	assert.equal(snapshotOp(docWithOperationFields({ summary: 'x' })).summary, 'copied');
	assert.equal(snapshotOp(docWithOperationFields({ tags: ['a', 'b'] })).tags, 'copied:2');
});

// --- the self-import guard's second key material ---

test('hasBskelExportMarker: an operation-level x-bskel-passthrough marker is detected with NO info marker present', () => {
	const doc = {
		openapi: '3.1.0',
		paths: { '/w': { get: { operationId: 'findW', [BSKEL_PASSTHROUGH_EXTENSION]: { source_sha256: 'abc123' } } } },
	};
	assert.equal(hasBskelExportMarker(doc), true);
});

test('hasBskelExportMarker: neither marker present is false; the info marker alone is still sufficient (unchanged A6 behavior)', () => {
	const bare = { openapi: '3.1.0', paths: { '/w': { get: { operationId: 'findW' } } } };
	assert.equal(hasBskelExportMarker(bare), false);
	const withInfoOnly = { openapi: '3.1.0', info: { [BSKEL_GENERATED_EXTENSION]: {} }, paths: { '/w': { get: { operationId: 'findW' } } } };
	assert.equal(hasBskelExportMarker(withInfoOnly), true);
});

// ===== A8: per-status responses + non-JSON request media types =====

test('per-status: a real, resolvable status with an application/json schema takes the schemaFrom branch, not an inline schema', () => {
	const doc = docWithOperationFields({
		responses: {
			'201': { description: 'created', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Widget' } } } },
			'400': { description: 'bad input', content: { 'application/json': { schema: { '$ref': '#/components/schemas/ErrorResponse' } } } },
		},
	}, { componentSchemas: { Widget: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } }, ErrorResponse: { type: 'object', required: ['code'], properties: { code: { type: 'string' } } } } });
	const { recon, result } = reconcileCreateWidgetFields(doc);
	assert.equal(result.sourceResponses['201'].schemaFrom, 'response');
	assert.equal('schema' in result.sourceResponses['201'], false, 'schemaFrom points at the already-resolved responseSchema, no duplicate inline schema');
	assert.equal(result.sourceResponses['201'].description, 'created');
	assert.equal(result.sourceResponses['400'].schemaFrom, 'error');
	assert.equal(result.sourceResponses['400'].description, 'bad input');
	assert.equal(recon.stats.per_status_copied, 1);
});

test('per-status: a status with no JSON content at all (a bare 204) still gets an entry, with description only', () => {
	const doc = docWithOperationFields({
		responses: {
			'200': { description: 'ok', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Widget' } } } },
			'204': { description: 'no content' },
		},
	}, { componentSchemas: { Widget: { type: 'object' } } });
	const { result } = reconcileCreateWidgetFields(doc);
	assert.deepEqual(result.sourceResponses['204'], { description: 'no content' });
});

test('per-status: a status with a non-JSON media type discloses the media type NAME via `mediaTypes`, never a schema', () => {
	const doc = docWithOperationFields({
		responses: {
			'200': { description: 'ok', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Widget' } } } },
			'201': { description: 'csv export', content: { 'text/csv': {} } },
		},
	}, { componentSchemas: { Widget: { type: 'object' } } });
	const { result } = reconcileCreateWidgetFields(doc);
	assert.deepEqual(result.sourceResponses['201'].mediaTypes, ['text/csv']);
	assert.equal('schema' in result.sourceResponses['201'], false);
	assert.equal('schemaFrom' in result.sourceResponses['201'], false);
});

test('per-status: written only when BOTH response and error buckets are resolved-or-none -- an unresolvable error schema skips per-status entirely, even though the success side resolved cleanly', () => {
	const doc = docWithOperationFields({
		responses: {
			'200': { content: { 'application/json': { schema: { '$ref': '#/components/schemas/Widget' } } } },
			'400': { content: { 'application/json': { schema: { '$ref': '#/components/schemas/BadError' } } } },
		},
	}, { componentSchemas: { Widget: { type: 'object' }, BadError: { type: 'object', discriminator: { propertyName: 'kind' } } } });
	const { recon, result } = reconcileCreateWidgetFields(doc);
	assert.ok(result.responseSchema, 'the success side must still resolve');
	assert.equal('errorSchema' in result, false, 'the error side must genuinely fail to resolve for this test to mean anything');
	assert.equal('sourceResponses' in result, false, 'per-status must skip entirely, not partially, when either bucket is unresolved');
	assert.equal(result.perStatusResponsesSkippedUnresolved, true);
	assert.equal(recon.stats.per_status_skipped_unresolved, 1);
});

test('per-status: a bogus/malicious status key ("600", "__proto__") is dropped silently, never a failure and never a polluted prototype', () => {
	const doc = docWithOperationFields({
		responses: {
			'200': { description: 'ok', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Widget' } } } },
			'600': { description: 'not a real status', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Widget' } } } },
			'__proto__': { description: 'attack', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Widget' } } } },
		},
	}, { componentSchemas: { Widget: { type: 'object' } } });
	const { result } = reconcileCreateWidgetFields(doc);
	assert.deepEqual(Object.keys(result.sourceResponses), ['200']);
	assert.equal(Object.prototype.toJSON, undefined, 'the real global Object.prototype must be untouched');
});

test('per-status rides the schema-bearing dialect gate: a 3.0 document skips it entirely, perStatusResponsesSkippedDialect true', () => {
	const doc = docWithOperationFields({
		responses: { '200': { description: 'ok', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Widget' } } } } },
	}, { componentSchemas: { Widget: { type: 'object' } }, openapiVersion: '3.0.1' });
	const { recon, result } = reconcileCreateWidgetFields(doc);
	assert.equal(result.perStatusResponsesSkippedDialect, true);
	assert.equal('sourceResponses' in result, false);
	assert.equal(recon.stats.per_status_skipped_dialect, 1);
});

test('per-status: drift/missing/ambiguous/unresolved never get sourceResponses, even with a perfectly resolvable one in the doc', () => {
	const doc = {
		openapi: '3.1.0',
		components: { schemas: { Widget: { type: 'object' } } },
		paths: { '/totally/unrelated': { post: {
			operationId: 'createWidget',
			responses: { '200': { description: 'ok', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Widget' } } } } },
		} } },
	};
	const indexed = indexOpenApiDocument(doc);
	const recon = reconcileModule({ index: indexed, module: createWidgetModule(), pathPrefix: '/api/v0' });
	const result = recon.byEndpoint.get('0:0');
	assert.equal(result.kind, 'drift');
	assert.equal('sourceResponses' in result, false);
	assert.equal(recon.stats.per_status_copied, 0);
});

test('per-status: no responses key at all on the operation -> per_status_none, no sourceResponses key', () => {
	const doc = docWithOperationFields({});
	const { recon, result } = reconcileCreateWidgetFields(doc);
	assert.equal('sourceResponses' in result, false);
	assert.equal(recon.stats.per_status_none, 1);
});

test('per-status round-trip defense: a description that exactly matches PER_STATUS_NO_DESCRIPTION_STANDIN is never copied back in', () => {
	const doc = docWithOperationFields({
		responses: { '200': { description: PER_STATUS_NO_DESCRIPTION_STANDIN, content: { 'application/json': { schema: { '$ref': '#/components/schemas/Widget' } } } } },
	}, { componentSchemas: { Widget: { type: 'object' } } });
	const { result } = reconcileCreateWidgetFields(doc);
	assert.equal('description' in result.sourceResponses['200'], false, 'the exact stand-in string must never be treated as a real, source-authored description');
});

test('RESPONSE_STATUS_KEY_RE: accepts literal codes, range keys, and "default"; rejects anything else', () => {
	for (const ok of ['200', '404', '2XX', '4XX', '5XX', 'default']) assert.ok(RESPONSE_STATUS_KEY_RE.test(ok), ok);
	for (const bad of ['600', '99', 'default2', '__proto__', 'constructor', '']) assert.equal(RESPONSE_STATUS_KEY_RE.test(bad), false, bad);
});

// --- A8: non-JSON request media types ---

function docWithRequestBody(requestBody, { componentSchemas = {}, openapiVersion = '3.1.0' } = {}) {
	return {
		openapi: openapiVersion,
		components: { schemas: componentSchemas },
		paths: { '/api/v0/widgets': { post: { operationId: 'createWidget', requestBody } } },
	};
}

function reconcileCreateWidgetFields(doc) {
	const indexed = indexOpenApiDocument(doc);
	assert.equal(indexed.ok, true);
	const recon = reconcileModule({ index: indexed, module: createWidgetModule(), pathPrefix: '/api/v0' });
	return { recon, result: recon.byEndpoint.get('0:0') };
}

test('request media types: a real multipart/form-data body is copied with its schema resolved, and application/json is never present in this field', () => {
	const doc = docWithRequestBody(
		{ required: true, content: { 'multipart/form-data': { schema: { type: 'object', required: ['file'], properties: { file: { type: 'string', format: 'binary' } } } } } },
	);
	const { recon, result } = reconcileCreateWidgetFields(doc);
	assert.equal(result.sourceRequestBody.required, true);
	assert.deepEqual(Object.keys(result.sourceRequestBody.content), ['multipart/form-data']);
	assert.equal(result.sourceRequestBody.content['multipart/form-data'].schema.properties.file.format, 'binary');
	assert.equal(recon.stats.request_media_types_copied, 1);
});

test('request media types: application/json alongside multipart -- only the non-JSON media type is copied here (JSON stays A2\'s requestBodySchema, never duplicated)', () => {
	const doc = docWithRequestBody(
		{
			content: {
				'application/json': { schema: { '$ref': '#/components/schemas/CreateWidgetRequest' } },
				'multipart/form-data': { schema: { type: 'object' } },
			},
		},
		{ componentSchemas: { CreateWidgetRequest: { type: 'object' } } },
	);
	const { result } = reconcileCreateWidgetFields(doc);
	assert.ok(result.requestBodySchema, 'A2\'s own field still resolves the JSON side');
	assert.deepEqual(Object.keys(result.sourceRequestBody.content), ['multipart/form-data']);
	assert.equal('application/json' in result.sourceRequestBody.content, false);
});

test('request media types: a media type whose schema fails to resolve is still recorded (media type name is real and safe), just without a `schema` key -- and drives the new warning signal', () => {
	const doc = docWithRequestBody(
		{ content: { 'multipart/form-data': { schema: { type: 'object', discriminator: { propertyName: 'kind' } } } } },
	);
	const { result } = reconcileCreateWidgetFields(doc);
	assert.deepEqual(result.sourceRequestBody.content['multipart/form-data'], {});
	assert.equal(result.requestMediaTypesUnresolvedReason, 'schema-unresolved');
});

test('request media types: exceeding MAX_REQUEST_MEDIA_TYPES fails the whole media-type set closed for this operation, never partially', () => {
	const content = {};
	for (let i = 0; i < 20; i++) content[`application/vnd.widget-${i}+json`] = { schema: { type: 'object' } };
	const doc = docWithRequestBody({ content });
	const { recon, result } = reconcileCreateWidgetFields(doc);
	assert.equal('sourceRequestBody' in result, false);
	assert.equal(result.requestMediaTypesUnresolvedReason, 'too-many-media-types');
	assert.equal(recon.stats.request_media_types_unresolved, 1);
});

test('request media types ride the schema-bearing dialect gate: a 3.0 document skips them entirely, requestMediaTypesSkippedDialect true', () => {
	const doc = docWithRequestBody(
		{ content: { 'multipart/form-data': { schema: { type: 'object' } } } },
		{ openapiVersion: '3.0.1' },
	);
	const { recon, result } = reconcileCreateWidgetFields(doc);
	assert.equal(result.requestMediaTypesSkippedDialect, true);
	assert.equal('sourceRequestBody' in result, false);
	assert.equal(recon.stats.request_media_types_skipped_dialect, 1);
});

test('request media types: drift/missing/ambiguous/unresolved never get sourceRequestBody, even with a perfectly resolvable multipart body in the doc', () => {
	const doc = {
		openapi: '3.1.0',
		paths: { '/totally/unrelated': { post: {
			operationId: 'createWidget',
			requestBody: { content: { 'multipart/form-data': { schema: { type: 'object' } } } },
		} } },
	};
	const indexed = indexOpenApiDocument(doc);
	const recon = reconcileModule({ index: indexed, module: createWidgetModule(), pathPrefix: '/api/v0' });
	const result = recon.byEndpoint.get('0:0');
	assert.equal(result.kind, 'drift');
	assert.equal('sourceRequestBody' in result, false);
	assert.equal(recon.stats.request_media_types_copied, 0);
});

test('request media types: no requestBody at all, or a $ref requestBody -> request_media_types_none, no sourceRequestBody key', () => {
	const none1 = reconcileCreateWidgetFields(docWithRequestBody(null));
	assert.equal('sourceRequestBody' in none1.result, false);
	assert.equal(none1.recon.stats.request_media_types_none, 1);
	const { recon, result } = reconcileCreateWidgetFields(docWithRequestBody({ '$ref': '#/components/requestBodies/X' }));
	assert.equal('sourceRequestBody' in result, false);
	assert.equal(recon.stats.request_media_types_none, 1);
});

test('MEDIA_TYPE_RE: accepts real type/subtype media types, rejects anything without a "/" (structurally excludes __proto__/constructor)', () => {
	for (const ok of ['application/json', 'multipart/form-data', 'text/csv', 'application/vnd.api+json']) assert.ok(MEDIA_TYPE_RE.test(ok), ok);
	for (const bad of ['__proto__', 'constructor', 'toString', 'application', '']) assert.equal(MEDIA_TYPE_RE.test(bad), false, bad);
});

// --- A8: snapshot decision fields ---

test('snapshot decision fields: per_status_responses "copied:N" / "none" / "skipped:dialect" / "skipped:unresolved"', () => {
	assert.equal(snapshotOp(docWithOperationFields({})).per_status_responses, 'none');
	assert.equal(
		snapshotOp(docWithOperationFields({ responses: { '200': { content: { 'application/json': { schema: { '$ref': '#/components/schemas/Widget' } } } } } }, { componentSchemas: { Widget: { type: 'object' } } })).per_status_responses,
		'copied:1',
	);
	assert.equal(
		snapshotOp(docWithOperationFields({ responses: { '200': { content: { 'application/json': { schema: { '$ref': '#/components/schemas/Widget' } } } } } }, { componentSchemas: { Widget: { type: 'object' } }, openapiVersion: '3.0.1' })).per_status_responses,
		'skipped:dialect',
	);
	assert.equal(
		snapshotOp(docWithOperationFields({ responses: { '400': { content: { 'application/json': { schema: { '$ref': '#/components/schemas/Bad' } } } } } }, { componentSchemas: { Bad: { type: 'object', discriminator: { propertyName: 'k' } } } })).per_status_responses,
		'skipped:unresolved',
	);
});

test('snapshot decision fields: request_media_types "copied:N" / "partial:N" / "unresolved:X" / "none"', () => {
	assert.equal(snapshotOp(docWithOperationFields({})).request_media_types, 'none');
	assert.equal(
		snapshotOp(docWithOperationFields({ requestBody: { content: { 'multipart/form-data': { schema: { type: 'object' } } } } })).request_media_types,
		'copied:1',
	);
	assert.equal(
		snapshotOp(docWithOperationFields({ requestBody: { content: { 'multipart/form-data': { schema: { type: 'object', discriminator: { propertyName: 'k' } } } } } })).request_media_types,
		'partial:1',
	);
});
