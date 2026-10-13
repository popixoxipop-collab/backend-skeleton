#!/usr/bin/env node
// T00-03 mutation check of the lease gate. A mutant is a copy of the gate's source in which one check is taken out by replacing one
// exact piece of text. It runs on the recorded cases of make-lease-report.mjs that guard that check, and it is killed when one of them
// no longer behaves as declared. Before any mutant runs, an unchanged copy has to pass the same cases, and every replaced text has to
// occur exactly once, so a kill cannot come from a broken copy or from a mutation that did not apply. A case on which the copy
// crashes counts as a kill only when the copy still passes the normal cases (a copy that cannot start is not a kill). The report
// cases are the only judge here: a check that no recorded case can see is not listed. Nothing is written to this checkout.
// Exit 0 every mutant killed, 2 a mutant survived or did not apply, or the unchanged copy failed, 1 usage.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CASES, recordCases } from './make-lease-report.mjs';
import { baseModel, writeScaffold } from './make-ownership-report.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const LEDGER = 'lease-ledger.mjs';
const GATE = 'check-lease.mjs';
const PATHS = 'ownership.mjs';
const NORMAL = ['ledger-normal', 'result-normal'];
const m = (id, file, find, replace, cases) => ({ id, file, find, replace, cases });
// m with the condition of the first parenthesis of `find`, an if or else if, replaced by false.
function off(id, file, find, cases) {
  const open = find.indexOf('(');
  let depth = 0;
  let close = open;
  for (let i = open; i < find.length; i += 1) {
    if (find[i] === '(') depth += 1;
    if (find[i] === ')') depth -= 1;
    if (depth === 0) {
      close = i;
      break;
    }
  }
  return m(id, file, find, `${find.slice(0, open)}(false${find.slice(close)}`, cases);
}

