import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import { TARGET_FAMILIES, canonicalSha256, lfSha256, loadTarget, readJson, readText, repoPath } from './_target-helpers.mjs';

const validate = new Ajv2020({ allErrors: true, strict: true }).compile(readJson('adapters/protocol-next/schemas/protocol-target-scope.schema.json'));
const rootLock = readJson('package-lock.json');
const FIXTURE_ID = /^[a-z][a-z0-9.-]*$/;
const KINDS = new Set(['normal', 'counterexample', 'negative', 'version', 'control']);

const MUTATIONS = {
  'status supported': (scope) => { scope.status = 'supported'; },
  'runtime tested true': (scope) => { scope.runtime_oracle.runtime_tested = true; },
  'runtime not blocked': (scope) => { scope.runtime_oracle.runtime.status = 'RUN'; },
  'scan status complete': (scope) => { scope.profile.scan_status = 'complete'; },
  'no supported list': (scope) => { scope.supported = []; },
  'unsupported without fixtures': (scope) => { scope.unsupported[0].fixtures = []; },
  'unsupported behavior unknown': (scope) => { scope.unsupported[0].behavior = 'maybe'; },
  'extra top-level key': (scope) => { scope.extra = 1; },
  'library version range': (scope) => { scope.pins.libraries[0].version = '^1.0.0'; },
  'library integrity sha1': (scope) => { scope.pins.libraries[0].integrity = 'sha1-abc'; },
  'corpus hash malformed': (scope) => { scope.fixture_corpus.canonical_sha256 = 'abc'; },
  'no claims not made': (scope) => { scope.claims_not_made = []; },
  'missing pin verification': (scope) => { delete scope.pin_verification; },
  'document recomputable offline': (scope) => { if (scope.pins.documents.length === 0) throw new Error('skip'); scope.pins.documents[0].offline_recomputable = true; },
};

