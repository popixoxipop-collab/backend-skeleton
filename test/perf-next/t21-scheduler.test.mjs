import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runTaskGraph } from '../../lib/scan-scheduler-next/scheduler.mjs';

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

test('bounded scheduler respects dependency order, concurrency and byte reservations', async () => {
	let live = 0;
	let peakLive = 0;
	const events = [];
	const report = await runTaskGraph([
		{ id: 'a', estimatedBytes: 40 },
		{ id: 'b', estimatedBytes: 40 },
		{ id: 'c', dependsOn: ['a'], estimatedBytes: 20 },
		{ id: 'd', dependsOn: ['b'], estimatedBytes: 20 },
	], async (task) => {
		live += 1;
		peakLive = Math.max(peakLive, live);
		events.push(`${task.id}:start`);
		await delay(20);
		events.push(`${task.id}:end`);
		live -= 1;
		return task.id.toUpperCase();
	}, { maxConcurrency: 3, maxEstimatedBytesInFlight: 80 });

	assert.ok(events.indexOf('c:start') > events.indexOf('a:end'));
	assert.ok(events.indexOf('d:start') > events.indexOf('b:end'));
	assert.ok(peakLive <= 2, `byte budget should cap the first wave at two 40-byte tasks; peak ${peakLive}`);
	assert.ok(report.metrics.peak_concurrency <= 3);
	assert.ok(report.metrics.peak_estimated_bytes_in_flight <= 80);
	assert.equal(report.metrics.passed, 4);
});

test('task larger than hard byte budget is blocked without calling worker and blocks dependents', async () => {
	const called = [];
	const report = await runTaskGraph([
		{ id: 'large', estimatedBytes: 101 },
		{ id: 'child', dependsOn: ['large'], estimatedBytes: 1 },
	], async (task) => { called.push(task.id); }, { maxConcurrency: 2, maxEstimatedBytesInFlight: 100 });
	assert.deepEqual(called, []);
	assert.deepEqual(report.results.map((x) => [x.id, x.status, x.reason]), [
		['child', 'blocked', 'DEPENDENCY_NOT_PASSED'],
		['large', 'blocked', 'RESOURCE_BUDGET_EXCEEDED'],
	]);
});

test('worker failure is contained and only dependent work is blocked', async () => {
	const report = await runTaskGraph([
		{ id: 'bad', estimatedBytes: 1 },
		{ id: 'blocked-child', dependsOn: ['bad'], estimatedBytes: 1 },
		{ id: 'independent', estimatedBytes: 1 },
	], async (task) => {
		if (task.id === 'bad') throw new Error('parse failed');
		return 'ok';
	}, { maxConcurrency: 2, maxEstimatedBytesInFlight: 2 });
	const byId = Object.fromEntries(report.results.map((x) => [x.id, x]));
	assert.equal(byId.bad.status, 'failed');
	assert.equal(byId['blocked-child'].status, 'blocked');
	assert.equal(byId.independent.status, 'passed');
});

test('scheduler rejects cycles, duplicate IDs and missing dependencies before work begins', async () => {
	const never = async () => assert.fail('worker must not run');
	await assert.rejects(runTaskGraph([{ id: 'a', dependsOn: ['b'] }, { id: 'b', dependsOn: ['a'] }], never), /cycle/);
	await assert.rejects(runTaskGraph([{ id: 'a' }, { id: 'a' }], never), /duplicate/);
	await assert.rejects(runTaskGraph([{ id: 'a', dependsOn: ['missing'] }], never), /missing dependency/);
});

test('scheduler exposes backpressure metrics without changing task outcomes', async () => {
	const report = await runTaskGraph([
		{ id: 'a', estimatedBytes: 60 },
		{ id: 'b', estimatedBytes: 60 },
		{ id: 'c', estimatedBytes: 1 },
	], async (task) => { await delay(task.id === 'a' ? 20 : 1); return task.id; }, { maxConcurrency: 2, maxEstimatedBytesInFlight: 60 });
	assert.equal(report.metrics.passed, 3);
	assert.ok(report.metrics.max_ready_queue >= 3);
	assert.ok(report.metrics.byte_admission_deferrals > 0);
	assert.ok(report.metrics.peak_estimated_bytes_in_flight <= 60);
});

test('scheduler counts hard resource and dependency blocks separately', async () => {
	const report = await runTaskGraph([
		{ id: 'too-large', estimatedBytes: 101 },
		{ id: 'child', dependsOn: ['too-large'], estimatedBytes: 1 },
	], async () => assert.fail('worker must not run'), { maxConcurrency: 1, maxEstimatedBytesInFlight: 100 });
	assert.equal(report.metrics.resource_budget_blocked, 1);
	assert.equal(report.metrics.dependency_blocked, 1);
});
