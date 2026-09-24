import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { createOwnedProcessSession } from '../webgame/process-session.mjs';

class TimeoutChild extends EventEmitter {
  constructor() {
    super();
    this.pid = 321;
    this.exitCode = null;
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
  }

  kill(signal) {
    this.exitCode = 143;
    this.emit('exit', 143, signal);
    return true;
  }
}

test('owned process timeout rejects even when termination emits exit synchronously', async () => {
  const child = new TimeoutChild();
  const session = createOwnedProcessSession({
    repoRoot: '/repo',
    spawnImpl() { return child; },
    spawnSyncImpl() {
      child.exitCode = 137;
      child.emit('exit', 137, 'SIGKILL');
    },
  });

  await assert.rejects(
    () => session.run(['node', 'never-exits.mjs'], { timeoutMs: 1 }),
    /owned process timed out/,
  );
});
