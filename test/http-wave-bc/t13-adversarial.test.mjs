import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateProductMutationCatalog } from '../conformance-next/product-mutation-runner.mjs';
import { detectHonoRoot, scanHono } from '../../adapters/http-wave-bc/node-hono/adapter.mjs';
import { detectKoaRouterRoot, scanKoaRouter } from '../../adapters/http-wave-bc/node-koa/adapter.mjs';
import { detectNextRoot, scanNext } from '../../adapters/http-wave-bc/typescript-nextjs/adapter.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const catalog = JSON.parse(fs.readFileSync(path.join(repoRoot, 'next/t13/T13_04_PRODUCT_MUTATIONS.json'), 'utf8'));
const samples = [
  {
    name: 'Hono', module: 'node-hono', detect: 'detectHonoRoot', scan: 'scanHono',
    package: { name: 't13-hono', dependencies: { hono: '4.13.9' } },
    source: 'src/app.ts',
    code: "import { Hono } from 'hono'\nconst app = new Hono()\napp.get('/alive', alive)\nexport default app\n",
    negative: (root) => fs.writeFileSync(path.join(root, 'src/app.ts'),
      "import { Hono } from 'hono'\nconst app = new Hono()\n// app.get('/ghost', ghost)\nexport default app\n"),
  },
  {
    name: 'Koa', module: 'node-koa', detect: 'detectKoaRouterRoot', scan: 'scanKoaRouter',
    package: { name: 't13-koa', dependencies: { koa: '3.2.1', '@koa/router': '15.7.0' } },
    source: 'src/app.js',
    code: "import Koa from 'koa'\nimport Router from '@koa/router'\nconst app = new Koa()\nconst router = new Router()\nrouter.get('/alive', alive)\napp.use(router.routes())\n",
    negative: (root) => fs.writeFileSync(path.join(root, 'src/app.js'),
      "import Koa from 'koa'\nimport Router from '@koa/router'\nconst app = new Koa()\nconst router = new Router()\nrouter.get('/ghost', ghost)\n"),
  },
  {
    name: 'Next.js', module: 'typescript-nextjs', detect: 'detectNextRoot', scan: 'scanNext',
    package: { name: 't13-next', dependencies: { next: '16.4.0-canary.45' } },
    source: 'app/api/alive/route.ts', code: 'export function GET() {}\n',
    negative: (root) => fs.writeFileSync(path.join(root, 'next.config.js'),
      'module.exports = { basePath: process.env.BASE_PATH }\n'),
  },
];
const APIs = [
  [detectHonoRoot, scanHono], [detectKoaRouterRoot, scanKoaRouter], [detectNextRoot, scanNext],
];

