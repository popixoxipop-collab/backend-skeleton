// G3: end-to-end CLI tests for the generic-grep adapter (non-Java fallback) -- reconnaissance
// only, gated behind --accept-low-confidence. Fixture/helper conventions copied from
// test/scan-cli.test.mjs, which this file does not modify and which stays Java-Spring-only.
// See DECISIONS.md D-generic-grep-reconnaissance.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, '..', 'bin', 'bskel.mjs');

function run(args, cwd) {
	try {
		const stdout = execFileSync('node', [CLI, ...args], { cwd, encoding: 'utf8' });
		return { code: 0, stdout };
	} catch (err) {
		return { code: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
	}
}

// Express (many routes in one file, to exercise the scoring-inflation fix) + a FastAPI file (to
// exercise the express-router/fastapi regex-overlap fix) + a Flask file (verb stays '?'). No
// build.gradle/src/main/java anywhere, so scanJavaSpring() returns null and runScan() falls
// through to the generic-grep adapter.
function buildFixtureRepo() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-generic-grep-fixture-'));
	execFileSync('git', ['init', '--quiet', '--initial-branch=develop'], { cwd: root });
	execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
	execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
	fs.writeFileSync(path.join(root, 'package.json'), '{"name": "fixture"}\n');

	fs.mkdirSync(path.join(root, 'routes'), { recursive: true });
	const widgetRoutes = Array.from({ length: 15 }, (_, i) => `router.get('/widgets/${i}', h${i});`).join('\n');
	fs.writeFileSync(path.join(root, 'routes', 'widgets.js'), `
const express = require('express');
const router = express.Router();
${widgetRoutes}
router.post('/widgets', createWidget);
module.exports = router;
`);
	fs.writeFileSync(path.join(root, 'main.py'), `
from fastapi import APIRouter
router = APIRouter()

@router.get('/items')
def list_items(): pass

@router.post('/items')
def create_item(): pass
`);
	fs.writeFileSync(path.join(root, 'app.py'), `
from flask import Flask
app = Flask(__name__)

@app.route('/health')
def health(): pass
`);

	fs.writeFileSync(path.join(root, '.gitignore'), 'specs/\n.sbf/\n');
	execFileSync('git', ['add', '-A'], { cwd: root });
	execFileSync('git', ['commit', '--quiet', '-m', 'chore: fixture'], { cwd: root });
	const bareOrigin = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-generic-grep-origin-'));
	execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=develop'], { cwd: bareOrigin });
	execFileSync('git', ['remote', 'add', 'origin', bareOrigin], { cwd: root });
	execFileSync('git', ['push', '--quiet', 'origin', 'develop'], { cwd: root });
	return root;
}

test('ad-hoc scan (no --feature) reports adapter/confidence and is unaffected by --accept-low-confidence -- read-only regardless', () => {
	const root = buildFixtureRepo();
	const scan = run(['scan', '--terms', 'widget', '--json'], root);
	assert.equal(scan.code, 0);
	const report = JSON.parse(scan.stdout);
	assert.equal(report.adapter, 'generic-grep');
	assert.equal(report.confidence, 'low');
	assert.ok(!fs.existsSync(path.join(root, 'specs')));
	assert.ok(!fs.existsSync(path.join(root, '.sbf')));
});

test('verb is extracted correctly per framework: GET/POST for express-router and fastapi, "?" for flask', () => {
	const root = buildFixtureRepo();
	const scan = run(['scan', '--terms', 'widget,item,health', '--json'], root);
	const report = JSON.parse(scan.stdout);
	const controllers = report.related_modules[0].controllers;

	const widgetController = controllers.find((c) => c.file.endsWith('widgets.js'));
	assert.equal(widgetController.className, 'express-router');
	assert.ok(widgetController.endpoints.every((e) => e.verb === 'GET' || e.verb === 'POST'));

	const fastapiController = controllers.find((c) => c.file.endsWith('main.py'));
	assert.equal(fastapiController.className, 'fastapi', 'must not be misclassified as express-router (regex-overlap regression)');
	assert.deepEqual(fastapiController.endpoints.map((e) => e.verb).sort(), ['GET', 'POST']);
	assert.equal(fastapiController.endpoints.length, 2, 'each FastAPI route must be counted once, not once per overlapping pattern');

	const flaskController = controllers.find((c) => c.file.endsWith('app.py'));
	assert.equal(flaskController.endpoints[0].verb, '?');
});

test('file:line evidence matches the actual source position', () => {
	const root = buildFixtureRepo();
	const scan = run(['scan', '--terms', 'item', '--json'], root);
	const report = JSON.parse(scan.stdout);
	const fastapiController = report.related_modules[0].controllers.find((c) => c.file.endsWith('main.py'));
	const getItems = fastapiController.endpoints.find((e) => e.verb === 'GET');
	const sourceText = fs.readFileSync(fastapiController.file, 'utf8');
	const actualLine = sourceText.split('\n').findIndex((l) => l.includes("@router.get('/items')")) + 1;
	assert.equal(getItems.line, actualLine);
});

