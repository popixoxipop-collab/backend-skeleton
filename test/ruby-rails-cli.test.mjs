import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runScan } from '../scanners/index.mjs';
import { adapter, detectRubyRailsRoot, scanRubyRails } from '../scanners/adapters/ruby-rails.mjs';
import { buildContract } from '../contracts/emit.mjs';
import { buildReconciliation } from '../contracts/openapi.mjs';
import { validateAgainstSchema } from '../lib/schema-validate.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'ruby-rails', 'backend');
const CLI = path.join(HERE, '..', 'bin', 'bskel.mjs');

test('ruby-rails detects a real Rails application shape and wins registry dispatch', () => {
	assert.equal(detectRubyRailsRoot(FIXTURE), FIXTURE);
	const report = runScan({ repoRoot: FIXTURE, terms: ['article'] });
	assert.equal(report.adapter, 'ruby-rails');
	assert.equal(report.confidence, 'high');
	assert.match(report.api_surface_source, /conservative static analysis/);
});

test('detection accepts a direct railties dependency (production Rails apps need not use the rails meta-gem)', () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-rails-railties-'));
	fs.cpSync(FIXTURE, root, { recursive: true });
	fs.writeFileSync(path.join(root, 'Gemfile'), 'source "https://rubygems.org"\ngem "railties", "~> 8.1"\n');
	assert.equal(detectRubyRailsRoot(root), root);
});

test('a Rails checkout physically located beneath an OS tmp directory is not excluded as its own tmp/ subtree', () => {
	const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-rails-absolute-tmp-parent-'));
	const root = path.join(parent, 'app');
	fs.cpSync(FIXTURE, root, { recursive: true });
	const report = runScan({ repoRoot: root, terms: [] });
	assert.equal(report.adapter, 'ruby-rails');
	assert.ok(report.related_modules.length > 0);
});

test('static Rails scan expands resources, preserves provenance, and extracts explicit Active Record metadata', () => {
	const result = scanRubyRails(FIXTURE, FIXTURE);
	const articles = result.modules.find((m) => m.module === 'articles');
	assert.ok(articles);
	const controller = articles.controllers[0];
	assert.equal(controller.className, 'Api::V1::ArticlesController');
	assert.equal(controller.basePath, '/api/v1/articles');
	assert.equal(controller.declarations.length, 1);
	assert.equal(controller.declarations[0].rule, 'ruby-rails:resources');
	assert.equal(controller.endpoints.length, 8); // 6 from only: (PATCH+PUT update) + member + collection
	assert.ok(controller.endpoints.every((ep) => ep.operationIdSource === 'bskel-synthesized'));
	assert.equal(new Set(controller.endpoints.map((ep) => ep.operationId)).size, controller.endpoints.length);
	assert.ok(controller.endpoints.some((ep) => ep.path === '/api/v1/articles/{id}/preview'));
	assert.ok(controller.endpoints.some((ep) => ep.path === '/api/v1/articles/featured'));
	const entity = articles.entities.find((e) => e.className === 'Article');
	assert.equal(entity.table, 'published_articles');
	assert.equal(entity.tableSource, 'explicit');
	assert.equal(entity.idField, 'article_id');
	assert.ok(result.scanNotes.some((n) => n.includes('unsupported-dsl')));
	assert.ok(result.scanNotes.some((n) => n.includes('dynamic-path')));
});

test('resource singleton expands show + PATCH/PUT update and explicit route remains one-to-one', () => {
	const result = scanRubyRails(FIXTURE, FIXTURE);
	const profiles = result.modules.find((m) => m.module === 'profiles').controllers[0];
	assert.deepEqual(profiles.endpoints.map((e) => `${e.verb} ${e.path}`), [
		'GET /profile', 'PATCH /profile', 'PUT /profile',
	]);
	const health = result.modules.find((m) => m.module === 'health').controllers[0];
	assert.deepEqual(health.endpoints.map((e) => `${e.verb} ${e.path}`), ['GET /health']);
});

test('contract emit works without OpenAPI and discloses synthesized operation identity', () => {
	const scanReport = runScan({ repoRoot: FIXTURE, terms: ['article'] });
	const contract = buildContract({ featureId: '001-article-management', featureUid: '4c8de69b-2a4a-40c0-9749-491bc3c41ae2', scanReport, module: 'articles' });
	assert.equal(contract.completeness.operation_count, 8);
	assert.ok(Object.values(contract.operations).every((op) => op.provenance === 'scan-synthesized'));
	assert.ok(Object.values(contract.operations).some((op) => op.expansion?.rule === 'ruby-rails:resources'));
});