export const MUTANTS = [
  // time: the interval is [issued_at, expires_at)
  m('lease-end-inclusive', LEDGER, 'else if (now >= expires) {', 'else if (now > expires) {', ['lease-ends-exactly-now']),
  m('lease-start-exclusive', LEDGER, 'if (now < issued) {', 'if (now <= issued) {', ['lease-starts-exactly-now']),
  m('result-lease-end-inclusive', LEDGER, '!Number.isNaN(expires) && now >= expires', '!Number.isNaN(expires) && now > expires', ['result-at-expiry']),
  m('empty-lease-accepted', LEDGER, 'timed && expires <= issued', 'timed && expires < issued', ['interval-empty']),
  m('reversed-lease-accepted', LEDGER, 'timed && expires <= issued', 'timed && expires === issued', ['interval-reversed']),
  m('instant-not-checked-against-the-calendar', LEDGER, "new Date(ms).toISOString() !== text.replace('Z', '.000Z')", 'false', ['time-nonexistent-date']),
  m('bad-issued-at-accepted', LEDGER, 'if (Number.isNaN(issued)) bad(', 'if (false) bad(', ['time-format']),
  m('bad-expires-at-accepted', LEDGER, 'if (Number.isNaN(expires)) bad(', 'if (false) bad(', ['time-nonexistent-date']),
  m('future-lease-accepted', LEDGER, "if (currency) bad('LEASE_NOT_STARTED'", "if (false) bad('LEASE_NOT_STARTED'", ['lease-not-started']),
  m('expired-active-claim-accepted', LEDGER, "if (currency) bad('LEASE_EXPIRED'", "if (false) bad('LEASE_EXPIRED'", ['lease-expired', 'expired-other-claim']),
  m('result-before-lease-accepted', LEDGER, 'if (!Number.isNaN(issued) && now < issued) bad(', 'if (false) bad(', ['result-before-lease']),
  m('result-after-expiry-accepted', LEDGER, 'if (!Number.isNaN(expires) && now >= expires) bad(', 'if (false) bad(', ['result-after-expiry']),
  m('result-judges-the-lease-of-other-claims', GATE, "currency: command === 'ledger'", 'currency: true', ['result-ignores-expired-other-claim']),

  // scope conflicts and ownership
  m('released-claim-reserves-scope', LEDGER, "claim.state === 'ACTIVE' && timed", 'timed', ['no-conflict-released']),
  m('overlap-not-detected', LEDGER, 'scopesOverlap(a, b)', 'false', ['conflict-same-track', 'conflict-other-track']),
  m('overlap-sees-case-of-the-later-scope', PATHS, 'const py = y.path.toLowerCase();', 'const py = y.path;', ['conflict-case-insensitive']),
  m('overlap-sees-case-of-the-earlier-scope', PATHS, 'const px = x.path.toLowerCase();', 'const px = x.path;', ['conflict-case-insensitive-earlier']),
  m('scope-outside-ownership-accepted', LEDGER, 'scopeWithin(scope, owned)', 'true', ['scope-other-track', 'scope-hot-path']),
  m('owned-file-matched-ignoring-case', LEDGER, 'if (!b.dir) return !a.dir && a.path === b.path;', 'if (!b.dir) return !a.dir && a.path.toLowerCase() === b.path.toLowerCase();', ['scope-file-differs-in-case']),
  m('owned-directory-matched-ignoring-case', LEDGER, '(a.dir && a.path === b.path)', '(a.dir && a.path.toLowerCase() === b.path.toLowerCase())', ['scope-case-differs']),
  m('below-owned-directory-matched-ignoring-case', LEDGER, 'a.path.startsWith(`${b.path}/`)', 'a.path.toLowerCase().startsWith(`${b.path.toLowerCase()}/`)', ['scope-below-owned-differs-in-case']),
  m('repository-not-compared', LEDGER, 'claim.repository !== policy[claim.track].repository', 'false', ['repository-mismatch']),
  m('unknown-track-accepted', LEDGER, 'if (!known) bad(', 'if (!known) (() => {})(', ['unknown-track']),
  m('counter-of-unknown-track-accepted', LEDGER, 'if (!Object.hasOwn(policy, track)) add(', 'if (false) add(', ['counter-unknown-track']),
  m('invalid-scope-ignored', LEDGER, "bad('INVALID_CLAIM_SCOPE', `${JSON.stringify(scope)}: ${e.message}`);", 'void 0;', ['scope-glob', 'scope-backslash']),
  off('empty-scope-list-accepted', LEDGER, 'if (scopes.length === 0) bad(', ['scopes-empty']),

  // claim fields
  m('wrong-schema-family-accepted', LEDGER, "add('LEDGER_SCHEMA', 'ledger', `expected an object with schema ${LEDGER_SCHEMA}, an object counters and an array claims`);\n    return errors;", 'void 0;', ['ledger-schema-wrong']),
  m('non-object-claim-accepted', LEDGER, "add('INVALID_CLAIM', `claims[${index}]`, 'a claim must be an object');", 'void 0;', ['claim-not-object']),
  off('invalid-claim-id-accepted', LEDGER, 'if (!id) bad(', ['claim-id-space']),
  off('duplicate-id-accepted', LEDGER, 'else if (seen.has(id)) bad(', ['duplicate-id']),
  m('worker-may-be-missing', LEDGER, "for (const key of ['worker', 'worktree']) if (!isText(claim[key])) bad(", "for (const key of ['worktree']) if (!isText(claim[key])) bad(", ['worker-missing']),
  m('worktree-may-be-empty', LEDGER, "for (const key of ['worker', 'worktree']) if (!isText(claim[key])) bad(", "for (const key of ['worker']) if (!isText(claim[key])) bad(", ['worktree-empty']),
  off('base-sha-format-not-checked', LEDGER, 'if (!matches(SHA, claim.base_sha)) bad(', ['base-sha-short', 'base-sha-uppercase']),
  off('token-format-not-checked', LEDGER, 'if (!token) bad(', ['token-zero', 'token-string']),
  m('zero-token-accepted', LEDGER, 'Number.isSafeInteger(n) && n > 0;', 'Number.isSafeInteger(n) && n >= 0;', ['token-zero']),
  off('unknown-state-accepted', LEDGER, 'if (!CLAIM_STATES.includes(claim.state)) bad(', ['state-unknown']),

  // fencing tokens and counters
  m('repeated-token-accepted', LEDGER, 'claim.fencing_token <= prev.token', 'claim.fencing_token < prev.token', ['token-regression']),
  off('token-regression-accepted', LEDGER, 'if (prev && claim.fencing_token <= prev.token) bad(', ['token-regression', 'token-reused-by-new-claim']),
  m('counter-not-compared', LEDGER, 'Number.isSafeInteger(counter) && counter >= claim.fencing_token', 'true', ['counter-behind-claim', 'counter-missing']),
  off('negative-counter-accepted', LEDGER, 'if (!Number.isSafeInteger(n) || n < 0) add(', ['counter-negative', 'counter-fraction']),
  m('stale-token-accepted', LEDGER, 'p.fencing_token < counter', 'p.fencing_token < 0', ['result-token-superseded']),
  m('current-token-called-stale', LEDGER, 'p.fencing_token < counter', 'p.fencing_token <= counter', ['result-normal']),
  m('foreign-token-accepted', LEDGER, 'p.fencing_token !== claim.fencing_token', 'false', ['result-token-higher']),

  // the holder, the base and the paths of a result
  m('unknown-claim-accepted', LEDGER, 'if (found.length !== 1) {', 'if (false) {', ['result-unknown-claim']),
  m('released-claim-accepted', LEDGER, "claim.state !== 'ACTIVE'", 'false', ['result-claim-released']),
  m('holder-not-compared', LEDGER, 'p[key] !== claim[key]', 'false', ['result-wrong-worker', 'result-wrong-worktree']),
  m('holder-compared-ignoring-case', LEDGER, 'p[key] !== claim[key]', 'String(p[key]).toLowerCase() !== String(claim[key]).toLowerCase()', ['result-holder-in-other-case']),
  m('other-base-accepted', LEDGER, 'else if (p.base_sha !== claim.base_sha)', 'else if (false)', ['result-base-other']),
  off('result-base-format-not-checked', LEDGER, 'if (!matches(SHA, p.base_sha)) bad(', ['result-base-short']),
  off('result-head-format-not-checked', LEDGER, 'if (!matches(SHA, p.head_sha)) bad(', ['result-head-short']),
  off('empty-result-accepted', LEDGER, 'if (paths.length === 0) add(', ['result-no-paths']),
  m('path-outside-lease-accepted', LEDGER, 'scopes.some((s) => covers(s, rel, false))', 'true', ['result-path-other-track', 'result-path-owned-not-leased']),
  m('path-matched-ignoring-case', LEDGER, 'scopes.some((s) => covers(s, rel, false))', 'scopes.some((s) => covers(s, rel, true))', ['result-path-case']),
  m('sibling-prefix-accepted', PATHS, 's.dir ? target.startsWith(`${base}/`) : target === base', 's.dir ? target.startsWith(base) : target === base', ['result-path-sibling-prefix']),
  m('traversal-accepted', PATHS, "if (parts.includes('..')) throw new Error('path traversal is not allowed');", "if (false) throw new Error('path traversal is not allowed');", ['result-path-traversal']),
  m('backslash-read-as-separator', LEDGER, "normalizePath(raw, { backslash: 'reject' })", 'normalizePath(raw)', ['result-path-backslash']),

  // tamper evidence and versions
  m('edited-claim-accepted', LEDGER, 'entryDigest(claim) !== claim.entry_digest', 'false', ['tamper-claim-edited', 'result-ledger-tampered']),
  m('broken-chain-accepted', LEDGER, 'claim.prev_digest !== tip', 'false', ['tamper-claims-reordered', 'tamper-claim-edited-entry-digest-redone']),
  m('head-not-compared', LEDGER, 'want !== ledger.head_digest', 'false', ['tamper-claim-removed-last', 'tamper-counter-lowered', 'tamper-ledger-emptied']),
  m('pin-not-compared', LEDGER, 'ledger.head_digest !== pin', 'false', ['reseal-rewrite-pinned']),
  m('pin-demanded-when-none-is-given', LEDGER, 'if (pin !== undefined && ledger.head_digest !== pin)', 'if (ledger.head_digest !== pin)', ['ledger-normal']),
  off('missing-prev-digest-accepted', LEDGER, 'if (!prevOk) bad(', ['tamper-prev-digest-missing']),
  off('malformed-entry-digest-accepted', LEDGER, 'if (!entryOk) bad(', ['tamper-entry-digest-malformed']),
  off('unknown-ledger-member-accepted', LEDGER, 'if (!LEDGER_MEMBERS.includes(key)) add(', ['ledger-unknown-member']),
  m('unknown-claim-member-accepted', LEDGER, 'if (!CLAIM_FIELDS.includes(key) && !SEAL_FIELDS.includes(key)) bad(', 'if (false) bad(', ['claim-unknown-member']),
  m('other-version-read-as-a-schema-error', LEDGER, 'ledger.schema.startsWith(SCHEMA_FAMILY) &&', 'false &&', ['ledger-version-2']),
  m('other-version-exits-2', GATE, "'LEDGER_VERSION_UNSUPPORTED') ? 3 : 2", "'LEDGER_VERSION_UNSUPPORTED') ? 2 : 2", ['ledger-version-0', 'result-ledger-version-2']),

  // the command line
  m('unknown-command-accepted', GATE, "if (command !== 'ledger' && command !== 'result') throw", 'if (false) throw', ['usage-unknown-command']),
  m('bad-instant-is-not-a-usage-error', GATE, "if (Number.isNaN(parseInstant(options['--at'])))", 'if (false)', ['usage-bad-at']),
  m('bad-pin-is-not-a-usage-error', GATE, "!DIGEST.test(options['--head-digest'])", 'false', ['usage-bad-head-digest']),
  m('ledger-accepts-paths', GATE, '|| operands.length)', ')', ['usage-ledger-with-paths']),
  m('claim-flag-optional', GATE, 'for (const key of RESULT_FLAGS) if (', "for (const key of RESULT_FLAGS.filter((k) => k !== '--claim')) if (", ['usage-no-claim-flag']),
  m('worker-flag-optional', GATE, 'for (const key of RESULT_FLAGS) if (', "for (const key of RESULT_FLAGS.filter((k) => k !== '--worker')) if (", ['usage-no-worker-flag']),
  m('worktree-flag-optional', GATE, 'for (const key of RESULT_FLAGS) if (', "for (const key of RESULT_FLAGS.filter((k) => k !== '--worktree')) if (", ['usage-no-worktree-flag']),
  m('token-flag-format-not-checked', GATE, "!/^\\d+$/.test(options['--token'])", 'false', ['usage-token-not-number']),
  m('unreadable-ledger-read-as-empty', GATE, 'throw new UnreadableInput(`cannot read the lease ledger ${file}: ${e.code ?? e.message}`);', 'return null;', ['usage-ledger-file-missing', 'usage-ledger-is-a-directory', 'usage-ledger-under-a-file']),
  m('invalid-json-read-as-empty', GATE, 'throw new UnreadableInput(`the lease ledger ${file} is not valid JSON: ${e.message}`);', 'return null;', ['usage-ledger-not-json', 'usage-ledger-empty-file']),
];

