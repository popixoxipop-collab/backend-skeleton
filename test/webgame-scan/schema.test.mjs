import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { scanMultiplane } from '../../scanners/multiplane.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const FIXTURE = path.join(ROOT, 'fixtures/webgame-static/mixed-repo');
const readJson = (name) => JSON.parse(fs.readFileSync(path.join(ROOT, 'schemas', name), 'utf8'));

test('Track A mixed-repo output validates against project, plane and multiplane schemas', () => {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const validateProject = ajv.compile(readJson('project.schema.json'));
  const validatePlane = ajv.compile(readJson('plane-adapter.schema.json'));
  const validateReport = ajv.compile(readJson('multiplane-scan.schema.json'));
  const report = scanMultiplane({ repoRoot: FIXTURE });

  assert.equal(validateReport(report), true, ajv.errorsText(validateReport.errors));
  for (const project of report.projects) {
    assert.equal(validateProject(project), true, ajv.errorsText(validateProject.errors));
  }
  for (const domain of report.domains) {
    assert.equal(validatePlane(domain), true, ajv.errorsText(validatePlane.errors));
  }
});
