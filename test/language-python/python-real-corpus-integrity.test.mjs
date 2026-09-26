import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gitBlobSha, verifySelectedCorpusFiles } from './real-corpus-integrity.mjs';

test('T06 real-corpus selected source is bound to exact Git blob bytes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-t06-corpus-integrity-'));
  fs.mkdirSync(path.join(root, 'project'));
  const file = path.join(root, 'project', 'module.py');
  const original = Buffer.from('x = 1\n', 'utf8');
  fs.writeFileSync(file, original);
  const records = [{ path: 'module.py', blobSha: gitBlobSha(original) }];

  const verified = verifySelectedCorpusFiles(root, 'project', records);
  assert.deepEqual(verified.selected, [{ path: 'module.py', blobSha: records[0].blobSha, sizeBytes: original.length }]);

  fs.writeFileSync(file, 'x = 2\n');
  assert.throws(
    () => verifySelectedCorpusFiles(root, 'project', records),
    /corpus source blob mismatch/,
    'a dirty selected file must not pass merely because checkout HEAD is still pinned',
  );
});

test('T06 real-corpus selected source cannot escape the project root through a symlink', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-t06-corpus-symlink-'));
  const projectRoot = path.join(root, 'project');
  const outside = path.join(root, 'outside.py');
  fs.mkdirSync(projectRoot);
  fs.writeFileSync(outside, 'x = 1\n');
  try {
    fs.symlinkSync(outside, path.join(projectRoot, 'module.py'));
  } catch (error) {
    t.skip(`symlink unsupported: ${error.code || error.message}`);
    return;
  }
  assert.throws(
    () => verifySelectedCorpusFiles(root, 'project', [{ path: 'module.py', blobSha: gitBlobSha(fs.readFileSync(outside)) }]),
    /escapes project root/,
  );
});

test('T06 real-corpus manifest reserves holdouts without T06-authored files or golden', () => {
  const manifest = JSON.parse(fs.readFileSync(new URL('./real-corpus.manifest.json', import.meta.url), 'utf8'));
  assert.equal(manifest.schema, 'bskel.t06.real-corpus/2');
  assert.ok(manifest.cases.every((entry) => entry.files.every((file) => /^[0-9a-f]{40}$/.test(file.blobSha))));
  assert.ok(manifest.reservedHoldouts.length >= 2);
  for (const holdout of manifest.reservedHoldouts) {
    assert.equal(holdout.sourceInspectedByT06, false);
    assert.equal(holdout.golden, null);
    assert.equal(holdout.owner, 'T19');
    assert.equal('files' in holdout, false);
  }
});
