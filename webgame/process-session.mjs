import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';

function assertArgv(argv) {
  if (!Array.isArray(argv) || argv.length === 0 || argv.some((arg) => typeof arg !== 'string' || arg.length === 0)) {
    throw new Error('process argv must be a non-empty string array');
  }
}

function assertInsideRoot(root, cwd) {
  const resolvedRoot = path.resolve(root);
  const resolvedCwd = path.resolve(cwd);
  const prefix = resolvedRoot.endsWith(path.sep) ? resolvedRoot : `${resolvedRoot}${path.sep}`;
  if (resolvedCwd !== resolvedRoot && !resolvedCwd.startsWith(prefix)) throw new Error(`process cwd escapes repository root: ${cwd}`);
}

function boundedAppend(value, chunk, limit) {
  const next = value + String(chunk);
  return next.length <= limit ? next : next.slice(next.length - limit);
}

export function createOwnedProcessSession({ repoRoot, spawnImpl = spawn, spawnSyncImpl = spawnSync, logLimit = 65536 } = {}) {
  if (!repoRoot) throw new Error('repoRoot is required');
  const owned = new Set();

  async function terminate(child) {
    if (!child || child.exitCode !== null) return;
    if (process.platform === 'win32' && Number.isInteger(child.pid)) {
      spawnSyncImpl('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      return;
    }
    child.kill('SIGTERM');
  }

  function start(argv, { cwd = repoRoot, env = {}, stdio = ['ignore', 'pipe', 'pipe'] } = {}) {
    assertArgv(argv);
    assertInsideRoot(repoRoot, cwd);
    const child = spawnImpl(argv[0], argv.slice(1), {
      cwd,
      env: { ...process.env, ...env },
      shell: false,
      windowsHide: true,
      stdio,
    });
    owned.add(child);
    child.once?.('exit', () => owned.delete(child));
    return child;
  }

  async function run(argv, { cwd = repoRoot, env = {}, timeoutMs = 120000 } = {}) {
    const child = start(argv, { cwd, env });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout = boundedAppend(stdout, chunk, logLimit); });
    child.stderr?.on('data', (chunk) => { stderr = boundedAppend(stderr, chunk, logLimit); });
    return await new Promise((resolve, reject) => {
      let timer = setTimeout(async () => {
        timer = null;
        await terminate(child);
        reject(new Error(`owned process timed out after ${timeoutMs}ms: ${argv[0]}`));
      }, timeoutMs);
      child.once('error', (error) => {
        if (timer) clearTimeout(timer);
        reject(error);
      });
      child.once('exit', (code, signal) => {
        if (timer) clearTimeout(timer);
        resolve({ code, signal, stdout, stderr });
      });
    });
  }

  async function stopAll() {
    const children = [...owned];
    for (const child of children) await terminate(child);
    owned.clear();
  }

  return { start, run, stopAll, get ownedCount() { return owned.size; } };
}
