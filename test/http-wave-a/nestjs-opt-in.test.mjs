import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { fileURLToPath } from 'node:url';
import { emitNestJsCandidateContract, projectNestJsScanReport } from '../../next/t12/nestjs-opt-in.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const FEATURE = { featureId: '001-nest-users', featureUid: '123e4567-e89b-42d3-a456-426614174000' };

function facts() {
  return {
    moduleFacts: {
      contract: 'bskel.internal.js-ts-source-facts/0', filePath: 'src/users.controller.ts', complete: true,
      moduleEdges: [{ kind: 'import', specifier: '@nestjs/common', bindings: [
        { imported: 'Controller', local: 'Controller' }, { imported: 'Get', local: 'Get' },
        { imported: 'All', local: 'All' }, { imported: 'UseGuards', local: 'UseGuards' },
      ] }],
    },
    structureFacts: {
      contract: 'bskel.internal.js-ts-structure/0', filePath: 'src/users.controller.ts', complete: true,
      syntaxValidated: true, decoratedClasses: [{
        name: 'UsersController', source: { line: 2 },
        decorators: [
          { name: 'Controller', called: true, arguments: [{ kind: 'literal', value: 'users' }] },
          { name: 'UseGuards', called: true, arguments: [{ kind: 'expression', text: 'AuthGuard' }] },
        ],
        members: [
          { kind: 'method', name: 'show', source: { line: 5 }, decorators: [
            { name: 'Get', called: true, arguments: [{ kind: 'literal', value: ':id' }] },
          ] },
          { kind: 'method', name: 'all', source: { line: 8 }, decorators: [
            { name: 'All', called: true, arguments: [{ kind: 'literal', value: 'any' }] },
          ] },
        ],
      }],
    },
  };
}

function validate(schemaFile, value) {
  const ajv = new Ajv2020({ strict: false });
  addFormats(ajv);
  const schema = JSON.parse(fs.readFileSync(path.join(ROOT, schemaFile), 'utf8'));
  const check = ajv.compile(schema);
  assert.equal(check(value), true, JSON.stringify(check.errors));
}

test('opt-in bridge projects routes and all uncertainty into the common scan report', () => {
  const report = projectNestJsScanReport(facts());
  validate('schemas/scan-report.schema.json', report);
  assert.deepEqual(report.related_modules[0].controllers[0].endpoints.map((ep) => [ep.verb, ep.path, ep.operationId]), [
    ['GET', '/users/:id', null],
  ]);
  assert.deepEqual(report.files_read, [], 'hand-fed facts do not prove a Nest source read');
  assert.equal(Object.hasOwn(report.related_modules[0].controllers[0], 'file'), false,
    'the common contract builder must not re-read a caller-named source path');
  for (const marker of ['NESTJS_UPSTREAM_FACTS_INCOMPLETE', 'global prefix unresolved',
    'global authorization unresolved', 'source producer unverified']) {
    assert.ok(report.unknowns.some((item) => item.includes(marker)), marker);
  }
  assert.ok(report.unknowns.some((item) => item.includes('@All method set is not projected')));
});

test('common feature-contract consumer preserves the missing operation identity as blocked', () => {
  const { scanReport, contract } = emitNestJsCandidateContract({ facts: facts(), ...FEATURE });
  validate('schemas/scan-report.schema.json', scanReport);
  validate('schemas/feature-contract.schema.json', contract);
  assert.deepEqual(contract.operations, {});
  assert.equal(contract.completeness.status, 'blocked');
  assert.ok(contract.warnings.some((warning) => warning.code === 'CONTRACT_UNMATCHED_ENDPOINT'));
  assert.equal(contract.source.adapter, 'typescript-nestjs');
});

test('opt-in CLI consumes a JSON fact file and refuses mismatched facts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nestjs-opt-in-'));
  try {
    const file = path.join(dir, 'facts.json');
    fs.writeFileSync(file, JSON.stringify(facts()));
    const cli = path.join(ROOT, 'next/t12/nestjs-opt-in.mjs');
    const ok = spawnSync(process.execPath, [cli, '--facts', file, '--feature-id', FEATURE.featureId,
      '--feature-uid', FEATURE.featureUid], { encoding: 'utf8' });
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(JSON.parse(ok.stdout).contract.completeness.status, 'blocked');
    const bad = facts();
    bad.moduleFacts.filePath = 'src/other.ts';
    fs.writeFileSync(file, JSON.stringify(bad));
    const mismatch = spawnSync(process.execPath, [cli, '--facts', file], { encoding: 'utf8' });
    assert.equal(mismatch.status, 0, mismatch.stderr);
    const report = JSON.parse(mismatch.stdout);
    assert.deepEqual(report.related_modules, []);
    assert.ok(report.unknowns.some((item) => item.includes('NESTJS_FACT_FILE_MISMATCH')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
