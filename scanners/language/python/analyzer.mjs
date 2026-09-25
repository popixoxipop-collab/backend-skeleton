import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export const PYTHON_AST_REQUEST_PROTOCOL = 'bskel.python-ast.request/1';
export const PYTHON_AST_RESPONSE_PROTOCOL = 'bskel.python-ast.response/1';
const HELPER = fileURLToPath(new URL('./ast-helper.py', import.meta.url));
const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_MAX_BUFFER = 4 * 1024 * 1024;
const DEFAULT_MAX_SOURCE_BYTES = 2 * 1024 * 1024;

function childEnv() {
  const env = {};
  for (const key of ['SystemRoot', 'WINDIR']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

function inside(root, file) {
  const rel = path.relative(root, file);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

function executableNames(name) {
  if (process.platform !== 'win32') return [name];
  const ext = path.extname(name);
  if (ext) return [name];
  const pathExt = String(process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean);
  return [name, ...pathExt.map((x) => name + x.toLowerCase()), ...pathExt.map((x) => name + x.toUpperCase())];
}

function resolveExecutable(command, denyRoots = []) {
  if (!command || typeof command !== 'string') return null;
  const hasSeparator = command.includes('/') || command.includes('\\');
  const candidates = [];
  if (path.isAbsolute(command)) {
    candidates.push(command);
  } else if (!hasSeparator && /^[A-Za-z0-9._+-]+$/.test(command)) {
    for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
      if (!dir || !path.isAbsolute(dir)) continue;
      for (const name of executableNames(command)) candidates.push(path.join(dir, name));
    }
  } else {
    return null;
  }
  for (const candidate of candidates) {
    try {
      if (!fs.statSync(candidate).isFile()) continue;
      const real = fs.realpathSync(candidate);
      if (denyRoots.some((root) => inside(root, real))) continue;
      return real;
    } catch {
      // Continue to the next trusted absolute candidate.
    }
  }
  return null;
}

function commandCandidates(explicit) {
  if (explicit) return [explicit];
  if (process.env.BSKEL_PYTHON) return [process.env.BSKEL_PYTHON, 'python3', 'python'];
  return ['python3', 'python'];
}

export function findPythonRuntime({ pythonCommand = null, denyRoots = [] } = {}) {
  const normalizedDenyRoots = denyRoots.flatMap((root) => {
    try { return [fs.realpathSync(root)]; } catch { return []; }
  });
  const seen = new Set();
  for (const command of commandCandidates(pythonCommand)) {
    const executable = resolveExecutable(command, normalizedDenyRoots);
    if (!executable || seen.has(executable)) {
      if (pythonCommand) break;
      continue;
    }
    seen.add(executable);
    const probe = spawnSync(executable, ['-I', '-S', '-B', '-X', 'utf8', '-c', 'import sys;print("%d.%d.%d"%sys.version_info[:3])'], {
      encoding: 'utf8',
      env: childEnv(),
      timeout: 1500,
      windowsHide: true,
    });
    if (probe.status === 0) {
      const version = String(probe.stdout || '').trim();
      const match = version.match(/^(\d+)\.(\d+)\.(\d+)$/);
      if (match && (Number(match[1]) > 3 || (Number(match[1]) === 3 && Number(match[2]) >= 8))) {
        return { executable, version };
      }
    }
    if (pythonCommand) break;
  }
  return null;
}

function realPathInside(root, requested) {
  const rootReal = fs.realpathSync(root);
  const absolute = path.resolve(rootReal, requested);
  const fileReal = fs.realpathSync(absolute);
  if (!inside(rootReal, fileReal) || fileReal === rootReal) {
    throw new Error(`Python source escapes project root: ${requested}`);
  }
  return { rootReal, fileReal, relative: path.relative(rootReal, fileReal).split(path.sep).join('/') };
}

export function analyzePythonFile({
  repoRoot,
  file,
  pythonCommand = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBuffer = DEFAULT_MAX_BUFFER,
  maxSourceBytes = DEFAULT_MAX_SOURCE_BYTES,
} = {}) {
  if (!repoRoot || !file) throw new Error('analyzePythonFile requires repoRoot and file');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new Error('timeoutMs must be an integer between 1 and 30000');
  if (!Number.isInteger(maxBuffer) || maxBuffer < 65536 || maxBuffer > 16 * 1024 * 1024) throw new Error('maxBuffer must be between 65536 and 16777216');
  if (!Number.isInteger(maxSourceBytes) || maxSourceBytes < 1024 || maxSourceBytes > 16 * 1024 * 1024) throw new Error('maxSourceBytes must be between 1024 and 16777216');

  const resolved = realPathInside(repoRoot, file);
  const sourceStat = fs.statSync(resolved.fileReal);
  if (!sourceStat.isFile()) throw new Error(`Python source is not a regular file: ${file}`);
  if (sourceStat.size > maxSourceBytes) {
    return {
      protocol: PYTHON_AST_RESPONSE_PROTOCOL,
      ok: false,
      source: { path: resolved.relative, sizeBytes: sourceStat.size },
      error: { code: 'PYTHON_SOURCE_TOO_LARGE', message: `Python source exceeds configured ${maxSourceBytes}-byte analysis limit.` },
    };
  }
  const sourceBytes = fs.readFileSync(resolved.fileReal);
  const sourceSha256 = crypto.createHash('sha256').update(sourceBytes).digest('hex');
  let source;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(sourceBytes);
  } catch {
    return {
      protocol: PYTHON_AST_RESPONSE_PROTOCOL,
      ok: false,
      source: { path: resolved.relative, sha256: sourceSha256, sizeBytes: sourceBytes.length },
      error: { code: 'PYTHON_SOURCE_ENCODING_UNSUPPORTED', message: 'T06 phase 1 accepts only valid UTF-8 Python source; no lossy decoding is performed.' },
    };
  }
  const runtime = findPythonRuntime({ pythonCommand, denyRoots: [resolved.rootReal] });
  if (!runtime) {
    return {
      protocol: PYTHON_AST_RESPONSE_PROTOCOL,
      ok: false,
      source: { path: resolved.relative, sha256: sourceSha256, sizeBytes: sourceBytes.length },
      error: { code: 'PYTHON_RUNTIME_UNAVAILABLE', message: 'No approved Python interpreter was found for the optional static AST helper.' },
    };
  }

  const request = JSON.stringify({
    protocol: PYTHON_AST_REQUEST_PROTOCOL,
    filename: resolved.relative,
    source,
  });
  const child = spawnSync(runtime.executable, ['-I', '-S', '-B', '-X', 'utf8', HELPER], {
    input: request,
    encoding: 'utf8',
    env: childEnv(),
    timeout: timeoutMs,
    maxBuffer,
    windowsHide: true,
  });
  if (child.error) {
    const code = child.error.code === 'ETIMEDOUT' ? 'PYTHON_ANALYZER_TIMEOUT' : 'PYTHON_ANALYZER_FAILED';
    return { protocol: PYTHON_AST_RESPONSE_PROTOCOL, ok: false, source: { path: resolved.relative, sha256: sourceSha256, sizeBytes: sourceBytes.length }, error: { code, message: child.error.message } };
  }
  if (child.status !== 0) {
    return {
      protocol: PYTHON_AST_RESPONSE_PROTOCOL,
      ok: false,
      source: { path: resolved.relative, sha256: sourceSha256, sizeBytes: sourceBytes.length },
      error: { code: 'PYTHON_ANALYZER_FAILED', message: `Python helper exited ${child.status}: ${String(child.stderr || '').slice(0, 800)}` },
    };
  }

  let response;
  try {
    response = JSON.parse(child.stdout);
  } catch (error) {
    return {
      protocol: PYTHON_AST_RESPONSE_PROTOCOL,
      ok: false,
      source: { path: resolved.relative, sha256: sourceSha256, sizeBytes: sourceBytes.length },
      error: { code: 'PYTHON_ANALYZER_PROTOCOL_ERROR', message: `Python helper returned invalid JSON: ${error.message}` },
    };
  }
  if (response?.protocol !== PYTHON_AST_RESPONSE_PROTOCOL || typeof response.ok !== 'boolean') {
    return {
      protocol: PYTHON_AST_RESPONSE_PROTOCOL,
      ok: false,
      source: { path: resolved.relative, sha256: sourceSha256, sizeBytes: sourceBytes.length },
      error: { code: 'PYTHON_ANALYZER_PROTOCOL_ERROR', message: 'Python helper returned an unexpected protocol envelope.' },
    };
  }
  return {
    ...response,
    source: { path: resolved.relative, sha256: sourceSha256, sizeBytes: sourceBytes.length },
  };
}