for (const family of TARGET_FAMILIES) {
  const { scope, fixtures, readmeText, oracle } = loadTarget(family);
  const allCases = [...fixtures.cases, ...fixtures.flow_cases];
  const byId = new Map(allCases.map((fixture) => [fixture.id, fixture]));
  const claims = [...scope.supported, ...scope.unsupported];

  test(family + ' SCOPE.json validates against the schema and mutations are rejected', () => {
    assert.equal(validate(scope), true, JSON.stringify(validate.errors));
    assert.equal(scope.target.family, family);
    assert.equal(scope.target.id, 'PROTO-' + family + '-01');
    assert.equal(scope.status, 'scope-recorded');
    assert.equal(scope.plan_write_scope.declared, 'adapters/protocol/' + family + '/**');
    assert.equal(fs.existsSync(repoPath('adapters/protocol')), false, 'the declared plan directory does not exist');
    for (const [name, mutate] of Object.entries(MUTATIONS)) {
      const copy = structuredClone(scope);
      try { mutate(copy); } catch (error) { if (error.message === 'skip') continue; throw error; }
      assert.equal(validate(copy), false, 'mutation must be rejected: ' + name);
    }
  });

  test(family + ' fixture corpus is recomputed, not trusted', () => {
    assert.equal(scope.fixture_corpus.path, 'test/protocol-next/fixtures/targets/' + family + '.fixtures.json');
    assert.equal(scope.fixture_corpus.canonical_sha256, canonicalSha256(fixtures));
    assert.equal(scope.fixture_corpus.cases, fixtures.cases.length);
    assert.equal(scope.fixture_corpus.flow_cases, fixtures.flow_cases.length);
    const kinds = {};
    for (const fixture of fixtures.cases) kinds[fixture.kind] = (kinds[fixture.kind] ?? 0) + 1;
    assert.deepEqual(scope.fixture_corpus.kinds, kinds);
    assert.equal(fixtures.schema, 'sbf.protocol-target-fixtures/1');
    assert.equal(fixtures.family, family);
    assert.equal(byId.size, allCases.length, 'fixture ids are unique');
    for (const fixture of fixtures.cases) {
      assert.match(fixture.id, FIXTURE_ID);
      assert.ok(KINDS.has(fixture.kind), fixture.id + ' kind ' + fixture.kind);
      assert.ok(fixture.title.length > 0 && fixture.claim_ids.length > 0, fixture.id + ' title and claims');
      assert.equal(typeof fixture.input.text, 'string');
      assert.ok(['scan', 'error'].includes(fixture.expect.outcome));
      if (fixture.expect.projection) assert.ok(['partial', 'blocked'].includes(fixture.expect.projection.status), fixture.id + ' is never complete');
    }
  });

  test(family + ' mandatory test classes are present', () => {
    for (const kind of ['normal', 'counterexample', 'negative']) assert.ok((scope.fixture_corpus.kinds[kind] ?? 0) >= 1, kind + ' fixtures');
    assert.ok(fixtures.determinism.length >= 1, 'determinism entries');
    assert.ok(scope.pins.libraries.length >= 1 && (scope.pins.documents.length + scope.pins.tags.length) >= 1, 'version pins');
    assert.equal(scope.runtime_oracle.runtime_tested, false);
    assert.equal(scope.runtime_oracle.runtime.status, 'BLOCKED');
    assert.ok(scope.runtime_oracle.runtime.blocked_by.includes('T18-05'));
    if (oracle === null) {
      assert.equal(scope.runtime_oracle.oracle.status, 'BLOCKED');
      assert.ok(scope.runtime_oracle.oracle.reason.length > 40);
    } else {
      assert.equal(scope.runtime_oracle.oracle.status, 'RUN-static');
    }
    assert.ok(scope.claims_not_made.some((item) => item.includes('Runtime-tested')));
  });

  test(family + ' claims, fixtures and case claim ids agree in both directions', () => {
    const claimIds = new Set(claims.map((claim) => claim.id));
    assert.equal(claimIds.size, claims.length, 'claim ids are unique');
    for (const claim of claims) {
      assert.ok(claim.fixtures.length >= 1);
      for (const id of claim.fixtures) assert.ok(byId.has(id), claim.id + ' names unknown fixture ' + id);
      const referencing = allCases.filter((fixture) => fixture.claim_ids.includes(claim.id)).map((fixture) => fixture.id).sort();
      assert.deepEqual([...claim.fixtures].sort(), referencing, claim.id);
    }
    for (const fixture of allCases) for (const id of fixture.claim_ids) assert.ok(claimIds.has(id), fixture.id + ' cites unknown claim ' + id);
    for (const claim of scope.unsupported) {
      assert.ok(claim.fixtures.some((id) => byId.get(id).kind !== 'normal'), claim.id + ' has a non-normal fixture');
    }
  });

  test(family + ' counterexample list covers every counterexample fixture and flow case', () => {
    const listed = new Map(scope.counterexamples.map((entry) => [entry.fixture, entry]));
    assert.equal(listed.size, scope.counterexamples.length);
    const expected = [...fixtures.cases.filter((fixture) => fixture.kind === 'counterexample'), ...fixtures.flow_cases].map((fixture) => fixture.id).sort();
    assert.deepEqual([...listed.keys()].sort(), expected);
    for (const entry of scope.counterexamples) {
      assert.deepEqual([...entry.claim_ids].sort(), [...byId.get(entry.fixture).claim_ids].sort());
      if (entry.control !== null) assert.ok(byId.has(entry.control), entry.fixture + ' control ' + entry.control);
    }
  });

  test(family + ' library pins are recomputed from the root lock or the vendored locks', () => {
    for (const library of scope.pins.libraries) {
      assert.match(library.published, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      if (library.recomputable_from === 'package-lock.json') {
        const entry = rootLock.packages['node_modules/' + library.name];
        assert.equal(entry.version, library.version, library.id);
        assert.equal(entry.integrity, library.integrity, library.id);
      } else if (library.recomputable_from) {
        const entry = readJson(library.recomputable_from).packages['node_modules/' + library.name];
        assert.equal(entry.version, library.version, library.id);
        assert.equal(entry.integrity, library.integrity, library.id);
      } else {
        assert.equal(library.selected, false, library.id + ' is only a candidate');
        assert.ok(library.why_not.length > 20);
      }
    }
    for (const tag of scope.pins.tags) if (!tag.selected) assert.ok(tag.why_not.length > 20, tag.id + ' says why it is not selected');
  });

  test(family + ' pins that need the network are labeled and bound to the verifier run', () => {
    const verification = scope.pin_verification;
    assert.equal(verification.tool, 'test/protocol-next/tools/verify-target-pins.mjs');
    assert.equal(verification.tool_lf_sha256, lfSha256(readText(verification.tool)));
    assert.equal(verification.exit_code, 0);
    assert.ok(verification.checks.every((check) => check.status === 'ok'));
    for (const document of scope.pins.documents) {
      assert.equal(document.offline_recomputable, false);
      assert.equal(document.verify_with, verification.tool);
    }
    const pinIds = [...scope.pins.libraries, ...scope.pins.documents, ...scope.pins.tags, ...scope.pins.absent_tags].map((pin) => pin.id);
    assert.equal(new Set(pinIds).size, pinIds.length, 'pin ids are unique');
    for (const id of pinIds) assert.ok(verification.checks.some((check) => check.pin === id || check.pin.startsWith(id + ' ')), id + ' has a verifier check');
  });

  test(family + ' README states the record, the corpus hash, every claim and pin', () => {
    assert.ok(readmeText.includes('SCOPE.json') && readmeText.includes('scope-recorded'));
    assert.ok(readmeText.includes(scope.fixture_corpus.canonical_sha256));
    assert.ok(readmeText.includes('BLOCKED'));
    for (const claim of claims) assert.ok(readmeText.includes('`' + claim.id + '`'), claim.id);
    for (const library of scope.pins.libraries) assert.ok(readmeText.includes(library.name + ' ' + library.version), library.id);
    for (const tag of scope.pins.tags) assert.ok(readmeText.includes(tag.commit), tag.id);
    for (const document of scope.pins.documents) assert.ok(readmeText.includes(document.sha256), document.id);
    for (const item of scope.claims_not_made) assert.ok(readmeText.includes(item), 'claims not made: ' + item.slice(0, 40));
  });
}
