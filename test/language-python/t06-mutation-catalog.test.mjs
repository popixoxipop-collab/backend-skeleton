import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { validateProductMutationCatalog } from '../conformance-next/product-mutation-runner.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const catalog = JSON.parse(fs.readFileSync(path.join(repoRoot, 'next/t06/T06_04_PRODUCT_MUTATIONS.json'), 'utf8'));

// This file is intentionally absent from every mutant's test_files list. A
// textual anchor check must never count as a behavioral mutation kill.
test('T06 product-source mutation catalog has unique anchors and regression files', () => {
  assert.deepEqual(validateProductMutationCatalog(catalog).errors, []);
  assert.equal(catalog.mutants.length, 4);
  for (const mutant of catalog.mutants) {
    const source = fs.readFileSync(path.join(repoRoot, mutant.file), 'utf8');
    assert.equal(source.split(mutant.find).length, 2, mutant.id);
    assert.ok(mutant.test_files.every((file) => fs.existsSync(path.join(repoRoot, file))), mutant.id);
    assert.ok(!mutant.test_files.includes('test/language-python/t06-mutation-catalog.test.mjs'));
  }
});