// A scaffold checkout holding a copy of next/t00/*.mjs, the one text replaced when there is a mutant. Returns { cli } or { problem }.
function copyOf(root, mutant) {
  writeScaffold(root, baseModel());
  const dir = path.join(root, 'next', 't00');
  fs.mkdirSync(dir, { recursive: true });
  for (const name of fs.readdirSync(here).filter((n) => n.endsWith('.mjs'))) fs.copyFileSync(path.join(here, name), path.join(dir, name));
  if (mutant) {
    const file = path.join(dir, mutant.file);
    let parts;
    try {
      parts = fs.readFileSync(file, 'utf8').split(mutant.find);
    } catch (e) {
      return { problem: `cannot read ${mutant.file}: ${e.code ?? e.message}` };
    }
    if (parts.length !== 2) return { problem: `the text to replace occurs ${parts.length - 1} times in ${mutant.file}, not once` };
    if (mutant.replace === mutant.find) return { problem: 'the replacement equals the text it replaces' };
    fs.writeFileSync(file, parts.join(mutant.replace));
  }
  return { cli: path.join(dir, GATE) };
}

// Runs the named cases one by one against the copy; returns null when all behave as declared, otherwise the first that does not,
// as { id, message, kind } with kind declared (the run differs from the declaration), crash or other.
async function firstDeviation(cli, ids) {
  for (const id of ids) {
    const found = CASES.find((x) => x.id === id);
    if (!found) return { id, message: `${id}: no such recorded case`, kind: 'other' };
    try {
      await recordCases(cli, [found]);
    } catch (e) {
      const message = String(e.message).split('\n')[0];
      const kind = message.startsWith(`${id}: expected exit `) ? 'declared' : message.startsWith(`${id}: the CLI crashed `) ? 'crash' : 'other';
      return { id, message, kind };
    }
  }
  return null;
}

