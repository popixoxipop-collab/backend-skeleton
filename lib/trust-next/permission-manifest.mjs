import path from 'node:path';

export const PERMISSION_MANIFEST_SCHEMA = 'bskel.trust-permissions/1';

const TOP_LEVEL_KEYS = new Set([
  'schema', 'read_roots', 'write_roots', 'network', 'process',
  'environment', 'secret_refs', 'limits',
]);
const NETWORK_KEYS = new Set(['mode', 'allow']);
const NETWORK_RULE_KEYS = new Set(['host', 'ports']);
const PROCESS_KEYS = new Set(['mode', 'executables', 'max_children']);
const ENV_KEYS = new Set(['allow']);
const LIMIT_KEYS = new Set(['wall_ms', 'stdout_bytes', 'stderr_bytes']);
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
const EXECUTABLE = /^[A-Za-z0-9._+-]+$/;
const HOST = /^(?:\[[0-9A-Fa-f:]+\]|[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?)$/;

function exactHost(value) {
  if (typeof value !== 'string' || !HOST.test(value) || value.includes('*') || value.includes('://')) return false;
  if (value.startsWith('[')) return value.endsWith(']') && value.slice(1, -1).includes(':');
  return value.length <= 253 && value.split('.').every((label) =>
    label.length >= 1 && label.length <= 63 && !label.startsWith('-') && !label.endsWith('-')
  );
}

function executableBasename(value) {
  return typeof value === 'string' && value !== '.' && value !== '..' &&
    EXECUTABLE.test(value) && !value.includes('/') && !value.includes('\\');
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function push(errors, code, field, message) {
  errors.push({ code, field, message });
}

function rejectUnknownKeys(errors, obj, allowed, field) {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) push(errors, 'UNKNOWN_PERMISSION_FIELD', `${field}.${key}`, 'unknown fields are rejected fail-closed');
  }
}

function portableRoot(value) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || value.includes('\\')) return null;
  if (path.posix.isAbsolute(value)) return null;
  const parts = value.split('/');
  if (parts.some((part) => part === '..' || part === '')) return null;
  const normalized = path.posix.normalize(value);
  if (normalized === '..' || normalized.startsWith('../')) return null;
  return normalized === '.' ? '.' : normalized.replace(/^\.\//, '').replace(/\/$/, '');
}

function normalizeRoots(errors, value, field) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    push(errors, 'INVALID_PERMISSION_FIELD', field, 'must be an array of portable repository-relative roots');
    return [];
  }
  const out = [];
  for (let i = 0; i < value.length; i += 1) {
    const root = portableRoot(value[i]);
    if (root === null) push(errors, 'INVALID_PERMISSION_ROOT', `${field}[${i}]`, 'must be repository-relative, slash-separated, and contain no traversal');
    else out.push(root);
  }
  return [...new Set(out)].sort();
}

function normalizeNetwork(errors, value) {
  if (value === undefined) return { mode: 'deny', allow: [] };
  if (!isPlainObject(value)) {
    push(errors, 'INVALID_PERMISSION_FIELD', 'network', 'must be an object');
    return { mode: 'deny', allow: [] };
  }
  rejectUnknownKeys(errors, value, NETWORK_KEYS, 'network');
  const mode = value.mode ?? 'deny';
  if (!['deny', 'allowlist'].includes(mode)) push(errors, 'INVALID_NETWORK_MODE', 'network.mode', 'must be deny or allowlist');
  const rawAllow = value.allow ?? [];
  if (!Array.isArray(rawAllow)) {
    push(errors, 'INVALID_PERMISSION_FIELD', 'network.allow', 'must be an array');
    return { mode: mode === 'allowlist' ? 'allowlist' : 'deny', allow: [] };
  }
  const allow = [];
  for (let i = 0; i < rawAllow.length; i += 1) {
    const rule = rawAllow[i];
    if (!isPlainObject(rule)) {
      push(errors, 'INVALID_NETWORK_RULE', `network.allow[${i}]`, 'must be an object');
      continue;
    }
    rejectUnknownKeys(errors, rule, NETWORK_RULE_KEYS, `network.allow[${i}]`);
    if (!exactHost(rule.host)) {
      push(errors, 'INVALID_NETWORK_HOST', `network.allow[${i}].host`, 'must be an exact host name or bracketed IP literal; wildcards and URLs are not allowed');
      continue;
    }
    const ports = rule.ports ?? [];
    if (!Array.isArray(ports) || ports.length === 0 || ports.some((p) => !Number.isInteger(p) || p < 1 || p > 65535)) {
      push(errors, 'INVALID_NETWORK_PORTS', `network.allow[${i}].ports`, 'must contain one or more integer ports in 1..65535');
      continue;
    }
    allow.push({ host: rule.host.toLowerCase(), ports: [...new Set(ports)].sort((a, b) => a - b) });
  }
  allow.sort((a, b) => a.host.localeCompare(b.host) || (a.ports[0] ?? 0) - (b.ports[0] ?? 0));
  if (mode === 'deny' && allow.length > 0) push(errors, 'DENY_WITH_ALLOWLIST', 'network.allow', 'deny mode cannot carry allowed endpoints');
  return { mode: mode === 'allowlist' ? 'allowlist' : 'deny', allow };
}

