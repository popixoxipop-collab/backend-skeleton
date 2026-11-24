// Runs the real in-repo Python HTTP scanners over scope-record fixture directories and prints one
// canonical JSON document: `node static-runner.mjs <flask|fastapi|django|starlette> <fixtures-root>`.
// It only normalizes what the scanners emitted (routes + flags); it adds no route of its own.
// Starlette can be replayed only from the later T13 installation. Litestar remains scope-only.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { analyzePythonFiles } from '../../../scanners/language/python/analyzer.mjs';
import { buildPythonProjectFacts } from '../../../scanners/language/python/resolver.mjs';
import { buildFlaskRouteShadow } from '../../../scanners/language/python/flask-shadow.mjs';
import { buildFastApiShadow } from '../../../scanners/language/python/fastapi-shadow.mjs';
import { buildDjangoUrlShadow } from '../../../scanners/language/python/django-shadow.mjs';
import { detectPythonFastApiRoot, scanPythonFastApi } from '../../../scanners/adapters/python-fastapi.mjs';
import { projectFlaskShadow } from '../flask.mjs';
import { projectDjangoDrfShadow } from '../django-drf.mjs';

export const STATIC_RUNNER_SCHEMA = 'bskel.internal.python-scope-static-run/0';
const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const STARLETTE_LAYER = 't13-starlette-static';
const STARLETTE_SOURCES = Object.freeze([
  'adapters/http/python-starlette/facts.py',
  'adapters/http/python-starlette/project.mjs',
  'adapters/http/python-starlette/scan.mjs',
]);
const ENTRY = { starlette: 'app.py', flask: 'app.py', fastapi: 'app.py', django: 'urls.py' };
export const STATIC_LAYERS = {
  flask: ['t06-flask-shadow', 't12-flask-leaf'],
  fastapi: ['legacy-adapter', 't06-fastapi-shadow'],
  django: ['t06-django-shadow', 't12-django-drf-leaf'],
};
// The in-repo file each layer id runs (the imports above); verify.mjs holds a record's layers[].source to this table.
export const STATIC_LAYER_SOURCES = {
  [STARLETTE_LAYER]: STARLETTE_SOURCES[2],
  'legacy-adapter': 'scanners/adapters/python-fastapi.mjs',
  't06-fastapi-shadow': 'scanners/language/python/fastapi-shadow.mjs',
  't06-flask-shadow': 'scanners/language/python/flask-shadow.mjs',
  't12-flask-leaf': 'adapters/http-wave-a/flask.mjs',
  't06-django-shadow': 'scanners/language/python/django-shadow.mjs',
  't12-django-drf-leaf': 'adapters/http-wave-a/django-drf.mjs',
};

