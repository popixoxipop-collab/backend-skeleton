// G6 (D-javascript-express-adapter): end-to-end CLI tests for the javascript-express adapter --
// the fourth first-class adapter, alongside java-spring (G1), python-fastapi (G2) and
// typescript-express (G5). fixture/run() conventions copied from
// test/typescript-express-cli.test.mjs, which this file does not modify.
//
// Everything here goes through the real `bin/bskel.mjs` CLI against a real git repo, not through
// the adapter's exported functions -- the claim being tested is "a plain-JS Express app is
// visible to bskel", and only a real dispatch through the registry can establish that.
//
// The e2e fixture is a scratch copy of the committed test/fixtures/javascript-express/ tree (the
// same one test/conformance-harness.test.mjs covers from a different angle), so there is exactly
// one description of "what a real plain-JS Express + mysql2 app looks like" in this repo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, '..', 'bin', 'bskel.mjs');
const FIXTURE_SRC = path.join(__dirname, 'fixtures', 'javascript-express');

function run(args, cwd) {
	try {
		const stdout = execFileSync('node', [CLI, ...args], { cwd, encoding: 'utf8' });
		return { code: 0, stdout, stderr: '' };
	} catch (err) {
		return { code: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
	}
}

function initGitRepo(root) {
	execFileSync('git', ['init', '--quiet', '--initial-branch=develop'], { cwd: root });
	execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
	execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
	fs.writeFileSync(path.join(root, '.gitignore'), 'specs/\n.sbf/\n');
	execFileSync('git', ['add', '-A'], { cwd: root });
	execFileSync('git', ['commit', '--quiet', '-m', 'chore: fixture'], { cwd: root });
	const bareOrigin = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-javascript-express-origin-'));
	execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=develop'], { cwd: bareOrigin });
	execFileSync('git', ['remote', 'add', 'origin', bareOrigin], { cwd: root });
	execFileSync('git', ['push', '--quiet', 'origin', 'develop'], { cwd: root });
	return root;
}

function buildFixtureRepo() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-javascript-express-fixture-'));
	fs.cpSync(FIXTURE_SRC, root, { recursive: true });
	return initGitRepo(root);
}

function writeRepo(files) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-javascript-express-variant-'));
	for (const [rel, content] of Object.entries(files)) {
		const full = path.join(root, rel);
		fs.mkdirSync(path.dirname(full), { recursive: true });
		fs.writeFileSync(full, content);
	}
	return initGitRepo(root);
}

test('adapter selection: javascript-express is chosen for a plain-JS ESM Express app (specificity 80), high confidence', () => {
	const root = buildFixtureRepo();
	const scan = run(['scan', '--terms', 'user', '--json'], root);
	assert.equal(scan.code, 0, scan.stderr);
	const report = JSON.parse(scan.stdout);
	assert.equal(report.adapter, 'javascript-express');
	assert.equal(report.confidence, 'high');
});

// The headline regression this whole item exists for: before G6 this exact repo shape fell all
// the way through to generic-grep, which reports confidence "low", one lumped `_generic` module,
// and router-local paths with no prefix resolution at all.
test('regression: the same repo is NOT handled by generic-grep, and the mount graph beats what generic-grep could report', () => {
	const root = buildFixtureRepo();
	const report = JSON.parse(run(['scan', '--terms', 'user', '--json'], root).stdout);
	assert.notEqual(report.adapter, 'generic-grep');
	assert.ok(!report.related_modules.some((m) => m.module === '_generic'), 'no `_generic` lumping');
	const users = report.related_modules.find((m) => m.module === 'user');
	assert.ok(users, `expected a "user" module, got: ${report.related_modules.map((m) => m.module).join(', ')}`);
});

// The single most novel piece of this adapter: the `/api` prefix lives on an INTRA-FILE edge from
// the express() application to a locally-declared Router (`app.use('/api', route)`), and the next
// hop uses a Router variable named `route`, not `router`. Neither is representable in G5's
// file-to-file, `router`-hardcoded model.
test('mount graph: the real absolute path (/api/user/:userUid) comes from an intra-file app.use() edge plus a cross-file edge, through a Router variable named `route`', () => {
	const root = buildFixtureRepo();
	const report = JSON.parse(run(['scan', '--terms', 'user', '--json'], root).stdout);
	const users = report.related_modules.find((m) => m.module === 'user');
	const controller = users.controllers[0];
	assert.equal(controller.basePath, '/api/user');
	const paths = controller.endpoints.map((e) => `${e.verb} ${e.path}`);
	assert.deepEqual(paths, ['GET /api/user/list', 'GET /api/user/:userUid', 'PATCH /api/user/:userUid']);

	// Proof the prefix genuinely came from the mount graph and is not declared at the leaf.
	const routeFile = fs.readFileSync(path.join(root, 'backend', 'src', 'routes', 'user.route.js'), 'utf8');
	assert.ok(!routeFile.includes('/api'), 'the leaf route file must not declare the prefix itself');
	const appFile = fs.readFileSync(path.join(root, 'backend', 'src', 'app.js'), 'utf8');
	assert.ok(appFile.includes("const route = express.Router()"), 'the mid-tree Router must be named `route`, not `router`');
});