function normalizeProcess(errors, value) {
  if (value === undefined) return { mode: 'deny', executables: [], max_children: 0 };
  if (!isPlainObject(value)) {
    push(errors, 'INVALID_PERMISSION_FIELD', 'process', 'must be an object');
    return { mode: 'deny', executables: [], max_children: 0 };
  }
  rejectUnknownKeys(errors, value, PROCESS_KEYS, 'process');
  const mode = value.mode ?? 'deny';
  if (!['deny', 'argv-allowlist'].includes(mode)) push(errors, 'INVALID_PROCESS_MODE', 'process.mode', 'must be deny or argv-allowlist');
  const raw = value.executables ?? [];
  const executables = [];
  if (!Array.isArray(raw)) push(errors, 'INVALID_PERMISSION_FIELD', 'process.executables', 'must be an array');
  else for (let i = 0; i < raw.length; i += 1) {
    const executable = raw[i];
    if (!executableBasename(executable)) {
      push(errors, 'INVALID_EXECUTABLE', `process.executables[${i}]`, 'must be a basename, never a shell fragment or path');
    } else executables.push(executable);
  }
  const maxChildren = value.max_children ?? (mode === 'argv-allowlist' ? 1 : 0);
  if (!Number.isInteger(maxChildren) || maxChildren < 0 || maxChildren > 1024) push(errors, 'INVALID_PROCESS_LIMIT', 'process.max_children', 'must be an integer in 0..1024');
  if (mode === 'deny' && (executables.length > 0 || maxChildren !== 0)) push(errors, 'DENY_WITH_PROCESS_ALLOWLIST', 'process', 'deny mode cannot carry executable grants');
  if (mode === 'argv-allowlist' && executables.length === 0) push(errors, 'EMPTY_PROCESS_ALLOWLIST', 'process.executables', 'argv-allowlist mode requires at least one executable');
  return { mode: mode === 'argv-allowlist' ? 'argv-allowlist' : 'deny', executables: [...new Set(executables)].sort(), max_children: Number.isInteger(maxChildren) ? maxChildren : 0 };
}

function normalizeEnvironment(errors, value) {
  if (value === undefined) return { allow: [] };
  if (!isPlainObject(value)) {
    push(errors, 'INVALID_PERMISSION_FIELD', 'environment', 'must be an object');
    return { allow: [] };
  }
  rejectUnknownKeys(errors, value, ENV_KEYS, 'environment');
  const raw = value.allow ?? [];
  if (!Array.isArray(raw)) {
    push(errors, 'INVALID_PERMISSION_FIELD', 'environment.allow', 'must be an array of variable names');
    return { allow: [] };
  }
  const allow = [];
  for (let i = 0; i < raw.length; i += 1) {
    if (typeof raw[i] !== 'string' || !ENV_NAME.test(raw[i])) push(errors, 'INVALID_ENV_NAME', `environment.allow[${i}]`, 'must be an environment variable name, not NAME=value');
    else allow.push(raw[i]);
  }
  return { allow: [...new Set(allow)].sort() };
}

