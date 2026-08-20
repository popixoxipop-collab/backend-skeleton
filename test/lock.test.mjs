// S5 (D-persistence-integrity): lib/lock.mjs is the primitive that closes the lost-update race in
// lib/state.mjs's setGate() -- tested here in isolation (not through setGate itself) so this
// suite can prove real mutual exclusion without adding a test-only delay hook to production code.
//
// withLockSync is deliberately synchronous (see lib/lock.mjs's own header comment for why) --
// which means two calls from the SAME process can never meaningfully "race" each other (JS is
// single-threaded; synchronous code cannot interleave, with or without a lock). The tests that
// matter here spawn REAL child processes, matching how bskel is actually invoked (every command
// is a separate OS process).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { withLockSync } from '../lib/lock.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCK_MODULE = path.join(__dirname, '..', 'lib', 'lock.mjs');

function scratchRepo() {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-lock-test-'));
}

function spawnHolder(root, label, resultsFile, holdMs) {
	const driver = `
		import { withLockSync } from ${JSON.stringify(LOCK_MODULE)};
		import fs from 'node:fs';
		const [, , root, resultsFile, label, holdMs] = process.argv;
		withLockSync(root, 'shared', () => {
			const events = JSON.parse(fs.readFileSync(resultsFile, 'utf8'));
			events.push({ label, at: 'enter', t: Date.now() });
			fs.writeFileSync(resultsFile, JSON.stringify(events));
			const deadline = Date.now() + Number(holdMs);
			while (Date.now() < deadline) { /* busy-wait: this process must actually hold the lock */ }
			const events2 = JSON.parse(fs.readFileSync(resultsFile, 'utf8'));
			events2.push({ label, at: 'exit', t: Date.now() });
			fs.writeFileSync(resultsFile, JSON.stringify(events2));
		});
	`;
	const driverPath = path.join(root, `driver-${label}.mjs`);
	fs.writeFileSync(driverPath, driver);
	return new Promise((resolve, reject) => {
		const child = spawn('node', [driverPath, root, resultsFile, label, String(holdMs)]);
		let stderr = '';
		child.stderr.on('data', (d) => { stderr += d; });
		child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${label}: exit ${code}: ${stderr}`))));
	});
}

test('withLockSync: runs fn and releases the lock directory afterward (success path)', () => {
	const root = scratchRepo();
	const result = withLockSync(root, 'test', () => 'done');
	assert.equal(result, 'done');
	assert.equal(fs.existsSync(path.join(root, '.sbf', '.locks', 'test.lock')), false);
});

test('withLockSync: releases the lock even when fn throws', () => {
	const root = scratchRepo();
	assert.throws(() => withLockSync(root, 'test', () => { throw new Error('boom'); }), /boom/);
	assert.equal(fs.existsSync(path.join(root, '.sbf', '.locks', 'test.lock')), false);
});

test('withLockSync: waits for a real subprocess holder to release, then acquires -- proves the retry loop, not just the happy path', async () => {
	const root = scratchRepo();
	const resultsFile = path.join(root, 'results.json');
	fs.writeFileSync(resultsFile, '[]');
	const holderDone = spawnHolder(root, 'holder', resultsFile, 150);
	// Poll for the lock directory itself rather than a fixed sleep -- under full-suite system
	// load a fixed delay is flaky (the subprocess may not have won the race yet), so wait for
	// positive proof the holder has actually acquired before racing it ourselves.
	const lockPath = path.join(root, '.sbf', '.locks', 'shared.lock');
	const acquireDeadline = Date.now() + 5000;
	while (!fs.existsSync(lockPath)) {
		if (Date.now() > acquireDeadline) throw new Error('holder subprocess never acquired the lock');
		await new Promise((r) => setTimeout(r, 5));
	}
	const before = Date.now();
	const result = withLockSync(root, 'shared', () => 'acquired-after-wait');
	const waitedMs = Date.now() - before;
	await holderDone;
	assert.equal(result, 'acquired-after-wait');
	assert.ok(waitedMs > 0, `expected withLockSync to block waiting for the holder (waited ${waitedMs}ms)`);
});

test('withLockSync: two REAL OS processes racing the same lock never run their critical section concurrently', async () => {
	const root = scratchRepo();
	const resultsFile = path.join(root, 'results.json');
	fs.writeFileSync(resultsFile, '[]');
	await Promise.all([
		spawnHolder(root, 'p1', resultsFile, 100),
		spawnHolder(root, 'p2', resultsFile, 100),
	]);

	const events = JSON.parse(fs.readFileSync(resultsFile, 'utf8'));
	assert.equal(events.length, 4, `expected 4 lifecycle events from 2 processes, got: ${JSON.stringify(events)}`);
	const intervals = ['p1', 'p2'].map((label) => {
		const enter = events.find((e) => e.label === label && e.at === 'enter');
		const exit = events.find((e) => e.label === label && e.at === 'exit');
		return { label, enter: enter.t, exit: exit.t };
	});
	const [first, second] = intervals.sort((a, b) => a.enter - b.enter);
	assert.ok(second.enter >= first.exit, `lock did not serialize two real processes -- ${JSON.stringify(intervals)}`);
});

test('withLockSync: times out with a message naming the exact stale-lock path to remove', () => {
	const root = scratchRepo();
	const lockDir = path.join(root, '.sbf', '.locks', 'stuck.lock');
	fs.mkdirSync(lockDir, { recursive: true }); // simulate a crashed holder that never released
	assert.throws(
		() => withLockSync(root, 'stuck', () => {}, { timeoutMs: 60 }),
		(err) => {
			assert.match(err.message, /could not acquire lock "stuck"/);
			assert.match(err.message, new RegExp(lockDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
			return true;
		},
	);
});
