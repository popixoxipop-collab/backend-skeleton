import './leaf-inventory.test.mjs';
import './profile-evidence.test.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { HTTP_WAVE_BC_TARGETS, validateWaveBcCatalog } from '../../adapters/http-wave-bc/catalog.mjs';

test('T13 catalog has exactly 9 Wave B and 7 Wave C unique targets', () => {
  assert.deepEqual(validateWaveBcCatalog(), []);
  assert.equal(HTTP_WAVE_BC_TARGETS.length, 16);
  assert.equal(HTTP_WAVE_BC_TARGETS.filter((x) => x.wave === 'B').length, 9);
  assert.equal(HTTP_WAVE_BC_TARGETS.filter((x) => x.wave === 'C').length, 7);
  assert.equal(new Set(HTTP_WAVE_BC_TARGETS.map((x) => x.id)).size, 16);
});

test('T13 catalog rejects duplicate and malformed entries', () => {
  const bad = [
    ...HTTP_WAVE_BC_TARGETS,
    { id: 'node-hono', wave: 'Z', languageTrack: 'T99', runtime: '', scope: '' },
  ];
  const errors = validateWaveBcCatalog(bad);
  assert.ok(errors.some((x) => x.includes('duplicate id')));
  assert.ok(errors.some((x) => x.includes('wave must be B or C')));
  assert.ok(errors.some((x) => x.includes('invalid languageTrack')));
});
