import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { validateProductMutationCatalog } from '../conformance-next/product-mutation-runner.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const catalog = JSON.parse(fs.readFileSync(path.join(root, 'next/t07/T07_04_PRODUCT_MUTATIONS.json'), 'utf8'));

// Anchor checks must not count as behavioral mutation kills.
test('T07 mutation catalog binds unique product anchors to behavioral tests', () => {
  assert.deepEqual(validateProductMutationCatalog(catalog).errors, []);
  assert.equal(catalog.mutants.length, 5);
  for (const mutant of catalog.mutants) {
    const source = fs.readFileSync(path.join(root, mutant.file), 'utf8');
    assert.equal(source.split(mutant.find).length, 2, mutant.id);
    assert.ok(mutant.test_files.every((file) => fs.existsSync(path.join(root, file))), mutant.id);
    assert.ok(!mutant.test_files.includes('test/language-ruby-php/t07-mutation-catalog.test.mjs'));
  }
});
