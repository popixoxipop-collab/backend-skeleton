// ROADMAP.md Phase 5c (D-oracle-corpus-openapi-remeasurement): a fast, local, non-network
// regression guard for scripts/openapi-corpus-measure.mjs's own counting logic -- the real
// measurement runs (against polarsource/polar's ~2.7MB real document) are recorded by hand in
// DECISIONS.md, not repeated here; this test only proves the SCRIPT itself counts correctly
// against a tiny, synthetic, fully-controlled OpenAPI document.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'openapi-corpus-measure.mjs');

const SYNTHETIC_DOC = {
	openapi: '3.1.0',
	info: { title: 'Synthetic', version: '1.0.0' },
	components: {
		schemas: {
			Widget: {
				type: 'object',
				properties: {
					id: { type: 'string', format: 'uuid' },
					_cost: { type: 'integer' },
					'cf-turnstile-response': { type: 'string' },
					code: { type: 'string', pattern: '^[A-Z]{3}$', example: 'ABC' },
				},
			},
			BadName: { type: 'object', properties: { $ref: { type: 'string' } } },
		},
		securitySchemes: { apiKey: { type: 'apiKey', in: 'header', name: 'X-API-Key' } },
	},
	paths: {
		'/widgets': {
			get: {
				operationId: 'listWidgets',
				description: 'Lists all widgets.',
				parameters: [
					{ name: 'a', in: 'query', schema: { type: 'string' } },
					{ name: 'b', in: 'query', schema: { type: 'string' } },
					{ name: 'c', in: 'query', schema: { type: 'string' } },
				],
				security: [{ apiKey: [] }],
				responses: {
					'200': { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/Widget' } } } },
					'400': { description: 'bad request' },
				},
			},
			post: {
				operationId: 'createWidget',
				title: 'Create a widget', // not a real Operation Object field, deliberately misplaced -- unrelated to the schema-scoped title check
				requestBody: { content: { 'application/json': { schema: { title: 'CreateWidget', type: 'object', properties: { name: { type: 'string' } } } } } },
				responses: {
					'201': { description: 'created', content: { 'application/json': { schema: { $ref: '#/components/schemas/Widget' } } } },
				},
			},
		},
	},
};

function runScript(filePath) {
	try {
		const stdout = execFileSync('node', [SCRIPT, filePath], { encoding: 'utf8' });
		return { code: 0, stdout };
	} catch (err) {
		return { code: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
	}
}

test('openapi-corpus-measure: counts every metric correctly against a small, fully-controlled synthetic document', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-openapi-corpus-measure-'));
	const docPath = path.join(dir, 'doc.json');
	try {
		fs.writeFileSync(docPath, JSON.stringify(SYNTHETIC_DOC));
		const r = runScript(docPath);
		assert.equal(r.code, 0, `expected a clean exit -- stderr: ${r.stderr}`);
		const report = JSON.parse(r.stdout);

		assert.equal(report.componentSchemas.count, 2);
		assert.deepEqual(report.componentSchemas.rejectedByComponentSchemaNameRe, []);
		assert.deepEqual(report.rejectedBySchemaPropertyNameRe.sort(), ['$ref']);

		assert.equal(report.operations.total, 2);
		assert.equal(report.operations.withNonEmptyDescription, 1);

		assert.equal(report.maxParametersPerOperation.value, 3);
		assert.equal(report.maxParametersPerOperation.operationId, 'listWidgets');

		assert.equal(report.maxResponsesPerOperation.value, 2);
		assert.equal(report.maxSecurityRequirementsPerOperation.value, 1);
		assert.equal(report.securitySchemesDocumentWide, 1);
		assert.equal(report.maxRequestMediaTypesPerOperation.value, 1);

		assert.equal(report.maxPatternLength.value, '^[A-Z]{3}$'.length);
		assert.equal(report.maxExampleLength.value, JSON.stringify('ABC').length);
		assert.deepEqual(report.formatHistogram, { uuid: 1 });

		// The synthetic doc's "title" fields are: Widget.properties has none, but createWidget's
		// requestBody schema has a real schema-level `title` ("CreateWidget") -- the Operation
		// Object's OWN `title` (a made-up, non-real OpenAPI field on the operation itself) must NOT
		// be counted, matching findUnsupportedAnnotations()'s own real schema-root scoping.
		assert.deepEqual(report.unsupportedAnnotationsFound, ['title']);

		assert.equal(report.responseObjects.total, 3);
		assert.equal(report.responseObjects.withRef, 0);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('openapi-corpus-measure: loads a .yaml document via the yaml package, not just JSON', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-openapi-corpus-measure-yaml-'));
	const docPath = path.join(dir, 'doc.yaml');
	try {
		fs.writeFileSync(docPath, 'openapi: 3.1.0\ninfo:\n  title: Synthetic\n  version: "1.0.0"\npaths: {}\n');
		const r = runScript(docPath);
		assert.equal(r.code, 0, `expected a clean exit -- stderr: ${r.stderr}`);
		const report = JSON.parse(r.stdout);
		assert.equal(report.operations.total, 0);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('openapi-corpus-measure: refuses with a clear message when no file path is given', () => {
	try {
		execFileSync('node', [SCRIPT], { encoding: 'utf8' });
		assert.fail('expected a non-zero exit');
	} catch (err) {
		assert.equal(err.status, 1);
		assert.match(err.stderr, /usage: node scripts\/openapi-corpus-measure\.mjs/);
	}
});
