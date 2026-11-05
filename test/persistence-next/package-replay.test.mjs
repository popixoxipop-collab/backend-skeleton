import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
// Fixed historical fixtures, not HEAD: later commits must not change this rehearsal.
const previous = '0ed446344c36ec500d54a59c41ecd8ca72cfc842';
const candidate = '9117a6f3f5dd03fdbb5dbd6221f5315971e66af7';

// CI provides full Git history. Offline installs also need a prewarmed npm
// dependency cache, including registry metadata; npm ci alone is not proof of
// cache sufficiency. Missing prerequisites fail, never skip. No downloads occur.
test('T10 package replay: build pinned fixtures and pass all 24 scenarios', { timeout: 720000 }, async (t) => {
  assert.notEqual(process.platform, 'win32', 'This bridge requires POSIX process-group cleanup');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 't10-ci-replay-'));
  const env = { ...process.env, NODE_OPTIONS: '', TMPDIR: scratch, TMP: scratch, TEMP: scratch };
  // node --test sets this for its worker. A nested runner must create its own
  // test protocol instead of inheriting the parent's internal IPC context.
  delete env.NODE_TEST_CONTEXT;
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_')) delete env[key];
  }
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null';
  const run = (command, args, timeout, label) => new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: repoRoot, env, detached: true,
      stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', failure = null;
    // Each child owns a new POSIX process group. Terminate that group before
    // cleaning its temporary files, including any surviving npm descendants.
    const killGroup = () => {
      if (!child.pid) return;
      try { process.kill(-child.pid, 'SIGKILL'); }
      catch (error) { if (error.code !== 'ESRCH') failure ??= error; }
    };
    const timer = setTimeout(() => {
      failure = new Error(`Exceeded ${timeout} ms`);
      killGroup();
    }, timeout);
    const collect = (chunk, stream) => {
      if (stream === 'stdout') stdout += chunk;
      else stderr += chunk;
      if (stdout.length + stderr.length > 16 * 1024 * 1024) {
        failure = new Error('Child output exceeded 16 MiB');
        killGroup();
      }
    };
    child.stdout.setEncoding('utf8').on('data', chunk => collect(chunk, 'stdout'));
    child.stderr.setEncoding('utf8').on('data', chunk => collect(chunk, 'stderr'));
    child.on('error', error => { failure = error; killGroup(); });
    child.on('exit', killGroup);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (failure || signal !== null || code !== 0) {
        reject(new Error(`${label} failed (exit=${code}, signal=${signal}):\n` +
          `${failure?.message ?? ''}\n${stdout}\n${stderr}`));
      } else resolve(stdout);
    });
  });
  try {
    for (const revision of [previous, candidate]) {
      await run('git', ['cat-file', '-e', `${revision}^{commit}`], 30000,
        `Required historical commit ${revision}; full Git history is required`);
    }
    env.T10_REPLAY_BUNDLE = path.join(scratch, 'bundle');
    env.T10_TEST_OUTPUT = path.join(scratch, 'scenarios');
    await run(process.execPath, ['next/t10/package-replay.mjs', 'build',
      '--repo', repoRoot, '--previous', previous, '--candidate', candidate,
      '--output', env.T10_REPLAY_BUNDLE], 180000, 'Offline pinned bundle build');
    const output = await run(process.execPath,
      ['--test', '--test-reporter=tap', 'next/t10/package-replay.test.mjs'],
      420000, 'Offline 24-scenario replay (requires a prewarmed npm dependency cache)');
    for (const [field, count] of Object.entries({ tests: 24, pass: 24, fail: 0, cancelled: 0, skipped: 0, todo: 0 })) {
      const summaries = [...output.matchAll(new RegExp(`^# ${field} (\\d+)$`, 'gm'))];
      assert.deepEqual(summaries.map(match => Number(match[1])), [count],
        `Expected exactly one replay ${field} summary with count ${count}:\n${output}`);
    }
    for (const line of output.trim().split(/\r?\n/)) t.diagnostic(line);
  } finally {
    // Only this test's freshly allocated temporary tree may be removed.
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
