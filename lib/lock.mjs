// S5 (D-persistence-integrity): closes the lost-update race in lib/state.mjs's setGate() (and
// contracts/completeness.mjs's saveResolution()) -- both do load -> modify -> save with no
// synchronization, confirmed live during this item's own grounding (two processes racing a
// load-modify-save cycle silently drop one write). mkdir-based advisory lock: `fs.mkdirSync` is
// atomic on both POSIX and Windows (fails with EEXIST if the dir already exists), needs no new
// dependency, and needs no cleanup daemon -- a crashed holder just leaves a directory a human can
// `rm -rf`, which the timeout error message below points at directly.
//
// Deliberately SYNCHRONOUS, not Promise-based: setGate() (and every passGate/awaitDispositionGate/
// forceGate/passNamedGate caller above it, all the way up through bin/bskel.mjs's cmdXxx functions
// and main()) is synchronous today. Making the lock async would force `async`/`await` through that
// entire call chain for a correctness property that doesn't need it -- this is a short-lived CLI
// process, not a server, so blocking the (single) event loop for up to a few seconds while polling
// for a lock is not a real cost. `Atomics.wait` gives a genuine synchronous blocking sleep on
// Node's main thread (confirmed directly: not restricted to worker threads).
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

// Runs `fn` with an exclusive lock named `lockName`, scoped to this repo. Retries acquisition
// with a short fixed backoff until `timeoutMs` elapses, then throws with a message naming the
// exact stale-lock path to remove -- this tool is a short-lived CLI, not a daemon, so "another
// bskel process is stuck or crashed" is the only realistic cause, and the fix is always the same
// (confirm nothing else is running, then delete the lock directory).
export function withLockSync(repoRoot, lockName, fn, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
	const dir = locksDir(repoRoot);
	fs.mkdirSync(dir, { recursive: true });
	const lockPath = path.join(dir, `${lockName}.lock`);

	const deadline = Date.now() + timeoutMs;
	while (!tryAcquire(lockPath)) {
		if (Date.now() >= deadline) {
			throw new Error(
				`could not acquire lock "${lockName}" within ${timeoutMs}ms (${lockPath} already exists) -- ` +
				'another bskel process may be running against this repo, or a previous run crashed and left ' +
				`this lock behind. If nothing else is running, remove ${lockPath} and try again.`,
			);
		}
		sleepSync(RETRY_INTERVAL_MS);
	}

	try {
		return fn();
	} finally {
		fs.rmSync(lockPath, { recursive: true, force: true });
	}
}