test('OpenAPI reconciliation adopts a source operationId for a synthesized Rails endpoint by exact verb/path', () => {
	const scanReport = runScan({ repoRoot: FIXTURE, terms: ['health'] });
	const module = scanReport.related_modules.find((m) => m.module === 'health');
	const doc = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-rails-openapi-')), 'openapi.json');
	fs.writeFileSync(doc, JSON.stringify({ openapi: '3.1.0', info: { title: 'x', version: '1' }, paths: { '/health': { get: { operationId: 'healthCheck', responses: { '200': { description: 'ok' } } } } } }));
	const reconciliation = buildReconciliation({ filePath: doc, module, pathPrefix: null, includeDescriptions: false });
	const contract = buildContract({ featureId: '001-health', featureUid: '4c8de69b-2a4a-40c0-9749-491bc3c41ae2', scanReport, module: 'health', openapi: reconciliation });
	assert.ok(contract.operations.healthCheck);
	assert.equal(contract.operations.healthCheck.provenance, 'openapi');
});

test('an unmatched OpenAPI document keeps the synthesized id but surfaces the normal completeness error', () => {
	const scanReport = runScan({ repoRoot: FIXTURE, terms: ['health'] });
	const module = scanReport.related_modules.find((m) => m.module === 'health');
	const synthesizedId = module.controllers[0].endpoints[0].operationId;
	const doc = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-rails-openapi-missing-')), 'openapi.json');
	fs.writeFileSync(doc, JSON.stringify({ openapi: '3.1.0', info: { title: 'x', version: '1' }, paths: { '/other': { get: { operationId: 'other', responses: { '200': { description: 'ok' } } } } } }));
	const reconciliation = buildReconciliation({ filePath: doc, module, pathPrefix: null, includeDescriptions: false });
	const contract = buildContract({ featureId: '001-health', featureUid: '4c8de69b-2a4a-40c0-9749-491bc3c41ae2', scanReport, module: 'health', openapi: reconciliation });
	assert.equal(contract.operations[synthesizedId].provenance, 'scan-synthesized');
	assert.ok(contract.warnings.some((w) => w.code === 'CONTRACT_OPENAPI_MISSING_OPERATION' && w.subject === synthesizedId));
});

test('runtime routes are explicit, authoritative, and carry machine-readable provenance', () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-rails-runtime-'));
	fs.cpSync(FIXTURE, root, { recursive: true });
	fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
	const bin = path.join(root, 'bin', 'rails');
	fs.writeFileSync(bin, `#!/bin/sh
cat <<'OUT'
--[ Route 1 ]----------------------------------------------------
Prefix            | health
Verb              | GET
URI               | /health(.:format)
Controller#Action | health#show
Source Location   | ${path.join(root, 'config', 'routes.rb')}:16
--[ Route 2 ]----------------------------------------------------
Prefix            | dynamic
Verb              | POST
URI               | /computed(.:format)
Controller#Action | health#show
Source Location   | ${path.join(root, 'config', 'routes.rb')}:19
OUT
`);
	fs.chmodSync(bin, 0o755);
	const report = runScan({ repoRoot: root, terms: [], adapters: [adapter], runtimeRoutes: true });
	assert.deepEqual(report.runtime_introspection, {
		kind: 'rails-routes', command: ['bin/rails', 'routes', '--expanded'], project_root: '.', rails_env: 'development', status: 'used',
	});
	const health = report.related_modules.find((m) => m.module === 'health');
	assert.deepEqual(health.controllers[0].endpoints.map((e) => `${e.verb} ${e.path}`), ['POST /computed', 'GET /health']);
	assert.match(report.api_surface_source, /Rails-computed route table/);
	const validation = validateAgainstSchema('scan-report.schema.json', report);
	assert.equal(validation.ok, true, validation.errors?.join('; '));
	execFileSync('git', ['init', '-q'], { cwd: root });
	const cliReport = JSON.parse(execFileSync(process.execPath, [CLI, 'scan', '--runtime-routes', '--json'], { cwd: root, encoding: 'utf8' }));
	assert.equal(cliReport.runtime_introspection.status, 'used');
	assert.match(cliReport.api_surface_source, /Rails-computed route table/);
});

test('--runtime-routes refuses adapters without an introspection hook', () => {
	const weak = { ...adapter, id: 'fixture-no-runtime', introspectRoutes: undefined, detect: () => FIXTURE };
	assert.throws(() => runScan({ repoRoot: FIXTURE, terms: [], adapters: [weak], runtimeRoutes: true }), (err) => err.code === 'RUNTIME_ROUTES_UNSUPPORTED');
});
