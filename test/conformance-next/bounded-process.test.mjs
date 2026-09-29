import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SUPERVISOR_MODULE = pathToFileURL(path.join(HERE, 'bounded-process.mjs')).href;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isLive(pid) {
  const ps = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' });
  const stat = (ps.stdout ?? '').trim();
  return stat !== '' && !stat.startsWith('Z');
}

async function waitFor(predicate, ms, label) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(50);
  }
  assert.fail(`timed out waiting for ${label}`);
}

// A supervised command that starts a descendant in its own (supervisor-created) process group and reports pids.
const FIXTURE = "import { spawn } from 'node:child_process'; import fs from 'node:fs'; " +
  "const g=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); " +
  "fs.writeFileSync(process.env.PID_FILE,JSON.stringify({fixture:process.pid,supervisor:process.ppid,grandchild:g.pid})); " +
  "setInterval(()=>{},1000);\n";

test('bounded-process supervisor kills the detached process group when the supervisor or its parent is terminated', { skip: process.platform === 'win32' }, async () => {
  const scenarios = [
    { name: 'SIGINT to supervisor', act: (pids) => process.kill(pids.supervisor, 'SIGINT') },
    { name: 'SIGTERM to supervisor', act: (pids) => process.kill(pids.supervisor, 'SIGTERM') },
    { name: 'SIGKILL to supervising parent', act: (_pids, host) => process.kill(host.pid, 'SIGKILL') },
  ];
  for (const scenario of scenarios) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-t19-supervisor-cancel-'));
    let pids = null;
    let host = null;
    try {
      const pidFile = path.join(root, 'pids.json');
      const fixtureFile = path.join(root, 'fixture.mjs');
      fs.writeFileSync(fixtureFile, FIXTURE);
      const hostSource = `import { runProcessGroupBounded } from ${JSON.stringify(SUPERVISOR_MODULE)}; ` +
        `runProcessGroupBounded(process.execPath,[${JSON.stringify(fixtureFile)}],{timeoutMs:300000,env:{...process.env,PID_FILE:${JSON.stringify(pidFile)}}});`;
      host = spawn(process.execPath, ['--input-type=module', '-e', hostSource], { stdio: 'ignore' });
      await waitFor(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').endsWith('}'), 15000, `${scenario.name}: fixture start`);
      pids = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
      assert.ok(isLive(pids.fixture) && isLive(pids.grandchild), `${scenario.name}: fixture must be running before cancellation`);
      scenario.act(pids, host);
      await waitFor(() => !isLive(pids.fixture) && !isLive(pids.grandchild), 10000, `${scenario.name}: detached process group to die`);
      await waitFor(() => !isLive(pids.supervisor), 10000, `${scenario.name}: supervisor to exit`);
    } finally {
      for (const pid of [pids?.grandchild, pids?.fixture, pids?.supervisor, host?.pid]) {
        if (Number.isInteger(pid)) { try { process.kill(pid, 'SIGKILL'); } catch {} }
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});