test('routes are grouped by file, not one fake controller per route -- fixes the scoring-inflation bug', () => {
	const root = buildFixtureRepo();
	const scan = run(['scan', '--terms', 'widget', '--json'], root);
	const report = JSON.parse(scan.stdout);
	const widgetController = report.related_modules[0].controllers.filter((c) => c.file.endsWith('widgets.js'));
	assert.equal(widgetController.length, 1, '16 routes in one file must produce exactly 1 controller-like unit, not 16');
	assert.equal(widgetController[0].endpoints.length, 16);
	assert.equal(widgetController[0].basePath, '/widgets', 'basePath must be the real shared path prefix, not one route\'s full path');
});

test('bskel scan --feature blocks a low-confidence scan with exit 16, writing neither specs/ nor .sbf/, without --accept-low-confidence', () => {
	const root = buildFixtureRepo();
	run(['preflight'], root);
	run(['feature', 'init', '--slug', 'widget-management'], root);
	const scan = run(['scan', '--feature', '001-widget-management', '--terms', 'widget', '--json'], root);
	assert.equal(scan.code, 16);
	assert.ok(!fs.existsSync(path.join(root, 'specs', '001-widget-management', 'brownfield-scan.json')));
	// .sbf/ itself already exists from `preflight` above -- assert the SCAN gate specifically was
	// never touched, not that the whole (legitimately preflight-populated) directory is empty.
	const gateResult = run(['gate', 'require', 'scan', '--feature', '001-widget-management'], root);
	assert.equal(gateResult.code, 2, 'scan gate must still be not_run -- the blocked scan must not have written any gate state');
	// The report is still shown, so a human can see WHY it was blocked.
	const report = JSON.parse(scan.stdout);
	assert.equal(report.confidence, 'low');
});

test('--accept-low-confidence proceeds normally: writes specs/, sets the scan gate, matches java-spring\'s verdict->gate mapping', () => {
	const root = buildFixtureRepo();
	run(['preflight'], root);
	run(['feature', 'init', '--slug', 'widget-management'], root);
	const scan = run(['scan', '--feature', '001-widget-management', '--terms', 'widget', '--accept-low-confidence', '--json'], root);
	assert.equal(scan.code, 3, 'a real collision verdict should still await disposition, same as java-spring');
	assert.ok(fs.existsSync(path.join(root, 'specs', '001-widget-management', 'brownfield-scan.json')));

	const gateResult = run(['gate', 'require', 'scan', '--feature', '001-widget-management'], root);
	assert.equal(gateResult.code, 3);
});

test('an unrelated term still reports greenfield, but a low-confidence greenfield scan is ALSO blocked without --accept-low-confidence', () => {
	const root = buildFixtureRepo();
	run(['preflight'], root);
	run(['feature', 'init', '--slug', 'unrelated-topic'], root);
	const scan = run(['scan', '--feature', '001-unrelated-topic', '--terms', 'unrelated-topic', '--json'], root);
	assert.equal(scan.code, 16, 'greenfield must not bypass the low-confidence gate -- this used to auto-pass with zero confidence-awareness');

	const accepted = run(['scan', '--feature', '001-unrelated-topic', '--terms', 'unrelated-topic', '--accept-low-confidence', '--json'], root);
	assert.equal(accepted.code, 0);
	const report = JSON.parse(accepted.stdout);
	assert.equal(report.verdict, 'greenfield');
});

// G1: this whole path (a generic-grep-scanned feature reaching contract/handles) was completely
// untested before this item -- confirmed by Explore before writing it. Before G1, `contract emit`
// wrote a near-empty contract and blocked with an unrelated hint ("fix --module/--terms"), and
// `handles plan`/`handles emit` fell all the way through to detectBasePackageOrExit's "is this a
// Spring Boot project?" -- a message that reads as a broken Spring detector, not "this adapter
// doesn't support handle codegen". See D-adapter-registry in DECISIONS.md.
test('generic-grep-scanned feature: `contract emit` is blocked by the api.operations capability check, and writes nothing', () => {
	const root = buildFixtureRepo();
	run(['preflight'], root);
	run(['feature', 'init', '--slug', 'widget-management'], root);
	run(['scan', '--feature', '001-widget-management', '--terms', 'widget', '--accept-low-confidence', '--json'], root);
	run(['scan', 'disposition', '--feature', '001-widget-management', '--mode', 'extend', '--note', 'test'], root);

	const result = run(['contract', 'emit', '--feature', '001-widget-management'], root);
	assert.equal(result.code, 17);
	assert.match(result.stderr, /api\.operations/);
	assert.match(result.stderr, /generic-grep/);
	assert.ok(
		!fs.existsSync(path.join(root, 'specs', '001-widget-management', 'contracts', '001-widget-management.schema.json')),
		'no contract file should be written when the capability check blocks',
	);
	const gate = run(['gate', 'require', 'contract', '--feature', '001-widget-management'], root);
	assert.equal(gate.code, 2, 'contract gate must still be not_run');
});

