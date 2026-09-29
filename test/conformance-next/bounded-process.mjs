import { spawnSync } from 'node:child_process';

const SUPERVISOR = String.raw`
import { spawn, spawnSync } from 'node:child_process';

const [command, cwd, timeoutRaw, envB64, ...args] = process.argv.slice(1);
const timeoutMs = Number(timeoutRaw);
const env = JSON.parse(Buffer.from(envB64, 'base64').toString('utf8'));
const child = spawn(command, args, {
  cwd: cwd || undefined,
  env,
  detached: process.platform !== 'win32',
  stdio: ['ignore', 'pipe', 'pipe'],
});
const OUTPUT_TAIL_LIMIT = 256 * 1024;
let stdout = Buffer.alloc(0);
let stderr = Buffer.alloc(0);
let finished = false;
let timedOut = false;

function appendTail(current, chunk) {
  const next = Buffer.concat([current, Buffer.from(chunk)]);
  return next.length > OUTPUT_TAIL_LIMIT ? next.subarray(next.length - OUTPUT_TAIL_LIMIT) : next;
}

child.stdout?.on('data', (chunk) => { stdout = appendTail(stdout, chunk); });
child.stderr?.on('data', (chunk) => { stderr = appendTail(stderr, chunk); });

function emit(result) {
  if (finished) return;
  finished = true;
  process.stdout.write(JSON.stringify({
    ...result,
    stdout_b64: stdout.toString('base64'),
    stderr_b64: stderr.toString('base64'),
  }));
}

function killTree() {
  timedOut = true;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      process.kill(-child.pid, 'SIGKILL');
    }
  } catch {
    try { child.kill('SIGKILL'); } catch {}
  }
}

const timer = setTimeout(killTree, timeoutMs);
child.once('error', (err) => {
  clearTimeout(timer);
  emit({
    status: null,
    signal: null,
    error: { code: err.code ?? 'SPAWN_ERROR', message: err.message },
  });
});
child.once('close', (code, signal) => {
  clearTimeout(timer);
  emit({
    status: Number.isInteger(code) ? code : null,
    signal: signal ?? null,
    error: timedOut ? { code: 'ETIMEDOUT', message: 'process group timed out' } : null,
  });
});
`;

export function runProcessGroupBounded(command, args, {
  cwd,
  timeoutMs,
  env = process.env,
  maxBuffer = 32 * 1024 * 1024,
} = {}) {
  if (typeof command !== 'string' || command.length === 0) throw new TypeError('command is required');
  if (!Array.isArray(args)) throw new TypeError('args must be an array');
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new TypeError('timeoutMs must be a positive integer');
  const envB64 = Buffer.from(JSON.stringify(env), 'utf8').toString('base64');
  const supervisor = spawnSync(process.execPath, [
    '--input-type=module',
    '-e',
    SUPERVISOR,
    command,
    cwd ?? '',
    String(timeoutMs),
    envB64,
    ...args,
  ], {
    encoding: 'utf8',
    timeout: timeoutMs + 10_000,
    killSignal: 'SIGKILL',
    maxBuffer,
  });
  if (supervisor.error) {
    return {
      status: Number.isInteger(supervisor.status) ? supervisor.status : null,
      signal: supervisor.signal ?? null,
      stdout: supervisor.stdout ?? '',
      stderr: supervisor.stderr ?? '',
      error: supervisor.error,
    };
  }
  let result;
  try {
    result = JSON.parse(supervisor.stdout ?? '');
  } catch {
    return {
      status: Number.isInteger(supervisor.status) ? supervisor.status : null,
      signal: supervisor.signal ?? null,
      stdout: '',
      stderr: supervisor.stderr ?? '',
      error: { code: 'SUPERVISOR_PROTOCOL_ERROR', message: 'bounded process supervisor returned invalid JSON' },
    };
  }
  return {
    status: Number.isInteger(result.status) ? result.status : null,
    signal: result.signal ?? null,
    stdout: Buffer.from(result.stdout_b64 ?? '', 'base64').toString('utf8'),
    stderr: Buffer.from(result.stderr_b64 ?? '', 'base64').toString('utf8'),
    error: result.error ?? null,
  };
}