// Lists every file below dir, sorted, with nothing skipped: a __pycache__ directory inside a fixture tree is a set of files
// the verifier has to see (Python loads a .pyc whose recorded source size and mtime match instead of the source it hashed).
// A symbolic link is listed as a file entry, whether it points at a file or a directory.
export function walk(dir, rel = '') {
  return fs.readdirSync(path.join(dir, rel), { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .flatMap((entry) => {
      const next = rel ? `${rel}/${entry.name}` : entry.name;
      return entry.isDirectory() ? walk(dir, next) : [next];
    });
}

export function fixtureDirs(root, target) {
  const entry = ENTRY[target];
  if (!entry) throw new Error(`no static scanner layer exists for target "${target}"`);
  return walk(root).filter((file) => path.posix.basename(file) === entry).map((file) => path.posix.dirname(file)).sort();
}

function pythonProject(dir) {
  const files = walk(dir).filter((file) => file.endsWith('.py'));
  const batch = analyzePythonFiles({ repoRoot: dir, files });
  if (!batch.ok) throw new Error(`Python AST analysis failed for ${dir}: ${JSON.stringify(batch.results.filter((r) => !r.ok))}`);
  return buildPythonProjectFacts(batch.results);
}

const where = (item) => `${item.module ?? item.file ?? '?'}:${item.line ?? 0}`;

function flaskLayers(dir) {
  const shadow = buildFlaskRouteShadow(pythonProject(dir));
  const routes = shadow.registrations.flatMap((r) => (r.methods.length ? r.methods : [null]).map((method) => ({ method, path: r.path })));
  const flags = [
    ...shadow.unknowns.map((u) => ({ code: u.reason, where: where(u) })),
    ...shadow.registrations.flatMap((r) => r.limitations.map((text) => ({ code: 'registration-limitation', where: where(r), text }))),
  ];
  const leaf = projectFlaskShadow(shadow);
  return {
    't06-flask-shadow': { routes, flags },
    't12-flask-leaf': {
      routes: leaf.routes.map((r) => ({ method: r.method, path: r.path })),
      flags: leaf.unknowns.map((u) => ({ code: u.code, where: where(u.source ? { module: u.source.file, line: u.source.line } : u) })),
    },
  };
}

function fastapiLayers(dir) {
  const real = fs.realpathSync(dir);
  const detected = detectPythonFastApiRoot(real) === real;
  const legacy = scanPythonFastApi(real, real);
  const shadow = buildFastApiShadow(pythonProject(dir));
  return {
    'legacy-adapter': {
      detected,
      routes: legacy.modules.flatMap((m) => m.controllers.flatMap((c) => c.endpoints.map((e) => ({ method: e.verb, path: e.path })))),
      flags: legacy.pathPrefixSignals.map((s) => ({ code: s.kind, where: `${s.file}:0`, prefix: s.prefix })),
    },
    't06-fastapi-shadow': {
      routes: shadow.endpoints.map((e) => ({ method: e.verb, path: e.path })),
      flags: shadow.unknowns.map((u) => ({ code: u.reason, where: where(u) })),
    },
  };
}

function djangoLayers(dir) {
  const shadow = buildDjangoUrlShadow(pythonProject(dir));
  const leaf = projectDjangoDrfShadow(shadow);
  return {
    't06-django-shadow': {
      routes: shadow.registrations.map((r) => ({ method: null, path: '/' + r.patternSegments.map((s) => s.value).join('') })),
      flags: shadow.unknowns.map((u) => ({ code: u.reason, where: where(u) })),
    },
    't12-django-drf-leaf': {
      status: leaf.status,
      observations: leaf.observations.length,
      routes: leaf.routes.map((r) => ({ method: r.method, path: r.path })),
      flags: leaf.unknowns.map((u) => ({ code: u.code === 'T06_DJANGO_UNKNOWN' ? `${u.code}:${u.reason}` : u.code, where: where(u) })),
    },
  };
}

// The child receives only fixed interpreter code, the fixed adapter path, and fixture bytes on stdin.
function starletteLayers(dir, repoRoot) {
  const entry = path.join(dir, 'app.py');
  if (!fs.lstatSync(entry).isFile()) throw new Error('Starlette fixture must be a regular file');
  const script = [
    "import fs from 'node:fs';",
    "const { scanStarletteScopeLayer } = await import(process.argv[1]);",
    "const value = scanStarletteScopeLayer(fs.readFileSync(0), 'app.py', process.argv[2]);",
    "process.stdout.write(JSON.stringify(value));",
  ].join(' ');
  const target = pathToFileURL(path.join(repoRoot, STARLETTE_SOURCES[2])).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script, target, process.env.BSKEL_PYTHON || 'python3'], {
    input: fs.readFileSync(entry), encoding: 'utf8', timeout: 10000, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' },
  });
  if (result.error || result.status !== 0) throw new Error('Starlette scanner did not return a complete result');
  return { [STARLETTE_LAYER]: JSON.parse(result.stdout) };
}
const BUILDERS = { starlette: starletteLayers, flask: flaskLayers, fastapi: fastapiLayers, django: djangoLayers };

// Sorts every object's keys (default string order), so the stored document has one spelling; verify.mjs uses it to hold a
// stored static.json to exactly the text this runner prints for the document it holds.
export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

export function runStatic(target, root, { repoRoot = REPO } = {}) {
  const build = BUILDERS[target];
  const fixtures = {};
  for (const id of fixtureDirs(root, target)) fixtures[id] = { layers: build(path.join(root, id), repoRoot) };
  return canonical({ schema: STATIC_RUNNER_SCHEMA, target, layers: target === 'starlette' ? [STARLETTE_LAYER] : STATIC_LAYERS[target], fixtures });
}

export const serializeStatic = (result) => `${JSON.stringify(result, null, 1)}\n`;

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [target, root] = process.argv.slice(2);
  if (!target || !root) { console.error('usage: static-runner.mjs <flask|fastapi|django|starlette> <fixtures-root>'); process.exit(2); }
  process.stdout.write(serializeStatic(runStatic(target, path.resolve(root))));
}