test('both real plain-JS idioms work: `express.Router()` via the default import AND a named `Router()` import', () => {
	const root = buildFixtureRepo();
	const report = JSON.parse(run(['scan', '--terms', 'user,order', '--json'], root).stdout);
	// user.route.js uses `import express from 'express'` + `express.Router()`
	const users = report.related_modules.find((m) => m.module === 'user');
	assert.equal(users.controllers[0].basePath, '/api/user');
	// order.route.js uses `import { Router } from 'express'` + `Router()`
	const orders = report.related_modules.find((m) => m.module === 'order');
	assert.ok(orders, 'expected an "order" module');
	assert.equal(orders.controllers[0].basePath, '/api/order');
});

test('balanced-paren middleware array: requireRole([\'admin\'], true) between the path and the handler does not truncate extraction', () => {
	const root = buildFixtureRepo();
	const report = JSON.parse(run(['scan', '--terms', 'user', '--json'], root).stdout);
	const users = report.related_modules.find((m) => m.module === 'user');
	const listRoute = users.controllers[0].endpoints.find((e) => e.path === '/api/user/list');
	assert.equal(listRoute.method, 'listUsers', 'the LAST positional argument is the handler, despite the nested-paren middleware array');
	const source = fs.readFileSync(path.join(root, 'backend', 'src', 'routes', 'user.route.js'), 'utf8');
	assert.equal(listRoute.line, source.split('\n').findIndex((l) => l.includes("router.get('/list'")) + 1);
});

test('commented-out routes in the fixture are not reported as live endpoints', () => {
	const root = buildFixtureRepo();
	const report = JSON.parse(run(['scan', '--terms', 'order', '--json'], root).stdout);
	const orders = report.related_modules.find((m) => m.module === 'order');
	const paths = orders.controllers[0].endpoints.map((e) => e.path);
	assert.deepEqual(paths, ['/api/order/search', '/api/order/:orderId']);
	const source = fs.readFileSync(path.join(root, 'backend', 'src', 'routes', 'order.route.js'), 'utf8');
	assert.ok(source.includes('legacy-list') && source.includes('bulk-import'), 'sanity: the fixture really does contain commented-out registrations');
});

// The honest half of this item. Every capability is false, and each refusal path is exercised for
// real rather than asserted from the descriptor.
test('capabilities declared honestly: all four false, and doctor detects this fixture', () => {
	const root = buildFixtureRepo();
	const report = JSON.parse(run(['doctor', '--json'], root).stdout);
	const info = report.adapters.find((a) => a.id === 'javascript-express');
	assert.ok(info, 'expected javascript-express listed in doctor output');
	assert.equal(info.capabilities['api.operations'], false);
	assert.equal(info.capabilities['api.request-shape'], false);
	assert.equal(info.capabilities['resource.fetch'], false);
	assert.equal(info.capabilities['codegen.handles'], false);
	assert.equal(info.detects, true);
});

test('no persistence entities are reported -- a raw mysql2 stack has no ORM metadata to read', () => {
	const root = buildFixtureRepo();
	const report = JSON.parse(run(['scan', '--terms', 'user,order', '--json'], root).stdout);
	for (const m of report.related_modules) {
		assert.deepEqual(m.entities, [], `module "${m.module}" must report zero entities`);
	}
	assert.match(report.api_surface_source, /raw SQL driver/);
});

function runWorkflowThroughScan(root, featureId, terms) {
	run(['preflight'], root);
	run(['feature', 'init', '--slug', featureId.replace(/^\d+-/, '')], root);
	const scan = run(['scan', '--feature', featureId, '--terms', terms, '--json'], root);
	run(['scan', 'disposition', '--feature', featureId, '--mode', 'extend', '--note', 'test'], root);
	return scan;
}

// confidence: 'high' is load-bearing, not cosmetic -- a feature-scoped scan by a `low`-confidence
// adapter refuses to write its report at all without --accept-low-confidence (exit 16).
test('a feature-scoped scan writes its report and passes the scan gate with no --accept-low-confidence needed', () => {
	const root = buildFixtureRepo();
	const scan = runWorkflowThroughScan(root, '001-user-management', 'user');
	// AWAITING_DISPOSITION(3), the honest verdict for a real collision -- and specifically NOT
	// LOW_CONFIDENCE_SCAN(16), which is what a generic-grep-scanned repo gets and which refuses to
	// write the report or touch the gate at all. That difference is the practical value of this
	// adapter existing.
	assert.equal(scan.code, 3, `expected AWAITING_DISPOSITION, got ${scan.code}: ${scan.stderr}`);
	assert.ok(fs.existsSync(path.join(root, 'specs', '001-user-management', 'brownfield-scan.json')));
	const gate = run(['gate', 'require', 'scan', '--feature', '001-user-management'], root);
	assert.equal(gate.code, 0, gate.stdout + gate.stderr);
});

