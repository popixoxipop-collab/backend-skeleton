import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { IDENTITY_PACK, RELEASE_DIR, REPO_ROOT, clone, inventory } from './policy-fixtures.mjs';

// The verifier is only useful if `node release-policy.mjs verify ...` actually runs. A main guard that compares
// import.meta.url (percent-encoded, symlinks resolved) with 'file://' + process.argv[1] silently does nothing,
// and exits 0 with no output, whenever the path contains a space, '#', '%', '?', non-ASCII text or a symlink.

const LAYOUTS = [
  ['a plain path (control)', 'plain'],
  ['a space', 'with space'],
  ['a hash sign', 'hash#dir'],
  ['a literal percent escape', 'percent%20dir'],
  ['a question mark', 'what?dir'],
  ['non-ASCII letters', 'café-한글'],
];

function sandbox(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-entry-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return base;
}

// The script and its data are real files under `root`; lib/ is a link to the repository's own lib/ so the rest of the
// import graph (and node_modules) resolves from the real checkout, whatever `root` is called.
function install(root) {
  fs.mkdirSync(root, { recursive: true });
  fs.symlinkSync(path.join(REPO_ROOT, 'lib'), path.join(root, 'lib'), 'dir');
  fs.cpSync(RELEASE_DIR, path.join(root, 'release', 'next'), { recursive: true, filter: (src) => path.basename(src) !== 'test' });
  fs.mkdirSync(path.join(root, 'schemas', 'next'), { recursive: true });
  fs.copyFileSync(path.join(REPO_ROOT, IDENTITY_PACK), path.join(root, IDENTITY_PACK));
  return path.join(root, 'release', 'next', 'release-policy.mjs');
}

function invoke(script, args) {
  const run = spawnSync(process.execPath, [script, ...args], { cwd: os.tmpdir(), encoding: 'utf8', timeout: 60000, env: { PATH: process.env.PATH } });
  assert.equal(run.error, undefined);
  return run;
}

function checkEntry(t, script, copyRoot, label) {
  const dir = path.join(copyRoot, 'release', 'next');
  const files = [path.join(dir, 'compatibility-inventory.json'), path.join(dir, 'release-plan.json'), path.join(dir, 'evidence-manifest.json')];
  const good = invoke(script, ['verify', ...files]);
  assert.equal(good.status, 0, `${label}: ${good.stderr}`);
  assert.equal(JSON.parse(good.stdout || 'null')?.ok, true, `${label}: a valid release must print its JSON verdict`);

  const broken = clone(inventory);
  broken.schema = 'bskel.scale-release-compatibility/0';
  const badInventory = path.join(path.dirname(copyRoot), `bad-${path.basename(copyRoot).replace(/[^a-z0-9]/gi, '_')}.json`);
  fs.writeFileSync(badInventory, JSON.stringify(broken));
  t.after(() => fs.rmSync(badInventory, { force: true }));
  const bad = invoke(script, ['verify', badInventory, files[1], files[2]]);
  assert.equal(bad.status, 2, `${label}: an invalid inventory must fail with exit 2, not silently exit ${bad.status}`);
  assert.equal(JSON.parse(bad.stdout || 'null')?.ok, false, `${label}: the failing verdict must be printed`);
}

for (const [label, dirName] of LAYOUTS) {
  test(`the CLI entry point runs when the script path contains ${label}`, (t) => {
    const root = path.join(sandbox(t), dirName);
    checkEntry(t, install(root), root, label);
  });
}

test('the CLI entry point runs when it is invoked through a symlinked file or a symlinked directory', (t) => {
  const base = sandbox(t);
  const real = path.join(base, 'real');
  const script = install(real);

  fs.mkdirSync(path.join(base, 'bin'));
  const fileLink = path.join(base, 'bin', 'run-policy.mjs');
  fs.symlinkSync(script, fileLink);
  checkEntry(t, fileLink, real, 'symlinked script');

  const dirLink = path.join(base, 'linked');
  fs.symlinkSync(real, dirLink);
  checkEntry(t, path.join(dirLink, 'release', 'next', 'release-policy.mjs'), real, 'symlinked directory');
});

test('importing the module never runs the CLI, with or without a script path', (t) => {
  const base = sandbox(t);
  const script = install(path.join(base, 'tree'));
  const url = pathToFileURL(script).href;

  const noScript = spawnSync(process.execPath, ['--input-type=module', '-e', `const m = await import(${JSON.stringify(url)}); console.log(typeof m.verifyAll);`], { cwd: os.tmpdir(), encoding: 'utf8', timeout: 60000, env: { PATH: process.env.PATH } });
  assert.equal(noScript.status, 0, noScript.stderr);
  assert.equal(noScript.stdout, 'function\n');
  assert.equal(noScript.stderr, '');

  const importer = path.join(base, 'importer.mjs');
  fs.writeFileSync(importer, `import { verifyAll } from ${JSON.stringify(url)};\nconsole.log(typeof verifyAll);\n`);
  const imported = invoke(importer, ['verify', 'inventory.json', 'plan.json', 'manifest.json']);
  assert.equal(imported.status, 0, imported.stderr);
  assert.equal(imported.stdout, 'function\n');
  assert.equal(imported.stderr, '');
});
