import assert from 'node:assert/strict';
import test from 'node:test';
import { buildProtocolContract } from '../../adapters/protocol-next/contracts/protocol.mjs';
import { runFlowCase } from './_target-flow.mjs';
import {
  canonicalSha256, comparableGraphqlView, divergentCategories, lfSha256, loadTarget, multisetDiff,
  projectScan, projectionCategories, readJson, readText, runCase,
} from './_target-helpers.mjs';
import { applyTransforms } from './_target-transforms.mjs';

const FEATURE = Object.freeze({ featureId: 'protocol-target-scope', featureUid: 'uid-protocol-target-scope' });
const sortById = (left, right) => (left.id < right.id ? -1 : 1);

export function mustScan(family, fixture) {
  const outcome = runCase(family, fixture);
  assert.equal(outcome.ok, true, fixture.id + ' must be accepted by the adapter: ' + outcome.error);
  return outcome.scan;
}

export function replayCase(family, fixture) {
  const outcome = runCase(family, fixture);
  if (fixture.expect.outcome === 'error') {
    assert.equal(outcome.ok, false, fixture.id + ' must be rejected by the adapter');
    assert.ok(outcome.error.startsWith(fixture.expect.error_prefix), fixture.id + ' error was: ' + outcome.error);
    return outcome;
  }
  assert.equal(outcome.ok, true, fixture.id + ' must be accepted by the adapter: ' + outcome.error);
  assert.deepEqual(projectScan(family, outcome.scan), fixture.expect.projection, fixture.id + ' projection');
  if (fixture.expect.contract === 'built') {
    assert.doesNotThrow(() => buildProtocolContract({ ...FEATURE, scan: outcome.scan }), fixture.id + ' contract');
  } else {
    assert.equal(fixture.expect.contract, 'throws');
    assert.throws(() => buildProtocolContract({ ...FEATURE, scan: outcome.scan }), (error) => error.message.includes(fixture.expect.contract_error), fixture.id + ' contract error');
  }
  return outcome;
}

export function registerReplayTests(family) {
  const { fixtures } = loadTarget(family);
  const byId = new Map(fixtures.cases.map((fixture) => [fixture.id, fixture]));
  for (const fixture of fixtures.cases) {
    test(family + ' ' + fixture.kind + ' ' + fixture.id + ': ' + fixture.title, () => {
      replayCase(family, fixture);
    });
  }
  for (const group of fixtures.equivalences) {
    test(family + ' equivalence ' + group.id + ' (' + group.kind + ')', () => {
      const [first, ...rest] = group.cases.map((id) => projectScan(family, mustScan(family, byId.get(id))));
      assert.ok(rest.length >= 1);
      for (const view of rest) {
        if (group.kind === 'projection') assert.deepEqual(view, first);
        else for (const category of projectionCategories(family)) assert.deepEqual(view[category], first[category], category);
      }
    });
  }
  for (const group of fixtures.contrasts) {
    test(family + ' contrast ' + group.id, () => {
      const [left, right] = group.cases.map((id) => projectScan(family, mustScan(family, byId.get(id))));
      const differing = projectionCategories(family).filter((key) => JSON.stringify(left[key]) !== JSON.stringify(right[key])).sort();
      assert.deepEqual(differing, [...group.differ_in].sort());
    });
  }
  for (const entry of fixtures.determinism) {
    test(family + ' determinism ' + entry.id, () => {
      const base = byId.get(entry.base_case);
      const baseView = projectScan(family, mustScan(family, base));
      assert.deepEqual(projectScan(family, mustScan(family, base)), baseView, 'two runs on the same input');
      let changed = 0;
      for (const spec of entry.transforms) {
        const text = applyTransforms(base.input.text, spec);
        if (text !== base.input.text) changed += 1;
        const transformed = { ...base, input: { ...base.input, text } };
        assert.deepEqual(projectScan(family, mustScan(family, transformed)), baseView, spec);
      }
      assert.ok(changed >= 1, 'at least one transform changes the bytes');
    });
  }
  for (const flow of fixtures.flow_cases) {
    test(family + ' flow ' + flow.id + ': ' + flow.title, () => {
      assert.deepEqual(runFlowCase(flow, byId), flow.expect);
    });
  }
}