test('generic-grep-scanned feature: `handles plan` is blocked by the capability check, and never falls through to the misleading "is this a Spring Boot project?" message', () => {
	const root = buildFixtureRepo();
	run(['preflight'], root);
	run(['feature', 'init', '--slug', 'widget-management'], root);
	run(['scan', '--feature', '001-widget-management', '--terms', 'widget', '--accept-low-confidence', '--json'], root);

	const result = run(['handles', 'plan', '--feature', '001-widget-management'], root);
	assert.equal(result.code, 17);
	// G4: COMMAND_CAPABILITIES['handles plan'] is now JUST ['codegen.handles'] -- resource.fetch
	// moved onto each provider's own requiresCapabilities, which is never even reached here since
	// no provider exists for generic-grep at all (confirmed by the biconditional drift guard in
	// test/handles-provider-registry.test.mjs). The message must name the REAL blocker.
	assert.match(result.stderr, /codegen\.handles/);
	assert.ok(!result.stderr.includes('resource.fetch'), 'resource.fetch is no longer checked at dispatch time -- must not misattribute to it');
	assert.ok(!result.stderr.includes('is this a Spring Boot project?'), 'must not fall through to the misleading Java-specific message');
});

// G2: CAPABILITY_SATISFIERS (scanners/capabilities.mjs) is deliberately data keyed by capability,
// not by adapter -- so this widening applies to ANY adapter honestly declaring api.operations:
// false, generic-grep included, not just python-fastapi. Accepted rather than special-cased: doing
// otherwise would reintroduce the adapter-name hardcoding G1 removed, and the failure mode is
// self-limiting -- generic-grep's `_generic` lumping means nothing has a resolvable route either,
// so this still ends up honestly `blocked`, never a false success. See D-fastapi-adapter in
// DECISIONS.md.
test('generic-grep + --openapi-file also bypasses the capability gate (by the same generic mechanism as python-fastapi), and still ends up honestly blocked', () => {
	const root = buildFixtureRepo();
	run(['preflight'], root);
	run(['feature', 'init', '--slug', 'widget-management'], root);
	run(['scan', '--feature', '001-widget-management', '--terms', 'widget', '--accept-low-confidence', '--json'], root);
	run(['scan', 'disposition', '--feature', '001-widget-management', '--mode', 'extend', '--note', 'test'], root);

	const docPath = path.join(root, 'openapi.json');
	fs.writeFileSync(docPath, JSON.stringify({ openapi: '3.1.0', paths: { '/widgets': { get: { operationId: 'widgets-list', responses: {} } } } }));

	const result = run(['contract', 'emit', '--feature', '001-widget-management', '--openapi-file', docPath], root);
	assert.notEqual(result.code, 17, 'the capability gate itself must be bypassed once --openapi-file is given, same as any other adapter');
	const contract = JSON.parse(fs.readFileSync(path.join(root, 'specs', '001-widget-management', 'contracts', '001-widget-management.schema.json'), 'utf8'));
	assert.equal(contract.completeness.status, 'blocked', 'generic-grep\'s _generic lumping leaves every endpoint unresolvable regardless -- honest blocked, never a false success');
});

test('generic-grep-scanned feature: `handles emit` is blocked by the capability check even after forcing past the contract gate, and touches no files or the handles gate', () => {
	const root = buildFixtureRepo();
	run(['preflight'], root);
	run(['feature', 'init', '--slug', 'widget-management'], root);
	run(['scan', '--feature', '001-widget-management', '--terms', 'widget', '--accept-low-confidence', '--json'], root);
	run(['gate', 'force', 'contract', '--feature', '001-widget-management', '--reason', 'test: force past a capability-blocked contract'], root);
	run(['scan', 'cross-feature-check', '--feature', '001-widget-management'], root); // D-cross-feature-collision: single-feature fixture, always passes -- must run so the capability check below is what actually blocks

	const result = run(['handles', 'emit', '--feature', '001-widget-management'], root);
	assert.equal(result.code, 17);
	assert.match(result.stderr, /codegen\.handles/);
	assert.ok(!result.stderr.includes('is this a Spring Boot project?'));
	const gate = run(['gate', 'require', 'handles', '--feature', '001-widget-management'], root);
	assert.equal(gate.code, 2, 'handles gate must still be not_run');
});
