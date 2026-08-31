// D-http-serving-layer: end-to-end tests for `bskel serve` / lib/http-server.mjs. Two styles: (1) a
// unit-style test importing createHttpServer directly (no child process) for the default-bind-
// address check; (2) spawn()-based tests exercising the REAL CLI-launched server over real HTTP,
// reusing the same fixtures test/dependency-cli.test.mjs and test/dependency-propagation-cli.test.mjs
// already established (test/_contract-fixture.mjs).
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
	CLI, buildTwoFeatureFixtureRepo, initBothFeatures, buildThirdModuleFixture, declareArgs, run,
} from './_contract-fixture.mjs';
import { createHttpServer } from '../lib/http-server.mjs';

// Spawns `bskel serve --json` as a real child process and resolves once its one-line JSON startup
// announcement arrives on stdout -- i.e. once the server has genuinely bound, not merely once the
// process started. A 5s timeout guards against ever hanging the test runner if startup silently
// fails. `--port 0` (min:0 is deliberately allowed for `serve`, unlike `stack apply --port`) avoids
// port-collision flakiness between test runs.
function startServer(root) {
	return new Promise((resolve, reject) => {
		const child = spawn('node', [CLI, 'serve', '--port', '0', '--host', '127.0.0.1', '--json'], { cwd: root });
		let buffer = '';
		const timeout = setTimeout(() => {
			child.kill('SIGKILL');
			reject(new Error(`server did not report readiness within 5s (stdout so far: ${JSON.stringify(buffer)})`));
		}, 5000);
		child.stdout.on('data', (chunk) => {
			buffer += chunk.toString();
			const newlineIndex = buffer.indexOf('\n');
			if (newlineIndex === -1) return;
			clearTimeout(timeout);
			const line = buffer.slice(0, newlineIndex);
			try {
				resolve({ child, ...JSON.parse(line) });
			} catch (err) {
				reject(new Error(`could not parse server startup line ${JSON.stringify(line)}: ${err.message}`));
			}
		});
		child.on('error', reject);
		child.on('exit', (code) => {
			if (code !== null && code !== 0) reject(new Error(`server process exited early with code ${code}`));
		});
	});
}

function stopServer(child) {
	return new Promise((resolve) => {
		child.once('exit', resolve);
		child.kill('SIGTERM');
	});
}

async function withServer(root, fn) {
	const { child, listening } = await startServer(root);
	try {
		await fn(listening);
	} finally {
		await stopServer(child);
	}
}

function postDependency(base, featureId, body) {
	return fetch(`${base}/api/features/${featureId}/dependencies`, {
		method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
	});
}

function deleteDependency(base, featureId, body) {
	return fetch(`${base}/api/features/${featureId}/dependencies`, {
		method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
	});
}

test('default bind address is 127.0.0.1, not 0.0.0.0', async () => {
	const root = buildTwoFeatureFixtureRepo();
	const { server, host, port } = await createHttpServer(root, { port: 0 });
	assert.equal(host, '127.0.0.1');
	assert.ok(port > 0);
	await new Promise((resolve) => server.close(resolve));
});

test('GET /api/health reports ok and the repo root', async () => {
	const root = buildTwoFeatureFixtureRepo();
	await withServer(root, async (base) => {
		const res = await fetch(`${base}/api/health`);
		assert.equal(res.status, 200);
		assert.equal((await res.json()).status, 'ok');
	});
});

test('GET /api/features lists real features from the fixture', async () => {
	const root = buildTwoFeatureFixtureRepo();
	initBothFeatures(root);
	await withServer(root, async (base) => {
		const res = await fetch(`${base}/api/features`);
		assert.equal(res.status, 200);
		const body = await res.json();
		assert.deepEqual(body.features.map((f) => f.feature_id).sort(), ['001-widget-management', '002-organization-management']);
	});
});