export function registerOracleTests(family) {
  const { scope, fixtures, oracle } = loadTarget(family);
  const byId = new Map(fixtures.cases.map((fixture) => [fixture.id, fixture]));
  const compared = fixtures.cases.filter((fixture) => fixture.oracle?.compare === true);

  test(family + ' oracle evidence is bound to the tool, helpers, compared inputs and vendored locks', () => {
    assert.equal(oracle.schema, 'sbf.protocol-target-oracle-evidence/1');
    assert.equal(oracle.family, family);
    assert.equal(oracle.runtime_tested, false);
    assert.equal(oracle.tool.lf_sha256, lfSha256(readText(oracle.tool.path)));
    assert.equal(oracle.helpers.lf_sha256, lfSha256(readText(oracle.helpers.path)));
    assert.deepEqual([...oracle.fixtures.compared_case_ids].sort(), compared.map((fixture) => fixture.id).sort());
    assert.equal(oracle.fixtures.compared_inputs_sha256, canonicalSha256(compared.map(({ id, input }) => ({ id, input })).sort(sortById)));
    for (const group of oracle.oracle_packages) {
      const lockText = readText(group.lockfile.path);
      assert.equal(group.lockfile.lf_sha256, lfSha256(lockText));
      const lock = JSON.parse(lockText);
      for (const pkg of group.packages) {
        const entry = lock.packages['node_modules/' + pkg.name];
        assert.equal(entry.version, pkg.version, pkg.name + ' version in the vendored lock');
        assert.equal(entry.integrity, pkg.integrity, pkg.name + ' integrity in the vendored lock');
        const pin = scope.pins.libraries.find((library) => library.name === pkg.name && library.version === pkg.version);
        assert.ok(pin, pkg.name + '@' + pkg.version + ' is pinned in SCOPE.json');
        assert.equal(pin.integrity, pkg.integrity);
      }
    }
  });

  test(family + ' stored comparisons are recomputed from the live adapter and the stored oracle results', () => {
    for (const id of oracle.fixtures.compared_case_ids) {
      const fixture = byId.get(id);
      const stored = oracle.results[id];
      assert.ok(stored, id + ' has a stored result');
      const outcome = runCase(family, fixture);
      const verdictValid = stored.oracle.verdict === 'valid';
      let expected;
      if (!outcome.ok) {
        expected = { adapter_verdict: 'error', agrees_on_acceptance: stored.oracle.verdict === 'invalid', divergent_categories: [] };
      } else {
        const adapterVerdict = outcome.scan.completeness.status === 'blocked' ? 'blocked' : 'accepted';
        expected = { adapter_verdict: adapterVerdict, agrees_on_acceptance: (adapterVerdict === 'accepted') === verdictValid, divergent_categories: [] };
        if (adapterVerdict === 'accepted' && family === 'graphql' && stored.oracle.structure) {
          const view = comparableGraphqlView(outcome.scan);
          const categories = projectionCategories('graphql');
          expected.divergent_categories = divergentCategories(view, stored.oracle.structure, categories);
          assert.deepEqual(stored.comparison.diff, Object.fromEntries(expected.divergent_categories.map((category) => [category, multisetDiff(view[category], stored.oracle.structure[category])])), id + ' diff');
        }
        if (adapterVerdict === 'accepted' && family === 'asyncapi' && stored.oracle.counts) {
          const counts = { channels: outcome.scan.asyncapi.channels.length, operations: outcome.scan.asyncapi.operations.length, messages: outcome.scan.asyncapi.messages.length };
          assert.deepEqual(stored.comparison.adapter_counts, counts, id + ' adapter counts');
          if (counts.channels !== stored.oracle.counts.channels) expected.divergent_categories.push('channels');
          if (counts.operations !== stored.oracle.counts.operations) expected.divergent_categories.push('operations');
          if (counts.messages !== stored.oracle.counts.components_messages) expected.divergent_categories.push('messages');
          if (counts.messages !== stored.oracle.counts.all_messages) expected.divergent_categories.push('all_messages');
        }
      }
      assert.equal(stored.comparison.adapter_verdict, expected.adapter_verdict, id + ' adapter verdict');
      assert.equal(stored.comparison.agrees_on_acceptance, expected.agrees_on_acceptance, id + ' agreement on acceptance');
      assert.deepEqual(stored.comparison.divergent_categories, expected.divergent_categories, id + ' divergent categories');
      const diverges = !expected.agrees_on_acceptance || expected.divergent_categories.length > 0;
      const note = fixture.oracle.divergence_note;
      if (diverges) assert.ok(typeof note === 'string' && note.length > 20, id + ' diverges and needs a divergence note');
      else assert.equal(note, undefined, id + ' agrees and must not carry a divergence note');
    }
  });

  test(family + ' oracle summary is recomputed and bound to SCOPE.json', () => {
    const ids = Object.keys(oracle.results).sort();
    assert.deepEqual(ids, [...oracle.fixtures.compared_case_ids].sort());
    const recomputed = {
      compared: ids.length,
      agree_on_acceptance: ids.filter((id) => oracle.results[id].comparison.agrees_on_acceptance).length,
      adapter_accepts_oracle_rejects: ids.filter((id) => oracle.results[id].comparison.adapter_verdict === 'accepted' && oracle.results[id].oracle.verdict === 'invalid').sort(),
      with_divergent_categories: ids.filter((id) => oracle.results[id].comparison.divergent_categories.length > 0).sort(),
    };
    for (const [key, value] of Object.entries(recomputed)) assert.deepEqual(oracle.summary[key], value, key);
    const bound = scope.runtime_oracle.oracle;
    assert.equal(bound.status, 'RUN-static');
    assert.equal(bound.evidence.path, 'test/protocol-next/fixtures/targets/' + family + '.oracle.json');
    assert.equal(bound.evidence.canonical_sha256, canonicalSha256(readJson(bound.evidence.path)));
    assert.equal(bound.evidence.generated_on, oracle.generated_on);
    assert.deepEqual(bound.evidence.tool, oracle.tool);
    assert.deepEqual(bound.evidence.packages, oracle.oracle_packages.flatMap((group) => group.packages.map((pkg) => ({ name: pkg.name, version: pkg.version }))));
    assert.deepEqual(bound.summary, oracle.summary);
  });
}