test('contract emit refuses cleanly at exit 17 naming api.operations, and points at --openapi-file', () => {
	const root = buildFixtureRepo();
	runWorkflowThroughScan(root, '001-user-management', 'user');
	const result = run(['contract', 'emit', '--feature', '001-user-management'], root);
	assert.equal(result.code, 17);
	const output = result.stdout + result.stderr;
	assert.match(output, /api\.operations/);
	assert.match(output, /javascript-express/);
	assert.match(output, /--openapi-file/);
});

test('handles plan refuses cleanly at exit 17 naming codegen.handles -- G6 ships no codegen provider, and nothing is written', () => {
	const root = buildFixtureRepo();
	runWorkflowThroughScan(root, '001-user-management', 'user');
	run(['gate', 'force', 'contract', '--feature', '001-user-management', '--reason', 'scanner-only test'], root);
	const result = run(['handles', 'plan', '--feature', '001-user-management', '--module', 'user'], root);
	assert.equal(result.code, 17);
	const output = result.stdout + result.stderr;
	assert.match(output, /codegen\.handles/);
	assert.match(output, /javascript-express/);
	assert.ok(!fs.existsSync(path.join(root, 'backend', 'src', 'handles')), 'nothing may be written on a capability refusal');
});

// Scope honesty: CommonJS is out of scope BY CONSTRUCTION (a `require()` app has no `import ...
// from 'express'` for detect() to find), not by a special-case exclusion. It must fall back
// cleanly rather than be half-detected.
test('a CommonJS Express app is NOT claimed by this adapter -- it falls back to generic-grep', () => {
	const root = writeRepo({
		'package.json': JSON.stringify({ name: 'cjs-app', dependencies: { express: '^4.18.2' } }, null, 2),
		'src/routes/user.js': [
			"const express = require('express');",
			'const router = express.Router();',
			"router.get('/:id', (req, res) => res.json({}));",
			'module.exports = router;',
		].join('\n'),
	});
	const report = JSON.parse(run(['scan', '--terms', 'user', '--json'], root).stdout);
	assert.equal(report.adapter, 'generic-grep');
});

// The same package with "type": "module" IS in scope -- proving the gate is Node's own ESM rule,
// not an arbitrary filename convention. `.mjs` is ESM regardless of "type".
test('an .mjs source file is detected even without "type": "module" -- Node\'s own ESM rule, applied as written', () => {
	const root = writeRepo({
		'package.json': JSON.stringify({ name: 'mjs-app', dependencies: { express: '^4.18.2' } }, null, 2),
		'src/routes/widget.route.mjs': [
			"import { Router } from 'express';",
			'const router = Router();',
			"router.get('/:widgetId', showWidget);",
			'export default router;',
		].join('\n'),
	});
	const report = JSON.parse(run(['scan', '--terms', 'widget', '--json'], root).stdout);
	assert.equal(report.adapter, 'javascript-express');
	const widgets = report.related_modules.find((m) => m.module === 'widget');
	assert.ok(widgets, 'expected a "widget" module');
	assert.equal(widgets.controllers[0].endpoints[0].path, '/:widgetId');
});

// A .js file in a package WITHOUT "type": "module" is not ESM to Node, so it is not scanned --
// the honest consequence of applying Node's rule rather than globbing every .js file.
test('a .js source file in a non-module package is not scanned as ESM', () => {
	const root = writeRepo({
		'package.json': JSON.stringify({ name: 'ambiguous-app', dependencies: { express: '^4.18.2' } }, null, 2),
		'src/routes/widget.route.js': [
			"import { Router } from 'express';",
			'const router = Router();',
			"router.get('/:widgetId', showWidget);",
			'export default router;',
		].join('\n'),
	});
	const report = JSON.parse(run(['scan', '--terms', 'widget', '--json'], root).stdout);
	assert.notEqual(report.adapter, 'javascript-express');
});

// A cycle is only representable at all because mount nodes are (file, variable) pairs -- two
// routers in ONE file can mount each other. Without the `seen` guard this is infinite recursion,
// so this test is about terminating, not about the (arbitrary) prefix it settles on.
test('an intra-file mount cycle terminates instead of recursing forever', () => {
	const root = writeRepo({
		'package.json': JSON.stringify({ name: 'cycle-app', type: 'module', dependencies: { express: '^4.18.2' } }, null, 2),
		'src/routes/loop.route.js': [
			"import express from 'express';",
			'const a = express.Router();',
			'const b = express.Router();',
			"a.use('/x', b);",
			"b.use('/y', a);",
			"a.get('/:id', showThing);",
			'export default a;',
		].join('\n'),
	});
	const result = run(['scan', '--terms', 'loop', '--json'], root);
	assert.equal(result.code, 0, result.stderr);
	const report = JSON.parse(result.stdout);
	assert.equal(report.adapter, 'javascript-express');
	const loop = report.related_modules.find((m) => m.module === 'loop');
	assert.ok(loop, 'expected a "loop" module');
	assert.equal(loop.controllers[0].endpoints.length, 1);
});