function normalizeSecretRefs(errors, value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    push(errors, 'INVALID_PERMISSION_FIELD', 'secret_refs', 'must be an array of opaque reference names');
    return [];
  }
  const refs = [];
  for (let i = 0; i < value.length; i += 1) {
    const ref = value[i];
    if (typeof ref !== 'string' || ref.length < 1 || ref.length > 128 || /[\s=]/.test(ref)) push(errors, 'INVALID_SECRET_REF', `secret_refs[${i}]`, 'must be a short opaque name; secret values and NAME=value are forbidden');
    else refs.push(ref);
  }
  return [...new Set(refs)].sort();
}

function normalizeLimits(errors, value) {
  const defaults = { wall_ms: 30_000, stdout_bytes: 1_048_576, stderr_bytes: 1_048_576 };
  if (value === undefined) return defaults;
  if (!isPlainObject(value)) {
    push(errors, 'INVALID_PERMISSION_FIELD', 'limits', 'must be an object');
    return defaults;
  }
  rejectUnknownKeys(errors, value, LIMIT_KEYS, 'limits');
  const out = { ...defaults };
  for (const key of LIMIT_KEYS) {
    if (value[key] === undefined) continue;
    if (!Number.isInteger(value[key]) || value[key] <= 0 || value[key] > Number.MAX_SAFE_INTEGER) push(errors, 'INVALID_RESOURCE_LIMIT', `limits.${key}`, 'must be a positive safe integer');
    else out[key] = value[key];
  }
  return out;
}

export function validatePermissionManifest(input) {
  const errors = [];
  if (!isPlainObject(input)) return { ok: false, errors: [{ code: 'INVALID_PERMISSION_MANIFEST', field: '(root)', message: 'must be a plain object' }], value: null };
  rejectUnknownKeys(errors, input, TOP_LEVEL_KEYS, '(root)');
  if (input.schema !== PERMISSION_MANIFEST_SCHEMA) push(errors, 'UNSUPPORTED_PERMISSION_SCHEMA', 'schema', `must equal ${PERMISSION_MANIFEST_SCHEMA}`);
  const value = {
    schema: PERMISSION_MANIFEST_SCHEMA,
    read_roots: normalizeRoots(errors, input.read_roots, 'read_roots'),
    write_roots: normalizeRoots(errors, input.write_roots, 'write_roots'),
    network: normalizeNetwork(errors, input.network),
    process: normalizeProcess(errors, input.process),
    environment: normalizeEnvironment(errors, input.environment),
    secret_refs: normalizeSecretRefs(errors, input.secret_refs),
    limits: normalizeLimits(errors, input.limits),
  };
  return { ok: errors.length === 0, errors, value: errors.length === 0 ? value : null };
}

function pathInside(relPath, roots) {
  const candidate = portableRoot(relPath);
  if (candidate === null) return false;
  return roots.some((root) => root === '.' || candidate === root || candidate.startsWith(`${root}/`));
}

export function compilePermissionPolicy(input) {
  const result = validatePermissionManifest(input);
  if (!result.ok) {
    const error = new TypeError(`invalid permission manifest: ${result.errors.map((x) => `${x.field}:${x.code}`).join(', ')}`);
    error.code = 'INVALID_PERMISSION_MANIFEST';
    error.details = result.errors;
    throw error;
  }
  const manifest = result.value;
  return Object.freeze({
    manifest,
    canRead(relPath) { return pathInside(relPath, manifest.read_roots); },
    canWrite(relPath) { return pathInside(relPath, manifest.write_roots); },
    canConnect(host, port) {
      if (manifest.network.mode !== 'allowlist' || typeof host !== 'string' || !Number.isInteger(port)) return false;
      const normalized = host.toLowerCase();
      return manifest.network.allow.some((rule) => rule.host === normalized && rule.ports.includes(port));
    },
    canExecute(executable) {
      return manifest.process.mode === 'argv-allowlist' && executableBasename(executable) && manifest.process.executables.includes(executable);
    },
    canReadEnv(name) { return typeof name === 'string' && manifest.environment.allow.includes(name); },
    canUseSecret(ref) { return typeof ref === 'string' && manifest.secret_refs.includes(ref); },
  });
}