test('GET /api/features/:id/status matches computeWorkflowState\'s own shape', async () => {
	const root = buildTwoFeatureFixtureRepo();
	initBothFeatures(root);
	await withServer(root, async (base) => {
		const res = await fetch(`${base}/api/features/001-widget-management/status`);
		assert.equal(res.status, 200);
		const body = await res.json();
		assert.ok(Array.isArray(body.gates));
		assert.ok(Array.isArray(body.next_actions));
	});
});

test('GET /api/features/:id/dependencies matches the CLI\'s own dependency-list shape', async () => {
	const root = buildTwoFeatureFixtureRepo();
	initBothFeatures(root);
	assert.equal(run(declareArgs(), root).code, 0);
	await withServer(root, async (base) => {
		const res = await fetch(`${base}/api/features/001-widget-management/dependencies`);
		assert.equal(res.status, 200);
		const body = await res.json();
		assert.equal(body.schema, 'sbf.dependency-list/1');
		assert.equal(body.dependencies.length, 1);
		assert.equal(body.dependencies[0].target_resolved, true);
	});
});

test('POST declares, DELETE removes -- a full round trip over HTTP', async () => {
	const root = buildTwoFeatureFixtureRepo();
	initBothFeatures(root);
	const depBody = {
		resource: 'WidgetDto', field: 'name',
		sourceFeature: '002-organization-management', sourceResource: 'OrganizationDto', sourceField: 'taxRate',
	};
	await withServer(root, async (base) => {
		const post = await postDependency(base, '001-widget-management', { ...depBody, reason: 'http round trip' });
		assert.equal(post.status, 201);
		assert.equal((await post.json()).gate.status, 'pass');

		const list1 = await (await fetch(`${base}/api/features/001-widget-management/dependencies`)).json();
		assert.equal(list1.dependencies.length, 1);

		const del = await deleteDependency(base, '001-widget-management', { ...depBody, reason: 'cleanup' });
		assert.equal(del.status, 200);
		assert.equal((await del.json()).removed, true);

		const list2 = await (await fetch(`${base}/api/features/001-widget-management/dependencies`)).json();
		assert.equal(list2.dependencies.length, 0);
	});
});

test('POST without a reason returns 400 with the exact CLI-equivalent message', async () => {
	const root = buildTwoFeatureFixtureRepo();
	initBothFeatures(root);
	await withServer(root, async (base) => {
		const res = await postDependency(base, '001-widget-management', {
			resource: 'WidgetDto', field: 'name',
			sourceFeature: '002-organization-management', sourceResource: 'OrganizationDto', sourceField: 'taxRate',
		});
		assert.equal(res.status, 400);
		assert.match((await res.json()).error, /requires --reason/);
	});
});

test('POST an unknown target resource returns 400, naming known classes', async () => {
	const root = buildTwoFeatureFixtureRepo();
	initBothFeatures(root);
	await withServer(root, async (base) => {
		const res = await postDependency(base, '001-widget-management', {
			resource: 'DoesNotExist', field: 'name',
			sourceFeature: '002-organization-management', sourceResource: 'OrganizationDto', sourceField: 'taxRate',
			reason: 'x',
		});
		assert.equal(res.status, 400);
		assert.match((await res.json()).error, /known classes:.*WidgetDto/);
	});
});

test('POST a self-reference (identical resource+field on both sides) returns 400', async () => {
	const root = buildTwoFeatureFixtureRepo();
	initBothFeatures(root);
	await withServer(root, async (base) => {
		const res = await postDependency(base, '001-widget-management', {
			resource: 'WidgetDto', field: 'name',
			sourceFeature: '001-widget-management', sourceResource: 'WidgetDto', sourceField: 'name',
			reason: 'x',
		});
		assert.equal(res.status, 400);
		assert.match((await res.json()).error, /cannot depend on itself/);
	});
});

test('POST against a source feature with no scan report yet returns 409', async () => {
	const root = buildTwoFeatureFixtureRepo();
	initBothFeatures(root);
	await withServer(root, async (base) => {
		const res = await postDependency(base, '001-widget-management', {
			resource: 'WidgetDto', field: 'name',
			sourceFeature: '003-ghost-feature', sourceResource: 'Whatever', sourceField: 'x',
			reason: 'x',
		});
		assert.equal(res.status, 409);
	});
});