// { control: null | { id, message }, results: [{ id, outcome, by?, detail }] }. outcome is killed, survived, not_applied or
// not_killed_by_a_case (the copy failed some other way than a declared case deviating).
export async function runMutants(mutants = MUTANTS) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't00-mutants-'));
  try {
    const ids = [...new Set([...NORMAL, ...mutants.flatMap((x) => x.cases)])];
    const control = await firstDeviation(copyOf(path.join(root, 'control'), null).cli, ids);
    const results = [];
    for (const mutant of mutants) {
      const copy = copyOf(path.join(root, mutant.id), mutant);
      if (copy.problem) {
        results.push({ id: mutant.id, outcome: 'not_applied', detail: copy.problem });
        continue;
      }
      const hit = await firstDeviation(copy.cli, mutant.cases);
      if (hit === null) results.push({ id: mutant.id, outcome: 'survived', detail: `the cases ${mutant.cases.join(', ')} still behave as declared` });
      else if (hit.kind === 'declared') results.push({ id: mutant.id, outcome: 'killed', by: hit.id, detail: hit.message });
      else if (hit.kind === 'crash' && (await firstDeviation(copy.cli, NORMAL)) === null) {
        results.push({ id: mutant.id, outcome: 'killed', by: hit.id, detail: `${hit.message} (the gate crashed on it and passes the normal cases)` });
      } else results.push({ id: mutant.id, outcome: 'not_killed_by_a_case', detail: hit.message });
    }
    return { control, results };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const CODES = { survived: 'MUTANT_SURVIVED', not_applied: 'MUTATION_NOT_APPLIED', not_killed_by_a_case: 'MUTANT_BROKEN_OTHERWISE' };

export async function runCli(argv) {
  if (argv.length) {
    console.error('usage: node next/t00/lease-mutants.mjs\nruns every mutant of the lease gate on the recorded cases that guard it; exit 0 all killed, 2 otherwise, 1 usage');
    return 1;
  }
  const { control, results } = await runMutants();
  let failed = false;
  if (control) {
    failed = true;
    console.log(`FAIL CONTROL_FAILED unchanged-copy ${control.message}`);
  }
  for (const r of results) {
    if (r.outcome === 'killed') console.log(`killed ${r.id} by ${r.by}`);
    else {
      failed = true;
      console.log(`FAIL ${CODES[r.outcome]} ${r.id} ${r.detail}`);
    }
  }
  if (!failed) console.log(`OK ${results.length} mutants, each killed by a recorded case; an unchanged copy passes the same cases`);
  return failed ? 2 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  process.exitCode = await runCli(process.argv.slice(2));
}
