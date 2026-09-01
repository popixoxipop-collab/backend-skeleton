// S5 (D-persistence-integrity): closes the lost-update race in lib/state.mjs's setGate() (and
// contracts/completeness.mjs's saveResolution()) -- both do load -> modify -> save with no
// synchronization, confirmed live during this item's own grounding (two processes racing a
// load-modify-save cycle silently drop one write). mkdir-based advisory lock: `fs.mkdirSync` is
// atomic on both POSIX and Windows (fails with EEXIST if the dir already exists), needs no new
// dependency, and needs no cleanup daemon -- a crashed holder just leaves a directory a human can
// `rm -rf`, which the timeout error message below points at directly.
//
// withLockSync is deliberately SYNCHRONOUS, not Promise-based: setGate() (and every
// passGate/awaitDispositionGate/forceGate/passNamedGate caller above it, all the way up through
// bin/bskel.mjs's cmdXxx functions and main()) is synchronous today. Making the lock async would
// force `async`/`await` through that entire call chain for a correctness property that doesn't
// need it -- this is a short-lived CLI process, not a server, so blocking the (single) event loop
// for up to a few seconds while polling for a lock is not a real cost. `Atomics.wait` gives a
// genuine synchronous blocking sleep on Node's main thread (confirmed directly: not restricted to
// worker threads).
//
// D-ddl-apply added withLockAsync -- a genuinely separate acquire loop (a non-blocking
// `await new Promise(setTimeout)` sleep, not Atomics.wait), needed once `bskel serve` became a
// long-running process handling concurrent requests: withLockSync's synchronous, event-loop-
// blocking wait is fine for a short-lived CLI process racing another short-lived CLI process, but
// deadlocks a server racing itself (see withLockAsync's own comment below for the real bug this
// closes, found live while writing this item's own concurrency test).
import fs from 'node:fs';
import path from 'node:path';

const RETRY_INTERVAL_MS = 20;
const DEFAULT_TIMEOUT_MS = 5000;

const _sleepBuffer = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms) {
	Atomics.wait(_sleepBuffer, 0, 0, ms);
}

function locksDir(repoRoot) {
	return path.join(repoRoot, '.sbf', '.locks');
}

function tryAcquire(lockPath) {
	try {
		fs.mkdirSync(lockPath, { recursive: false });
		return true;
	} catch (err) {
		if (err.code === 'EEXIST') return false;
		throw err;
	}
}

function timeoutMessage(lockName, timeoutMs, lockPath) {
	return `could not acquire lock "${lockName}" within ${timeoutMs}ms (${lockPath} already exists) -- ` +
		'another bskel process may be running against this repo, or a previous run crashed and left ' +
		`this lock behind. If nothing else is running, remove ${lockPath} and try again.`;
}

// Runs `fn` with an exclusive lock named `lockName`, scoped to this repo. Retries acquisition
// with a short fixed backoff until `timeoutMs` elapses, then throws with a message naming the
// exact stale-lock path to remove -- this tool is a short-lived CLI, not a daemon, so "another
// bskel process is stuck or crashed" is the only realistic cause, and the fix is always the same
// (confirm nothing else is running, then delete the lock directory).
function acquireOrThrow(repoRoot, lockName, timeoutMs) {
	const dir = locksDir(repoRoot);
	fs.mkdirSync(dir, { recursive: true });
	const lockPath = path.join(dir, `${lockName}.lock`);

	const deadline = Date.now() + timeoutMs;
	while (!tryAcquire(lockPath)) {
		if (Date.now() >= deadline) throw new Error(timeoutMessage(lockName, timeoutMs, lockPath));
		sleepSync(RETRY_INTERVAL_MS);
	}
	return lockPath;
}

export function withLockSync(repoRoot, lockName, fn, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
	const lockPath = acquireOrThrow(repoRoot, lockName, timeoutMs);
	try {
		return fn();
	} finally {
		fs.rmSync(lockPath, { recursive: true, force: true });
	}
}

// D-ddl-apply: the async counterpart, needed because a live DDL apply/rollback executor is
// inherently a Promise-returning `pg` round trip.
//
// Deliberately does NOT reuse acquireOrThrow()'s synchronous poll loop -- a real bug found live
// while writing this item's own concurrency test, not assumed: acquireOrThrow()'s wait step
// (sleepSync -> Atomics.wait) BLOCKS THE ENTIRE EVENT LOOP synchronously between mkdir attempts.
// Called from an async function, that's fatal -- while a waiter spins inside that synchronous
// loop, nothing else on the event loop can run, INCLUDING the current lock holder's own pending
// I/O (e.g. the `pg` query it's awaiting), so the holder can never finish and release the lock the
// waiter is spinning for. A single-process `bskel serve` handling two concurrent requests that both
// touch the 'state' lock would deadlock the whole server, not just wait. This async acquire loop
// uses `await new Promise(setTimeout)` instead -- a real, non-blocking sleep that yields control
// back to the event loop on every retry, so concurrent I/O (including the current holder's) can
// keep making progress while this call waits its turn.
async function acquireAsyncOrThrow(repoRoot, lockName, timeoutMs) {
	const dir = locksDir(repoRoot);
	fs.mkdirSync(dir, { recursive: true });
	const lockPath = path.join(dir, `${lockName}.lock`);

	const deadline = Date.now() + timeoutMs;
	while (!tryAcquire(lockPath)) {
		if (Date.now() >= deadline) throw new Error(timeoutMessage(lockName, timeoutMs, lockPath));
		await new Promise((resolve) => setTimeout(resolve, RETRY_INTERVAL_MS));
	}
	return lockPath;
}

// withLockSync's own `finally { fn() has already returned }` release timing would be WRONG for an
// async callback: if a caller passed an async fn to withLockSync, `finally` would fire (releasing
// the lock) the instant the Promise was RETURNED, not once it RESOLVED -- releasing the lock before
// the actual DB write even finishes. `await fn()` inside this function's own try means `finally`
// cannot run until the Promise settles, making that mistake structurally impossible.
export async function withLockAsync(repoRoot, lockName, fn, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
	const lockPath = await acquireAsyncOrThrow(repoRoot, lockName, timeoutMs);
	try {
		return await fn();
	} finally {
		fs.rmSync(lockPath, { recursive: true, force: true });
	}
}
