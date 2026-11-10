import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { projectNestJsFacts } from '../../adapters/http-wave-a/nestjs.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const oracleSource = path.join(here, 'fixtures/adversarial-nest-all/oracle.mjs');
const oracleOutput = path.join(here, 'fixtures/adversarial-nest-all/oracle-output.json');
const productSource = path.join(repo, 'adapters/http-wave-a/nestjs.mjs');
const sharedSource = path.join(repo, 'adapters/http-wave-a/_shared.mjs');
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

function facts() {
  return {
    moduleFacts: {
      contract: 'bskel.internal.js-ts-source-facts/0', complete: true,
      filePath: 'src/edge.controller.ts', moduleEdges: [{ kind: 'import', specifier: '@nestjs/common', bindings:
        ['Controller', 'All', 'UseGuards', 'Get'].map((name) => ({ imported: name, local: name, bindingKind: 'named', typeOnly: false })) }],
    },
    structureFacts: {
      contract: 'bskel.internal.js-ts-structure/0', complete: true, syntaxValidated: true,
      filePath: 'src/edge.controller.ts', decoratedClasses: [{ name: 'EdgeController', source: { line: 3 },
        decorators: [
          { name: 'Controller', called: true, arguments: [{ kind: 'literal', value: 'edge' }] },
          { name: 'UseGuards', called: true, arguments: [{ kind: 'expression', text: 'TokenGuard' }] },
        ],
        members: [
          { kind: 'method', name: 'catchAll', computed: false, source: { line: 6 }, decorators: [
            { name: 'All', called: true, arguments: [{ kind: 'literal', value: 'anything' }] },
            { name: 'UseGuards', called: true, arguments: [{ kind: 'expression', text: 'TokenGuard' }] },
          ] },
          { kind: 'method', name: 'health', computed: false, source: { line: 8 }, decorators: [
            { name: 'Get', called: true, arguments: [{ kind: 'literal', value: 'health' }] },
          ] },
        ],
      }],
    },
  };
}

function summary(project) {
  const result = project(facts());
  return {
    routes: result.routes.map((route) => [route.method, route.path]),
    allUnknown: result.unknowns.filter((item) => item.code === 'NESTJS_ALL_METHODS_UNKNOWN').length,
    guardUnknown: result.unknowns.filter((item) => item.code === 'NESTJS_GUARD_SEMANTICS_UNKNOWN').length,
    runtimeValidated: result.evidence?.runtimeValidated,
  };
}

test('real NestJS 12.0.1 @All and guard oracle remains an explicit negative differential', () => {
  assert.equal(sha256(fs.readFileSync(oracleSource)), '1ba45bcfa52f19c8a1a278ab876feff2eb21f1a5e446044bcbc46a1c8efdf721');
  assert.equal(sha256(fs.readFileSync(oracleOutput)), '4c1f0e57efacc21fddd0e236038fe0c8132a0e82dc069a033b4fb65abbc0454b');
  const oracle = JSON.parse(fs.readFileSync(oracleOutput));
  assert.equal(oracle.framework, '@nestjs/core 12.0.1');
  assert.deepEqual(oracle.probes.map((probe) => [probe.method, probe.authorized, probe.status]),
    ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'].flatMap((method) => [[method, true, 200], [method, false, 403]]));
  assert.deepEqual(summary(projectNestJsFacts), {
    routes: [['GET', '/edge/health']], allUnknown: 1, guardUnknown: 2, runtimeValidated: false,
  });
});

test('five product-source mutants lose @All or guard uncertainty and are behaviorally killed', async () => {
  const source = fs.readFileSync(productSource, 'utf8');
  const mutations = [
    { id: 'all-import-binding', from: "['Controller', 'All', 'UseGuards', ...VERB_DECORATORS.keys()]", to: "['Controller', 'UseGuards', ...VERB_DECORATORS.keys()]", throws: true },
    { id: 'all-unknown-emission', from: 'if (allDecorator) {', to: 'if (false) {', field: 'allUnknown', wanted: 0 },
    { id: 'guard-import-binding', from: "['Controller', 'All', 'UseGuards', ...VERB_DECORATORS.keys()]", to: "['Controller', 'All', ...VERB_DECORATORS.keys()]", throws: true },
    { id: 'class-guard-unknown', from: "if ((cls.decorators ?? []).some((d) => hasName(imported.get('UseGuards'), d))) {", to: 'if (false) {', field: 'guardUnknown', wanted: 1 },
    { id: 'method-guard-unknown', from: "if ((member.decorators ?? []).some((d) => hasName(imported.get('UseGuards'), d))) {", to: 'if (false) {', field: 'guardUnknown', wanted: 1 },
  ];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't12-nest-mutants-'));
  try {
    fs.copyFileSync(sharedSource, path.join(root, '_shared.mjs'));
    for (const [index, mutation] of mutations.entries()) {
      assert.equal(source.split(mutation.from).length - 1, 1, `${mutation.id} anchor drift`);
      const mutantFile = path.join(root, `nestjs-mutant-${index}.mjs`);
      fs.writeFileSync(mutantFile, source.replace(mutation.from, mutation.to));
      const mutant = await import(pathToFileURL(mutantFile).href);
      if (mutation.throws) {
        assert.throws(() => summary(mutant.projectNestJsFacts), TypeError, `${mutation.id} survived`);
        continue;
      }
      const observed = summary(mutant.projectNestJsFacts);
      assert.equal(observed[mutation.field], mutation.wanted, `${mutation.id} survived`);
      assert.notDeepEqual(observed, summary(projectNestJsFacts), `${mutation.id} was behaviorally equivalent`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
