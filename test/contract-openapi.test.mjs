// A1: pure unit tests for contracts/openapi.mjs -- no git repo, no CLI, no real filesystem
// except loadOpenApiDocument's own file-reading tests (temp files only).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
	loadOpenApiDocument, indexOpenApiDocument, inferPathPrefix, reconcileModule,
	normalizeRoute, OPERATION_ID_RE, PATH_PREFIX_RE,
} from '../contracts/openapi.mjs';

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