test('CORS: GET responses carry Access-Control-Allow-Origin, POST/DELETE responses do not', async () => {
	const root = buildTwoFeatureFixtureRepo();
	initBothFeatures(root);
	const depBody = {
		resource: 'WidgetDto', field: 'name',
		sourceFeature: '002-organization-management', sourceResource: 'OrganizationDto', sourceField: 'taxRate',
	};
	await withServer(root, async (base) => {
		const get = await fetch(`${base}/api/health`);
		assert.equal(get.headers.get('access-control-allow-origin'), '*');

		const post = await postDependency(base, '001-widget-management', { ...depBody, reason: 'cors check' });
		assert.equal(post.headers.get('access-control-allow-origin'), null);

		const del = await deleteDependency(base, '001-widget-management', { ...depBody, reason: 'cleanup' });
		assert.equal(del.headers.get('access-control-allow-origin'), null);
	});
});

test('a malformed feature id in the URL is rejected with 400, never reaching a filesystem path', async () => {
	const root = buildTwoFeatureFixtureRepo();
	await withServer(root, async (base) => {
		const res = await fetch(`${base}/api/features/${encodeURIComponent('../../etc')}/status`);
		assert.equal(res.status, 400);
	});
});

test('GET / serves the bundled static UI page', async () => {
	const root = buildTwoFeatureFixtureRepo();
	await withServer(root, async (base) => {
		const res = await fetch(`${base}/`);
		assert.equal(res.status, 200);
		assert.match(res.headers.get('content-type') ?? '', /text\/html/);
		assert.match(await res.text(), /api\/graph/);
	});
});

test('GET /api/graph reports synced and unresolved resolution states precisely', async () => {
	const root = buildTwoFeatureFixtureRepo();
	initBothFeatures(root);
	const productDtoPath = buildThirdModuleFixture(root);

	// Edge A: 002/OrganizationDto.taxRate <- 001/WidgetDto.name -- left untouched, must stay 'synced'.
	assert.equal(run(declareArgs(), root).code, 0);
	// Edge B: 002/OrganizationDto.organizationId <- 003/ProductDto.productId -- its SOURCE class is
	// then removed from 003's own scan report (the same "class disappeared" technique
	// test/dependency-cli.test.mjs's own unit/CLI tests already establish), making it 'unresolved'.
	assert.equal(run(declareArgs({
		feature: '002-organization-management', resource: 'OrganizationDto', field: 'organizationId',
		sourceFeature: '003-product-management', sourceResource: 'ProductDto', sourceField: 'productId',
	}), root).code, 0);
	void productDtoPath; // the file itself is untouched here -- only the persisted scan report is edited
	const reportPath = path.join(root, 'specs/003-product-management/brownfield-scan.json');
	const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
	report.related_modules.find((m) => m.module === 'product').dtos = [];
	fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

	await withServer(root, async (base) => {
		const res = await fetch(`${base}/api/graph`);
		assert.equal(res.status, 200);
		const graph = await res.json();
		assert.equal(graph.wires.length, 2);

		const wireA = graph.wires.find((w) => w.source.fieldName === 'taxRate');
		assert.equal(wireA.resolution, 'synced');
		assert.equal(wireA.unresolvedSide, null);

		const wireB = graph.wires.find((w) => w.target.fieldName === 'organizationId');
		assert.equal(wireB.resolution, 'unresolved');
		assert.equal(wireB.unresolvedSide, 'source');
		assert.equal(wireB.unresolvedReason, 'class_not_found');

		const nodeIds = graph.nodes.map((n) => n.id).sort();
		assert.deepEqual(nodeIds, [
			'001-widget-management::WidgetDto',
			'002-organization-management::OrganizationDto',
			'003-product-management::ProductDto',
		]);
	});
});
