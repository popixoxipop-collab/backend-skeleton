import test from 'node:test';
import assert from 'node:assert/strict';
import { PERMISSION_MANIFEST_SCHEMA } from '../../lib/trust-next/permission-manifest.mjs';
import { createEnforcementGate } from '../../lib/trust-next/enforcement-gate.mjs';
import { createRecordingHost } from './enforcement-host.mjs';

// Output caps are checked against a scripted child that delivers several chunks, so that the cap has to be
// cumulative. The child ends only when the gate kills it or the script ends it; nothing here waits on a timer.

function scripted(script, limits) {
  const kills = [];
  const host = createRecordingHost({
    spawnImpl: (request) => {
      let end;
      const done = new Promise((resolve) => { end = resolve; });
      queueMicrotask(() => script(request, end));
      return { pid: 4242, kill: (signal) => { kills.push(signal); end({ exit_code: null, signal }); }, done };
    },
  });
  const manifest = { schema: PERMISSION_MANIFEST_SCHEMA, process: { mode: 'argv-allowlist', executables: ['node'], max_children: 1 }, limits };
  return { gate: createEnforcementGate({ manifest, host }), kills };
}

const latin1 = (value) => Buffer.from(value).toString('latin1');

test('stdout and stderr are cut at the cap summed over chunks, flagged, and the child is stopped', async () => {
  const { gate, kills } = scripted((request) => {
    for (const byte of [0x61, 0x62, 0x63]) request.onStdout(Buffer.alloc(600, byte));
    for (let i = 0; i < 3; i += 1) request.onStderr(Buffer.alloc(300, 0x7a));
  }, { stdout_bytes: 1024, stderr_bytes: 512 });
  const result = await gate.spawn('node', [], {});
  assert.equal(latin1(result.stdout), latin1(Buffer.concat([Buffer.alloc(600, 0x61), Buffer.alloc(424, 0x62)])));
  assert.equal(result.stdout_truncated, true);
  assert.equal(result.killed_for, 'stdout_bytes');
  assert.equal(result.stderr.length, 512);
  assert.equal(result.stderr_truncated, true);
  assert.ok(kills.length >= 1 && kills.every((signal) => signal === 'SIGKILL'));
});

test('output below the cap is returned whole, unflagged, and the child is not killed', async () => {
  const { gate, kills } = scripted((request, end) => {
    request.onStdout(Buffer.alloc(100, 0x61));
    request.onStdout(Buffer.alloc(100, 0x62));
    request.onStderr(Buffer.alloc(50, 0x63));
    end({ exit_code: 0, signal: null });
  }, { stdout_bytes: 1024, stderr_bytes: 512 });
  const result = await gate.spawn('node', [], {});
  assert.equal(result.stdout.length, 200);
  assert.equal(result.stderr.length, 50);
  assert.equal(result.stdout_truncated, false);
  assert.equal(result.stderr_truncated, false);
  assert.equal(result.exit_code, 0);
  assert.ok(result.killed_for == null);
  assert.deepEqual(kills, []);
});