function withFixture(sample, run) {
  const fixtureParent = process.getuid?.() === 0 ? '/tmp' : os.tmpdir();
  const root = fs.mkdtempSync(path.join(fixtureParent, 'bskel-t13-adversarial-'));
  try {
    fs.chmodSync(root, 0o755);
    const source = path.join(root, sample.source);
    fs.mkdirSync(path.dirname(source), { recursive: true, mode: 0o755 });
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(sample.package), { mode: 0o644 });
    fs.writeFileSync(source, sample.code, { mode: 0o644 });
    return run(root);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test('T13 product-mutation catalog names unique exact source anchors and runnable tests', () => {
  assert.deepEqual(validateProductMutationCatalog(catalog).errors, []);
  assert.equal(catalog.mutants.length, 4);
  for (const mutant of catalog.mutants) {
    const source = fs.readFileSync(path.join(repoRoot, mutant.file), 'utf8');
    assert.equal(source.split(mutant.find).length, 2, mutant.id);
    assert.ok(mutant.test_files.every((file) => fs.existsSync(path.join(repoRoot, file))), mutant.id);
  }
});

test('T13 Hono, Koa and Next.js accept bounded normal routes and withhold mutated inputs', () => {
  samples.forEach((sample, index) => withFixture(sample, (root) => {
    const [detect, scan] = APIs[index];
    const detected = detect(root);
    assert.ok(detected, sample.name);
    const normal = scan(root, detected);
    const normalPaths = normal.modules.flatMap((module) => module.controllers)
      .flatMap((controller) => controller.endpoints).map((endpoint) => endpoint.path);
    assert.deepEqual(normalPaths, [sample.name === 'Next.js' ? '/api/alive' : '/alive'], sample.name);
    sample.negative(root);
    const negative = scan(root);
    const negativePaths = negative.modules.flatMap((module) => module.controllers)
      .flatMap((controller) => controller.endpoints).map((endpoint) => endpoint.path);
    assert.deepEqual(negativePaths, [], sample.name);
  }));
});

test('T13 unreadable package and source bytes cannot become discovered routes', () => {
  const child = `import fs from 'node:fs';
    const [moduleUrl, root, file, detectName, scanName] = process.argv.slice(1);
    let denied = false;
    try { fs.readFileSync(file); } catch (error) { denied = error.code === 'EACCES'; }
    if (!denied) throw Error('permission denial was not observed');
    const api = await import(moduleUrl);
    const detection = api[detectName](root);
    const report = api[scanName](root, detection);
    console.log(JSON.stringify({ detected: Boolean(detection), routes: report.modules.length }));`;
  // A root-owned CI checkout (or Node under /root/.nvm) is not traversable by nobody.
  // Stage only the executable and adapter imports in a public, task-owned directory.
  const rootIdentity = process.getuid?.() === 0;
  const publicRoot = fs.mkdtempSync(path.join(rootIdentity ? '/tmp' : os.tmpdir(), 'bskel-t13-permission-runtime-'));
  try {
    fs.chmodSync(publicRoot, 0o755);
    const runtime = path.join(publicRoot, 'bin/node');
    if (rootIdentity) {
      fs.mkdirSync(path.dirname(runtime), { mode: 0o755 });
      fs.copyFileSync(process.execPath, runtime);
      fs.chmodSync(runtime, 0o755);
      // Homebrew's macOS Node loads libnode from @loader_path/../lib.
      if (process.platform === 'darwin') {
        const sourceLib = path.resolve(path.dirname(process.execPath), '../lib');
        for (const name of fs.readdirSync(sourceLib).filter((name) => /^libnode\..*\.dylib$/.test(name))) {
          const target = path.join(publicRoot, 'lib', name);
          fs.mkdirSync(path.dirname(target), { mode: 0o755 });
          fs.copyFileSync(path.join(sourceLib, name), target);
          fs.chmodSync(target, 0o644);
        }
      }
    }
    const dependencies = [
      'adapters/http-wave-bc/node-hono/adapter.mjs',
      'adapters/http-wave-bc/node-hono/route-graph.mjs',
      'adapters/http-wave-bc/node-koa/adapter.mjs',
      'adapters/http-wave-bc/typescript-nextjs/adapter.mjs',
      'scanners/adapters/_express-shared.mjs',
      'scanners/text-util.mjs',
    ];
    for (const relative of dependencies) {
      const target = path.join(publicRoot, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
      fs.copyFileSync(path.join(repoRoot, relative), target);
      fs.chmodSync(target, 0o644);
    }
    samples.forEach((sample) => withFixture(sample, (root) => {
      const moduleUrl = pathToFileURL(path.join(publicRoot, `adapters/http-wave-bc/${sample.module}/adapter.mjs`)).href;
      const identity = rootIdentity ? { uid: 65534, gid: 65534 } : {};
      for (const file of [path.join(root, 'package.json'), path.join(root, sample.source)]) {
        fs.chmodSync(file, 0);
        try {
          const result = spawnSync(rootIdentity ? runtime : process.execPath,
            ['--input-type=module', '-e', child, moduleUrl, root, file, sample.detect, sample.scan],
            { cwd: publicRoot, encoding: 'utf8', ...identity });
          assert.equal(result.status, 0, `${sample.name}: ${result.error ?? result.stderr}`);
          const observed = JSON.parse(result.stdout);
          assert.equal(observed.routes, 0, sample.name);
          if (path.basename(file) === 'package.json') assert.equal(observed.detected, false, sample.name);
        } finally { fs.chmodSync(file, 0o644); }
      }
    }));
  } finally { fs.rmSync(publicRoot, { recursive: true, force: true }); }
});
