import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { detectHonoRoot } from '../../adapters/http-wave-bc/node-hono/adapter.mjs';
import { validateProductMutationCatalog, runProductMutationCampaign } from '../conformance-next/product-mutation-runner.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const catalog = JSON.parse(fs.readFileSync(path.join(here, 't13-product-mutations.json'), 'utf8'));

test('T13-04 product mutation catalog is valid and bound to four adversarial vectors', () => {
  const result = validateProductMutationCatalog(catalog);
  assert.deepEqual(result.errors, []);
  assert.equal(result.stats.mutants, 4);
  assert.deepEqual(catalog.mutants.map((mutant) => mutant.critical), [true, true, true, false]);
  assert.deepEqual(catalog.mutants.map((mutant) => mutant.vector_id), [
    'NEG-T13-HONO-BASEPATH-01',
    'NEG-T13-KOA-MOUNT-01',
    'NEG-T13-NEXT-BASEPATH-01',
    'NEG-T13-HONO-LITERAL-BASEPATH-01',
  ]);
});

test('T13-04 Node permission boundary suppresses unreadable Hono projects', () => {
  const deniedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 't13-denied-'));
  try {
    fs.writeFileSync(path.join(deniedRoot, 'package.json'), JSON.stringify({ dependencies: { hono: '4.13.9' } }));
    fs.writeFileSync(path.join(deniedRoot, 'app.ts'), "import { Hono } from 'hono';\nconst app = new Hono();\napp.get('/secret', handler);\n");
    assert.ok(detectHonoRoot(deniedRoot), 'control project must be detectable without a permission boundary');

    const script = `
      import fs from 'node:fs';
      import { detectHonoRoot, scanHono } from ${JSON.stringify(pathToFileURL(path.join(repoRoot, 'adapters/http-wave-bc/node-hono/adapter.mjs')).href)};
      const root = process.argv[1];
      let denied = false;
      try { fs.readFileSync(root + '/package.json'); }
      catch (error) { denied = error.code === 'ERR_ACCESS_DENIED'; }
      const detection = detectHonoRoot(root);
      const scan = scanHono(root, detection);
      if (!denied || detection !== null || scan.modules.length !== 0) process.exitCode = 1;
      console.log(JSON.stringify({ denied, detected: detection !== null, modules: scan.modules.length }));
    `;
    const run = spawnSync(process.execPath, [
      '--permission', `--allow-fs-read=${repoRoot}`, '--input-type=module', '-e', script, deniedRoot,
    ], { cwd: repoRoot, encoding: 'utf8', timeout: 15_000 });
    assert.equal(run.status, 0, `${run.stderr}\n${run.stdout}`);
    assert.deepEqual(JSON.parse(run.stdout.trim()), { denied: true, detected: false, modules: 0 });
  } finally {
    fs.rmSync(deniedRoot, { recursive: true, force: true });
  }
});

test('T13-04 Hono, Koa and Next.js product mutations are killed', { timeout: 240_000 }, () => {
  const report = runProductMutationCampaign({ repoRoot, catalog });
  assert.equal(report.pass, true, JSON.stringify(report.mutants, null, 2));
  assert.deepEqual(report.mutants.map((mutant) => mutant.status), ['killed', 'killed', 'killed', 'killed']);
  assert.ok(report.mutants.every((mutant) => mutant.baseline.exit_code === 0));
});
