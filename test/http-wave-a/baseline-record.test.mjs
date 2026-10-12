import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import * as L from './baseline-record-lib.mjs';

// T12-01: every value of adapters/http-wave-a/BASELINE.json that can be recomputed is recomputed here; an unavailable pinned commit FAILS unless BASELINE_ALLOW_UNVERIFIED=1.
// The prose of the record (limit statements, fixture origins, title, dates, verification text) is bound only by artifact_digest: an edit that is re-sealed passes, and the test about re-sealed edits lists what is and is not reported.
const ROOT = L.REPO_ROOT;
const KEYS = ['bytes', 'git_blob_sha1', 'sha256'];
const LIMIT_FIELDS = ['id', 'status', 'fixtures', 'evidence', 'references', 'trees'];
// [id, status, fixture ids, [path, pattern, matches] text evidence, [pattern, paths] references at the pinned commit or null, [path, git tree id] trees]
const LIMIT_TABLE = [
	["framework-version-unknown", "UNKNOWN", [], [["adapters/http-wave-a/flask.mjs", "framework: null", 1], ["adapters/http-wave-a/laravel.mjs", "framework: null", 1], ["adapters/http-wave-a/fastify.mjs", "framework: null", 1], ["adapters/http-wave-a/aspnet-core.mjs", "framework: 'net8\\.0 sample'", 1], ["adapters/http-wave-a/python-flask/SCOPE.json", "3\\.1\\.3", 6]], null, []],
	["leaf-rerun-markers-describe-history", "NOT_RECORDED", ["gin-router-upstream","laravel-routes-upstream","flask-python-scope-static-upstream"], [["adapters/http-wave-a/gin.mjs", "historical-pass-needs-leaf-rerun", 1], ["adapters/http-wave-a/laravel.mjs", "historical-pass-needs-leaf-rerun", 1], ["adapters/http-wave-a/flask.mjs", "historical-pass-needs-leaf-rerun", 1]], null, []],
	["real-repo-comparison-is-a-plain-string", "NOT_RECORDED", [], [["adapters/http-wave-a/aspnet-core.mjs", "realRepoComparison: '", 2], ["adapters/http-wave-a/django-drf.mjs", "realRepoComparison: '", 1], ["adapters/http-wave-a/fastify.mjs", "realRepoComparison: '", 1], ["adapters/http-wave-a/flask.mjs", "realRepoComparison: '", 1], ["adapters/http-wave-a/gin.mjs", "realRepoComparison: '", 1], ["adapters/http-wave-a/laravel.mjs", "realRepoComparison: '", 1], ["adapters/http-wave-a/nestjs.mjs", "realRepoComparison: '", 1]], null, []],
	["aspnet-real-repo-comparison-blocked", "BLOCKED", ["aspnet-minimal-api-upstream","aspnet-controller-upstream"], [["adapters/http-wave-a/aspnet-core.mjs", "BLOCKED_INFRA", 2]], null, []],
	["django-drf-leaf-blocked", "BLOCKED", ["django-blocked-without-shadow","django-blocked-ill-shaped-shadow","django-blocked-with-shadow-hand-fed","django-python-scope-static-upstream"], [["adapters/http-wave-a/django-drf.mjs", "makeRoute|routeOrUnknown", 0]], null, []],
	["fastify-leaf-blocked", "BLOCKED", ["fastify-blocked-without-input","fastify-blocked-with-facts-input"], [["adapters/http-wave-a/fastify.mjs", "makeRoute|routeOrUnknown", 0]], null, []],
	["nestjs-structure-facts-have-no-producer", "BLOCKED", ["nestjs-controller-hand-fed"], [["adapters/http-wave-a/scope/typescript-nestjs.SCOPE.json", "no producer of bskel\\.internal\\.js-ts-structure/0", 2], ["adapters/http-wave-a/nestjs.mjs", "PASS_STATIC_REAL_REPO", 1]], ["js-ts-structure/0", ["adapters/http-legacy-next/scope/verify.mjs"]], []],
	["nestjs-leaf-skips-silently", "UNKNOWN", ["nestjs-undecorated-or-computed-skipped-hand-fed","nestjs-decorator-not-called-hand-fed","nestjs-controller-path-unknown-hand-fed"], [["adapters/http-wave-a/nestjs.mjs", "member\\.kind !== 'method' \\|\\| member\\.computed", 1]], null, []],
	["upstream-layers-drop-some-registrations-silently", "UNKNOWN", ["aspnet-map-ignored-relative-normalised-upstream","gin-any-trace-dynamic-upstream","flask-python-scope-static-upstream"], [], null, []],
	["flask-leaf-ignores-registration-limitations", "UNSUPPORTED", ["flask-registration-with-t06-limitation-hand-fed","flask-registration-without-limitation-hand-fed"], [["adapters/http-wave-a/flask.mjs", "limitations", 0], ["adapters/http-wave-a/flask.mjs", "register_blueprint mount-prefix override composition", 1]], null, []],
	["aspnet-core-leaf-throws-on-hand-fed-wildcard-and-relative-path", "UNSUPPORTED", ["aspnet-any-method-hand-fed-throws","aspnet-relative-path-hand-fed-throws","gin-any-method-hand-fed"], [["adapters/http-wave-a/aspnet-core.mjs", "routeOrUnknown\\(", 0], ["adapters/http-wave-a/aspnet-core.mjs", "makeRoute\\(", 1], ["adapters/http-wave-a/gin.mjs", "routeOrUnknown\\(", 1], ["adapters/http-wave-a/laravel.mjs", "routeOrUnknown\\(", 1], ["adapters/http-wave-a/flask.mjs", "routeOrUnknown\\(", 1]], null, []],
	["operation-id-refused-on-routes-only", "UNSUPPORTED", ["projection-operation-id-on-route-refused","projection-operation-id-on-observation-passes"], [["adapters/http-wave-a/_shared.mjs", "Object\\.hasOwn\\(route, 'operationId'\\)", 1]], null, []],
	["projection-does-not-validate-routes", "UNSUPPORTED", ["projection-keeps-unvalidated-routes-hand-fed"], [], null, []],
	["define-profile-keeps-caller-review-state", "UNSUPPORTED", ["define-profile-claims-forced","define-profile-invalid-state"], [["adapters/http-wave-a/_shared.mjs", "t19Review: profile\\.t19Review \\?\\? 'NOT_REVIEWED'", 1], ["adapters/http-wave-a/_shared.mjs", "Object\\.freeze\\(", 1]], null, []],
	["no-bridge-to-contracts-next-or-the-capability-vocabulary", "UNSUPPORTED", [], [["adapters/http-wave-a/aspnet-core.mjs", "contracts/next|sdk/next|capability-next|schemas/next", 0], ["adapters/http-wave-a/django-drf.mjs", "contracts/next|sdk/next|capability-next|schemas/next", 0], ["adapters/http-wave-a/fastify.mjs", "contracts/next|sdk/next|capability-next|schemas/next", 0], ["adapters/http-wave-a/flask.mjs", "contracts/next|sdk/next|capability-next|schemas/next", 0], ["adapters/http-wave-a/gin.mjs", "contracts/next|sdk/next|capability-next|schemas/next", 0], ["adapters/http-wave-a/laravel.mjs", "contracts/next|sdk/next|capability-next|schemas/next", 0], ["adapters/http-wave-a/nestjs.mjs", "contracts/next|sdk/next|capability-next|schemas/next", 0], ["adapters/http-wave-a/_shared.mjs", "contracts/next|sdk/next|capability-next|schemas/next", 0], ["adapters/http-wave-a/python-scope/static-runner.mjs", "contracts/next|sdk/next|capability-next|schemas/next", 0], ["adapters/http-wave-a/python-scope/verify.mjs", "contracts/next|sdk/next|capability-next|schemas/next", 0]], null, []],
	["leaf-contract-has-no-consumer-outside-the-layer", "UNKNOWN", [], [], ["http-wave-a-leaf", []], []],
	["leaves-are-unregistered-candidates", "UNSUPPORTED", ["aspnet-minimal-api-upstream","gin-router-upstream","laravel-routes-upstream","flask-shadow-hand-fed","nestjs-controller-hand-fed"], [["adapters/http-wave-a/aspnet-core.mjs", "defineProfile\\(", 1], ["adapters/http-wave-a/django-drf.mjs", "defineProfile\\(", 1], ["adapters/http-wave-a/fastify.mjs", "defineProfile\\(", 1], ["adapters/http-wave-a/flask.mjs", "defineProfile\\(", 1], ["adapters/http-wave-a/gin.mjs", "defineProfile\\(", 1], ["adapters/http-wave-a/laravel.mjs", "defineProfile\\(", 1], ["adapters/http-wave-a/nestjs.mjs", "defineProfile\\(", 1], ["adapters/http-wave-a/_shared.mjs", "registration: 'unregistered'", 2]], null, []],
	["external-program-versions-are-those-of-the-generating-machine", "UNKNOWN", ["flask-python-scope-static-upstream","django-python-scope-static-upstream"], [], null, []],
	["scope-directory-names-are-walked", "UNKNOWN", [], [["adapters/http-wave-a/python-scope/verify.mjs", "adapter-appeared", 1], ["scanners/registry.mjs", "readdirSync", 3]], null, [["adapters", "52d259e7c98983b512c9f527d0dae96bc015068d"], ["scanners", "2fe7a407631dd4b30d4ed706a29bf70197c4031a"], ["scanners/adapters", "fc4e6dd52d7ea879e4b33d44d0f29cb1231380cd"]]],
	["interface-rfc-prose-is-not-compared", "NOT_RECORDED", [], [], null, []]
];
const record = L.readRecord();
const commit = record.base_commit;
const tree = L.classifyLive(record);
const verdict = L.commitVerdict(ROOT, commit);
const computed = await L.replay(record, ROOT);
const live = await L.liveProfileRows(record, ROOT);
const read = L.liveReader(ROOT);
const paths = (...roles) => record.files.filter((f) => roles.includes(f.role)).map((f) => f.path);
const env = (value) => ({ BASELINE_ALLOW_UNVERIFIED: value });
const damage = (e, key) => ({ ...e, [key]: key === 'bytes' ? e.bytes + 1 : L.flip(e[key]) });
const tampered = (mutate, base = record) => { const r = structuredClone(base); mutate(r); return r; };
const mentions = (list, text) => assert.ok(list.some((p) => p.includes(text)), `no problem mentions "${text}": ${list.join(' | ')}`);
const shallowCopy = () => L.depthOneCase(L.tmpDir('t12-depth1-'));
const limitOf = (r, id) => r.limits.find((l) => l.id === id);
const fixtureOf = (r, id) => r.fixtures.find((f) => f.id === id);
const profileOf = (r, id) => r.profiles.find((p) => p.id === id);
const outputOf = (id) => computed[record.fixtures.findIndex((f) => f.id === id)].output;

const tableOf = (r) => r.limits.map((l) => [l.id, l.status, l.fixtures ?? [], (l.evidence ?? []).map((e) => [e.path, e.pattern, e.matches]), l.references ? [l.references.pattern, l.references.paths] : null, (l.trees ?? []).map((t) => [t.path, t.git_tree_id])]);
function limitProblems(r) {
	const rows = tableOf(r);
	const problems = rows.length === LIMIT_TABLE.length ? [] : [`limits: the record has ${rows.length} limits, the table lists ${LIMIT_TABLE.length}`];
	LIMIT_TABLE.forEach((want, i) => {
		for (const [j, name] of LIMIT_FIELDS.entries()) if (rows[i] && L.canonical(rows[i][j]) !== L.canonical(want[j])) problems.push(`limit ${want[0]}: ${name} differs from the table`);
	});
	return problems;
}
const referenceProblems = (r) => r.limits.filter((l) => l.references).flatMap((l) => {
	const got = L.referencesAtCommit(ROOT, commit, l.references.pattern, [r.source_dir, r.test_dir]);
	return JSON.stringify(got) === JSON.stringify(l.references.paths) ? [] : [`limit ${l.id}: references are ${JSON.stringify(got)} at the pinned commit, recorded ${JSON.stringify(l.references.paths)}`];
});

test('the record is well formed and consistent with itself, and the blocked leaves and unknown framework versions stay as recorded', () => {
	assert.deepEqual(L.verifyRecord(record), []);
	assert.deepEqual([...new Set(record.fixtures.map((f) => f.class))].sort(), ['negative', 'normal']);
	assert.deepEqual(['django-drf-leaf-blocked', 'fastify-leaf-blocked'].map((id) => limitOf(record, id)?.status), ['BLOCKED', 'BLOCKED']);
	assert.deepEqual(record.profiles.filter((p) => p.state !== 'candidate').map((p) => `${p.id}:${p.state}`).sort(), ['node-fastify:blocked-upstream-fact-gap', 'python-django:blocked-upstream-fact-gap']);
	assert.deepEqual(record.profiles.filter((p) => p.framework_version.status === 'UNKNOWN').map((p) => p.id).sort(), ['node-fastify', 'php-laravel', 'python-flask']);
	assert.deepEqual(record.profiles.filter((p) => p.real_repo_comparison.kind === 'history-needs-leaf-rerun').map((p) => p.id).sort(), ['go-gin', 'php-laravel', 'python-flask']);
});

test('live: pinned files, profile rows, replayed fixtures and text evidence equal the record (damage fails, drift skips)', (t) => {
	if (!L.requireFresh(t, tree)) return;
	assert.deepEqual(L.verifyRecord(record, { read, label: 'live' }), []);
	assert.deepEqual(L.profileProblems(record, ROOT, live), []);
	assert.deepEqual(L.replayProblems(record, computed), []);
	assert.deepEqual(L.outputProblems(record, computed), []);
	assert.deepEqual(L.evidenceProblems(record, read), []);
});

test('commit: the base commit holds exactly the recorded tree, blobs and track files, and the limits equal what it says', (t) => {
	if (!L.needCommit(t, verdict)) return;
	assert.equal(L.treeAtCommit(ROOT, commit), record.base_tree);
	assert.deepEqual(L.verifyRecord(record, { read: L.commitReader(ROOT, commit), includeRunner: true, label: 'commit' }), []);
	for (const f of record.files) assert.equal(L.blobAtCommit(ROOT, commit, f.path), f.git_blob_sha1, f.path);
	const here = [...L.listAtCommit(ROOT, commit, record.source_dir).filter((p) => !p.endsWith('.md')), ...L.listAtCommit(ROOT, commit, record.test_dir)];
	assert.deepEqual(here.sort(), paths('source', 'test', 'test_support').sort());
	assert.deepEqual(L.evidenceProblems(record, L.commitReader(ROOT, commit)), []);
	assert.deepEqual(referenceProblems(record), []);
	assert.deepEqual(L.treeIdProblems(record, ROOT, commit), []);
});

test('commit: the base commit is an ancestor of HEAD (a shallow checkout is deepened first)', (t) => {
	if (!L.needCommit(t, verdict) || !L.needCommit(t, L.ancestryVerdict(ROOT, commit))) return;
	assert.ok(L.isAncestor(ROOT, commit));
});

test('commands: both recorded commands, the per-file counts, every profile row and every fixture reproduce at the base commit', async (t) => {
	if (!L.needCommit(t, verdict)) return;
	const dir = L.tmpDir('t12-baseline-');
	L.extractCommit(ROOT, commit, record.files.map((f) => f.path), dir);
	assert.deepEqual(L.linkModules(ROOT, dir, record.files.map((f) => f.path)), record.environment.loaded_packages);
	const [direct, nested] = ['direct-tap', 'nested-runner'].map((id) => record.commands.find((c) => c.id === id));
	const tap = L.runTapTests(dir, paths('test'));
	assert.deepEqual([direct.command, direct.exit_code, direct.result], [L.tapCommand(paths('test')), tap.exit_code, tap.result]);
	const run = L.runNestedRunner(dir, record.suite_id);
	assert.deepEqual([nested.exit_code, nested.first_line, nested.result], [run.exit_code, run.first_line, run.result]);
	for (const f of record.files.filter((e) => e.role === 'test')) assert.equal(L.runTapTests(dir, [f.path]).result.tests, f.test_count, f.path);
	const again = await L.replay(record, dir);
	assert.deepEqual(L.replayProblems(record, again), []);
	assert.deepEqual(L.outputProblems(record, again), []);
	assert.deepEqual(L.profileProblems(record, dir, await L.liveProfileRows(record, dir)), []);
});

test('limits: the id, status, fixtures and recomputation channels of every limit equal the table in this file', () => {
	assert.deepEqual(limitProblems(record), []);
	assert.equal(new Set(LIMIT_TABLE.map(([id]) => id)).size, LIMIT_TABLE.length);
	assert.ok(LIMIT_TABLE.every(([, status]) => L.LIMIT_STATUSES.includes(status)));
	const swapped = tampered((r) => { [r.limits[0], r.limits[1]] = [r.limits[1], r.limits[0]]; });
	const changes = [
		[(r) => { limitOf(r, 'django-drf-leaf-blocked').status = 'UNKNOWN'; }, 'limit django-drf-leaf-blocked: status differs'],
		[(r) => { r.limits.pop(); }, 'limits: the record has'],
		[(r) => { r.limits.push({ id: 'appended-limit', status: 'UNKNOWN', statement: 'appended', fixtures: [] }); }, 'limits: the record has'],
		[(r) => { limitOf(r, 'fastify-leaf-blocked').fixtures.pop(); }, 'limit fastify-leaf-blocked: fixtures differs'],
		[(r) => { limitOf(r, 'framework-version-unknown').evidence[0].pattern += 'x'; }, 'limit framework-version-unknown: evidence differs'],
		[(r) => { limitOf(r, 'framework-version-unknown').evidence[0].matches += 1; }, 'limit framework-version-unknown: evidence differs'],
		[(r) => { limitOf(r, 'nestjs-structure-facts-have-no-producer').references.paths = []; }, 'references differs'],
		[(r) => { limitOf(r, 'scope-directory-names-are-walked').trees[0].git_tree_id = L.flip(limitOf(r, 'scope-directory-names-are-walked').trees[0].git_tree_id); }, 'trees differs']
	];
	for (const [edit, text] of changes) mentions(limitProblems(tampered(edit)), text);
	mentions(limitProblems(swapped), 'id differs from the table');
});

test('profiles: each row equals the live export, every leaf module has a row, and an unknown framework version or a historical marker is never filled in or upgraded', async () => {
	assert.deepEqual(L.profileProblems(record, ROOT, live), []);
	assert.deepEqual(L.leafModules(ROOT), record.profiles.map((p) => p.module).sort());
	for (const id of ['python-flask', 'php-laravel', 'node-fastify']) assert.deepEqual([profileOf(record, id).version_pin.framework, profileOf(record, id).framework_version], [null, { status: 'UNKNOWN', value: null }], id);
	for (const id of ['go-gin', 'php-laravel', 'python-flask']) {
		assert.deepEqual([profileOf(record, id).real_repo_comparison.marker, profileOf(record, id).real_repo_comparison.kind], ['historical-pass-needs-leaf-rerun', 'history-needs-leaf-rerun'], id);
		assert.ok(record.fixtures.some((f) => f.profile === id && f.input_kind === 'upstream-real'), `${id} is re-run on input from the in-repo upstream analyzer`);
	}
	mentions(L.verifyRecord(tampered((r) => { profileOf(r, 'python-flask').framework_version = { status: 'DECLARED', value: '3.1.3' }; })), 'framework_version must be UNKNOWN');
	mentions(L.verifyRecord(tampered((r) => { profileOf(r, 'go-gin').real_repo_comparison.kind = 'history-does-not-certify'; })), 'does not follow from the marker');
	mentions(L.verifyRecord(tampered((r) => { profileOf(r, 'go-gin').real_repo_comparison.marker += ' (reworded)'; })), 'does not follow from the marker');
	mentions(L.verifyRecord(tampered((r) => { r.fixtures = r.fixtures.filter((f) => !(f.profile === 'go-gin' && f.input_kind === 'upstream-real')); })), 'needs an upstream-real fixture');
	mentions(L.profileProblems(tampered((r) => { profileOf(r, 'go-gin').title += ' (edited)'; }), ROOT, live), 'the row differs from the live profile (title)');
	mentions(L.profileProblems(tampered((r) => { r.profiles.splice(0, 1); }), ROOT, live.slice(1)), 'has no profile row');
	const broken = tampered((r) => { r.profiles[0].export = 'MISSING_PROFILE'; r.profiles[1].module = `${r.source_dir}/not-there.mjs`; });
	const rows = await L.liveProfileRows(broken, ROOT);
	mentions(L.profileProblems(broken, ROOT, rows), 'has no export MISSING_PROFILE');
	mentions(L.profileProblems(broken, ROOT, rows), 'not-there.mjs cannot be imported');
});

test('fixtures: unknown and unsupported cases never become routes, the three ROUTE codes and the blocked refusals are shown by the replayed outputs', () => {
	const codeOf = (id) => outputOf(id).unknown?.code;
	assert.deepEqual(['route-method-any-lowercase', 'route-wildcard-wins-over-path'].map(codeOf), ['ROUTE_METHOD_WILDCARD_UNRESOLVED', 'ROUTE_METHOD_WILDCARD_UNRESOLVED']);
	assert.deepEqual(['route-method-trace-unsupported', 'route-method-null-unsupported'].map(codeOf), ['ROUTE_METHOD_UNSUPPORTED', 'ROUTE_METHOD_UNSUPPORTED']);
	assert.deepEqual(['route-path-relative-unknown', 'route-path-missing-unknown'].map(codeOf), ['ROUTE_PATH_UNKNOWN', 'ROUTE_PATH_UNKNOWN']);
	for (const id of ['route-method-any-lowercase', 'route-wildcard-wins-over-path', 'route-method-trace-unsupported', 'route-method-null-unsupported', 'route-path-relative-unknown', 'route-path-missing-unknown']) assert.equal(outputOf(id).route, undefined, `${id} yields no route`);
	assert.equal(outputOf('route-lowercase-method-is-upcased').route.method, 'GET');
	for (const id of ['gin-any-trace-dynamic-upstream', 'laravel-any-dynamic-upstream']) assert.ok(outputOf(id).unknowns.some((u) => u.code === 'ROUTE_METHOD_WILDCARD_UNRESOLVED'), id);
	const refusals = { 'fastify-blocked-without-input': 'FASTIFY_UPSTREAM_RECEIVER_FACT_MISSING', 'fastify-blocked-with-facts-input': 'FASTIFY_UPSTREAM_RECEIVER_FACT_MISSING', 'django-blocked-without-shadow': 'DJANGO_DRF_UPSTREAM_FACTS_MISSING', 'django-blocked-ill-shaped-shadow': 'DJANGO_DRF_UPSTREAM_FACTS_MISSING' };
	for (const [id, code] of Object.entries(refusals)) assert.deepEqual([outputOf(id).status, outputOf(id).routes, outputOf(id).unknowns.map((u) => u.code)], ['blocked', [], [code]], id);
	const drf = outputOf('django-blocked-with-shadow-hand-fed');
	assert.deepEqual([drf.status, drf.routes], ['blocked', []]);
	assert.ok(drf.unknowns.some((u) => u.code === 'DRF_ACTION_METHOD_FACT_MISSING'));
	for (const p of record.profiles.filter((x) => x.state !== 'candidate')) assert.ok(record.fixtures.every((f) => f.profile !== p.id || f.class === 'negative'), p.id);
});

test('negative: a damaged leaf output is reported by the invariants (registered, default, supported, wildcard method, relative path, operationId, blocked route, throw rules)', () => {
	const at = (id) => record.fixtures.findIndex((f) => f.id === id);
	const [sample, blocked, refusal] = ['aspnet-minimal-api-upstream', 'fastify-blocked-without-input', 'flask-ill-shaped-throws'].map(at);
	assert.ok(computed[sample].output.routes.length > 0 && Array.isArray(computed[sample].output.unknowns));
	const damaged = (index, mutate) => { const c = structuredClone(computed); mutate(c[index].output, c); return L.outputProblems(record, c); };
	mentions(damaged(sample, (o) => { o.registration = 'registered'; }), 'registration must be unregistered');
	mentions(damaged(sample, (o) => { o.productionDefault = true; }), 'productionDefault false');
	mentions(damaged(sample, (o) => { o.status = 'supported'; }), 'is not candidate or blocked');
	mentions(damaged(sample, (o) => { o.status = 'blocked'; }), 'does not follow the state candidate');
	mentions(damaged(sample, (o) => { o.routes[0].method = 'ANY'; }), 'is not one of the explicit methods');
	mentions(damaged(sample, (o) => { o.routes[0].method = 'get'; }), 'is not one of the explicit methods');
	mentions(damaged(sample, (o) => { o.routes[0].path = 'relative'; }), 'is not an absolute path');
	mentions(damaged(sample, (o) => { o.routes[0].provenance = ''; }), 'provenance is missing');
	mentions(damaged(sample, (o) => { o.routes[0].operationId = 'op'; }), 'carries an operationId');
	mentions(damaged(sample, (o) => { o.unknowns.push({ reason: 'no code' }); }), 'code is missing');
	mentions(damaged(sample, (o) => { o.evidence = { supported: true }; }), 'a key named supported');
	mentions(damaged(sample, (o) => { o.observations = [{ capabilities: [] }]; }), 'a key named capabilities');
	mentions(damaged(blocked, (o) => { o.routes.push({ method: 'GET', path: '/x', provenance: 'p' }); }), 'a blocked output must have no route');
	mentions(damaged(blocked, (o) => { o.status = 'candidate'; }), 'does not follow the state blocked-upstream-fact-gap');
	mentions(damaged(sample, (o, c) => { c[sample].output = { threw: { name: 'TypeError', message: 'refused' } }; }), 'a normal fixture must not throw');
	mentions(damaged(refusal, (o, c) => { c[refusal].output = { threw: { name: 'RangeError', message: 'other' } }; }), 'a refusal must be a TypeError');
});

// What a re-sealed edit of the record does: the first group is reported by the named recomputation, the second group passes every check of this file. The second group is the list of surviving edits, which the record states as not_recomputed.
const CAUGHT = [
	['a limit status replaced by another valid status', (r) => { limitOf(r, 'django-drf-leaf-blocked').status = 'UNKNOWN'; }, 'limit django-drf-leaf-blocked: status differs'],
	['a limit removed', (r) => { r.limits.splice(2, 1); }, 'limits: the record has'],
	['a limit appended', (r) => { r.limits.push({ id: 'appended-limit', status: 'UNKNOWN', statement: 'appended', fixtures: [] }); }, 'limits: the record has'],
	['a fixture id removed from a limit', (r) => { limitOf(r, 'fastify-leaf-blocked').fixtures.pop(); }, 'limit fastify-leaf-blocked: fixtures differs'],
	['an evidence pattern replaced', (r) => { limitOf(r, 'framework-version-unknown').evidence[0].pattern = 'framework: undefined'; }, 'limit framework-version-unknown: evidence differs'],
	['an evidence count replaced', (r) => { limitOf(r, 'framework-version-unknown').evidence[0].matches = 2; }, 'has 1 matches'],
	['a tree id replaced', (r) => { limitOf(r, 'scope-directory-names-are-walked').trees[0].git_tree_id = L.flip(limitOf(r, 'scope-directory-names-are-walked').trees[0].git_tree_id); }, 'limit scope-directory-names-are-walked: trees differs'],
	['an expected value replaced', (r) => { fixtureOf(r, 'gin-router-upstream').expect[0][1] = 'edited'; }, 'gin-router-upstream: '],
	['a false expectation appended', (r) => { fixtureOf(r, 'gin-router-upstream').expect.push(['/status', 'edited']); }, 'gin-router-upstream: /status'],
	['an output hash replaced', (r) => { r.fixtures[0].output_sha256 = L.flip(r.fixtures[0].output_sha256); }, `${record.fixtures[0].id}: output sha256`],
	['a profile title appended to', (r) => { profileOf(r, 'go-gin').title += ' (edited)'; }, 'the row differs from the live profile (title)'],
	['a profile title replaced', (r) => { profileOf(r, 'go-gin').title = 'edited'; }, 'the row differs from the live profile (title)'],
	['a framework version filled in', (r) => { profileOf(r, 'python-flask').framework_version = { status: 'DECLARED', value: '3.1.3' }; }, 'framework_version must be UNKNOWN'],
	['a command count replaced', (r) => { r.commands[0].result.tests -= 1; }, 'direct-tap tests'],
	['a pinned digest replaced', (r) => { r.files[0].sha256 = L.flip(r.files[0].sha256); }, 'sha256'],
	['a per-file test count replaced', (r) => { r.files.find((f) => f.role === 'test').test_count += 1; }, 'sum of per-file test_count'],
	['the class of a blocked profile fixture replaced', (r) => { fixtureOf(r, 'fastify-blocked-without-input').class = 'normal'; }, 'a blocked profile is shown by negative fixtures only']
];
const SURVIVES = [
	['a limit statement replaced', (r) => { limitOf(r, 'django-drf-leaf-blocked').statement = 'The Django leaf is supported.'; }],
	['a limit statement appended to', (r) => { limitOf(r, 'django-drf-leaf-blocked').statement += ' It is supported.'; }],
	['a fixture origin replaced', (r) => { r.fixtures[0].origin = 'edited'; }],
	['a fixture origin appended to', (r) => { r.fixtures[0].origin += ' (edited)'; }],
	['the title replaced', (r) => { r.title = 'edited'; }],
	['the title appended to', (r) => { r.title += ' (edited)'; }],
	['the date replaced', (r) => { r.observed_on = '2001-01-01'; }],
	['the recomputed text replaced', (r) => { r.verification.recomputed = 'everything'; }],
	['a level appended to', (r) => { r.verification.levels[0] += ' (edited)'; }],
	['a not_recomputed entry appended', (r) => { r.verification.not_recomputed.push('nothing'); }],
	['an external program version replaced', (r) => { r.environment.external_programs.python3 = '2.7.18'; }],
	['a CI observation replaced', (r) => { r.ci_observations[0].conclusion = 'failure'; }],
	['a true expectation appended', (r) => { fixtureOf(r, 'gin-router-upstream').expect.push(['/status', 'candidate']); }],
	['the class of a fixture without a profile replaced', (r) => { fixtureOf(r, 'route-lowercase-method-is-upcased').class = 'negative'; }]
];

test('negative: a re-sealed edit is reported by the named recomputation or survives, and an edit that is not re-sealed is always reported through artifact_digest', (t) => {
	if (!L.requireFresh(t, tree)) return;
	// The outputs are those replayed from the unedited record; an edit of a call is replayed in its own test, an edit of an expectation is read from the stored output.
	const rebuilt = (r) => r.fixtures.map((f, i) => ({ ...computed[i], observed: f.expect.map(([pointer]) => L.pointerGet(computed[i].output, pointer)) }));
	const battery = (r) => [...L.verifyRecord(r, { read, label: 'live' }), ...limitProblems(r), ...L.replayProblems(r, rebuilt(r)), ...L.outputProblems(r, rebuilt(r)), ...L.profileProblems(r, ROOT, live), ...L.evidenceProblems(r, read)];
	assert.deepEqual(battery(record), []);
	for (const [label, edit, text] of CAUGHT) {
		const sealed = L.sealRecord(tampered(edit));
		assert.ok(!L.verifyRecord(sealed).some((p) => p.includes('artifact_digest')), `${label}: re-sealed`);
		mentions(battery(sealed), text);
		mentions(L.verifyRecord(tampered(edit)), 'artifact_digest');
	}
	for (const [label, edit] of SURVIVES) {
		assert.deepEqual(battery(L.sealRecord(tampered(edit))), [], `${label}: a re-sealed edit passes every check of this file`);
		mentions(L.verifyRecord(tampered(edit)), 'artifact_digest');
	}
});

test('negative: a changed call or a call that cannot be set up is reported by the replay, never trusted', async () => {
	const [a, b] = ['route-method-trace-unsupported', 'route-path-relative-unknown'].map((id) => fixtureOf(record, id));
	assert.notDeepEqual(a.call, b.call);
	assert.notEqual(a.output_sha256, b.output_sha256);
	const swapped = { fixtures: [{ ...a, call: b.call }, { ...b, call: a.call }], equal_outputs: [] };
	const problems = L.replayProblems(swapped, await L.replay(swapped, ROOT));
	mentions(problems, `${a.id}: output sha256`);
	mentions(problems, `${b.id}: output sha256`);
	const unset = { fixtures: [{ ...a, call: { ...a.call, fn: 'noSuchFunction' } }, { ...b, call: { ...b.call, module: `${record.source_dir}/not-there.mjs` } }], equal_outputs: [] };
	const unsetProblems = L.replayProblems(unset, await L.replay(unset, ROOT));
	mentions(unsetProblems, 'has no function noSuchFunction');
	mentions(unsetProblems, 'cannot load');
});

test('negative: a tampered output hash, expected value, test count, exit code, limit status, commit id or issue and pull request number is reported', () => {
	const [first] = record.fixtures;
	const hash = tampered((r) => { r.fixtures[0].output_sha256 = L.flip(first.output_sha256); });
	mentions(L.replayProblems(hash, computed), `${first.id}: output sha256`);
	mentions(L.verifyRecord(hash), 'artifact_digest');
	mentions(L.replayProblems(tampered((r) => { r.fixtures[0].expect[0][1] = 'tampered'; }), computed), `${first.id}: ${first.expect[0][0]}`);
	mentions(L.verifyRecord(tampered((r) => { r.files.find((f) => f.role === 'test').test_count += 1; })), 'sum of per-file test_count');
	mentions(L.verifyRecord(tampered((r) => { r.commands[0].exit_code = '0'; })), 'exit_code must be an integer');
	mentions(L.verifyRecord(tampered((r) => { r.commands[0].result.fail = 1; })), 'contradicts failing tests');
	mentions(L.verifyRecord(tampered((r) => { r.base_commit = r.base_commit.slice(1); })), 'base_commit');
	mentions(L.verifyRecord(tampered((r) => { r.limits.find((l) => l.references).references.pattern = ''; })), 'references needs');
	for (const status of ['SUPPORTED', 'supported', 'PASS', '']) mentions(L.verifyRecord(tampered((r) => { r.limits[0].status = status; })), `status ${status} is not one of`);
	const numbered = [['#', 12], ['PR ', 12], ['/pull/', 12], ['/issues/', 12], ['GH-', 12]].map(([head, n]) => `${head}${n}`).concat([['refs', 'pull'].join('/')]);
	for (const text of numbered) mentions(L.verifyRecord(tampered((r) => { r.limits[0].statement += ` see ${text}`; })), 'no pull request or issue number');
});

test('negative: damage in one hash or in the size alone is reported, a changed or missing file is not fresh', () => {
	const buf = Buffer.from('export const pinned = 1;\n');
	const entry = { role: 'source', path: `${record.source_dir}/x.mjs`, ...L.digestsOf(buf) };
	for (const [content, state] of [[buf, 'fresh'], [Buffer.from('export const pinned = 2;\n'), 'drift'], [null, 'missing']]) assert.equal(L.classifyEntry(entry, content).state, state);
	for (const key of KEYS) assert.equal(L.classifyEntry(damage(entry, key), buf).state, 'corrupt', key);
	for (const key of KEYS) mentions(L.recomputeProblems([damage(entry, key)], () => buf, 'x'), `${key} `);
	mentions(L.recomputeProblems([entry], () => null, 'x'), 'cannot read');
});

test('negative: an unrecorded file or a changed file moves the tree away from the baseline, markdown and the files this item adds do not', (t) => {
	if (!L.needCommit(t, verdict)) return;
	const dir = L.tmpDir('t12-moved-');
	L.extractCommit(ROOT, commit, record.files.map((f) => f.path), dir);
	assert.equal(L.classifyLive(record, dir).fresh, true);
	fs.writeFileSync(path.join(dir, record.source_dir, 'INTERFACE_RFC.md'), 'text\n');
	for (const own of [L.TRACK.recordFile, ...L.TRACK.ownFiles]) {
		fs.mkdirSync(path.dirname(path.join(dir, own)), { recursive: true });
		fs.writeFileSync(path.join(dir, own), '{}\n');
	}
	assert.equal(L.classifyLive(record, dir).fresh, true);
	fs.writeFileSync(path.join(dir, record.test_dir, 'unlisted.json'), '{}\n');
	fs.writeFileSync(path.join(dir, record.source_dir, 'extra.mjs'), 'export {};\n');
	assert.deepEqual(L.classifyLive(record, dir).moved, [`${record.source_dir}/extra.mjs`, `${record.test_dir}/unlisted.json`]);
	fs.appendFileSync(path.join(dir, paths('source')[0]), '\n');
	assert.ok(L.classifyLive(record, dir).moved.includes(paths('source')[0]));
});

test('negative: an installed version that differs from the pinned package-lock.json, a missing package and an import the lock lacks fail, comment lines and fixture scripts are not scanned, and the copy is then not linked', () => {
	const dir = L.tmpDir('t12-lock-');
	const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
	const lock = { lockfileVersion: 3, packages: { '': {}, 'node_modules/alpha': { version: '1.0.0', dependencies: { beta: '^2.0.0' } }, 'node_modules/beta': { version: '2.1.0' }, 'node_modules/@scope/gamma': { version: '3.0.0' }, 'node_modules/unused': { version: '9.9.9' } } };
	const source = "import alpha from 'alpha/lib/x.js';\nimport fs from 'node:fs';\nimport './local.mjs';\nconst lazy = () => import('@scope/gamma');\n// values come from 'not-an-import'\n// const hidden = require('commented-out');\n/* import 'block-commented'; */\n * require('star-commented');\n";
	const installed = { alpha: '1.0.0', beta: '2.1.0', '@scope/gamma': '3.0.0' };
	const checkout = (name, versions) => { for (const [pkg, version] of Object.entries(versions)) write(`${name}/node_modules/${pkg}/package.json`, JSON.stringify({ name: pkg, version })); return path.join(dir, name); };
	const copy = (name, text = source) => { write(`${name}/main.mjs`, text); write(`${name}/package-lock.json`, JSON.stringify(lock)); return path.join(dir, name); };
	const link = (root, dest, files = ['main.mjs', 'package-lock.json']) => L.linkModules(root, dest, files);
	const aligned = copy('copy-aligned');
	write('copy-aligned/fixtures/data.js', "const data = require('fixture-only');\nimport 'also-fixture-only';\n");
	assert.deepEqual(link(checkout('aligned', installed), aligned, ['main.mjs', 'package-lock.json', 'fixtures/data.js']), { '@scope/gamma': '3.0.0', alpha: '1.0.0', beta: '2.1.0' });
	assert.ok(fs.lstatSync(path.join(aligned, 'node_modules')).isSymbolicLink());
	assert.deepEqual(L.importedPackages(source), ['@scope/gamma', 'alpha']);
	const refused = (name, root, pattern, text) => {
		const dest = copy(name, text);
		assert.throws(() => link(root, dest), pattern);
		assert.equal(fs.existsSync(path.join(dest, 'node_modules')), false, `${name} must not be linked`);
	};
	refused('copy-newer', checkout('newer', { ...installed, beta: '2.1.1' }), /beta: installed 2\.1\.1, the pinned package-lock\.json states 2\.1\.0/);
	refused('copy-missing', checkout('missing', { alpha: '1.0.0', '@scope/gamma': '3.0.0' }), /beta: node_modules\/beta\/package\.json cannot be read/);
	refused('copy-extra', checkout('extra', installed), /delta \(required by main\.mjs\) has no node_modules\/delta entry/, `${source}import 'delta';\n`);
	refused('copy-inline', checkout('inline', installed), /epsilon \(required by main\.mjs\) has no node_modules\/epsilon entry/, `${source}const x = 1; require('epsilon');\n`);
});

test('negative: a changed match count, reference list or tree id of a limit is reported', (t) => {
	mentions(L.evidenceProblems(tampered((r) => { r.limits[0].evidence[0].matches += 1; }), read), 'recorded');
	mentions(L.evidenceProblems(tampered((r) => { r.limits[0].evidence[0].path = `${r.source_dir}/missing.mjs`; }), read), 'cannot read');
	mentions(L.evidenceProblems(tampered((r) => { r.limits[0].evidence[0].pattern = 'framework: undefined'; }), read), 'has 0 matches');
	if (!L.needCommit(t, verdict)) return;
	const consumer = 'leaf-contract-has-no-consumer-outside-the-layer';
	mentions(referenceProblems(tampered((r) => { limitOf(r, 'nestjs-structure-facts-have-no-producer').references.paths = ['elsewhere.mjs']; })), 'limit nestjs-structure-facts-have-no-producer: references are');
	mentions(referenceProblems(tampered((r) => { limitOf(r, consumer).references.pattern = 'bskel'; })), `limit ${consumer}: references are`);
	mentions(L.treeIdProblems(tampered((r) => { const entry = limitOf(r, 'scope-directory-names-are-walked').trees[1]; entry.git_tree_id = L.flip(entry.git_tree_id); }), ROOT, commit), 'limit scope-directory-names-are-walked: scanners is tree');
	mentions(L.treeIdProblems(tampered((r) => { limitOf(r, 'scope-directory-names-are-walked').trees[0].path = 'no/such/directory'; }), ROOT, commit), 'no/such/directory is tree null');
});

test('depth-1 clone: the pinned commit is fetched, its blobs are recomputed, ancestry is deepened', () => {
	const { checkout, record: rec } = shallowCopy();
	assert.deepEqual([L.isShallow(checkout), L.commitVerdict(checkout, rec.base_commit).verdict], [true, 'ok']);
	const readPinned = L.commitReader(checkout, rec.base_commit);
	assert.deepEqual(L.recomputeProblems(rec.files, readPinned, 'depth-1'), []);
	for (const key of KEYS) mentions(L.recomputeProblems([damage(rec.files[0], key), ...rec.files.slice(1)], readPinned, 'depth-1'), `${key} `);
	assert.equal(L.ancestryVerdict(checkout, rec.base_commit).verdict, 'ok');
	assert.equal(L.isShallow(checkout), false);
});

test('negative: an unavailable commit, a non-ancestor and a failed deepening fail unless the opt-out is exactly 1', () => {
	const { checkout, sideCommit } = shallowCopy();
	const verdicts = (call) => ['', 'true', '1'].map((v) => call(env(v)).verdict);
	assert.deepEqual(verdicts((e) => L.commitVerdict(checkout, 'f'.repeat(40), e)), ['fail', 'fail', 'unverified']);
	assert.equal(L.commitVerdict(checkout, sideCommit).verdict, 'ok');
	assert.equal(L.ancestryVerdict(checkout, sideCommit, env('')).verdict, 'fail');
	const broken = shallowCopy();
	spawnSync('git', ['config', '--local', 'remote.origin.url', 'file:///nonexistent'], { cwd: broken.checkout });
	assert.equal(L.commitVerdict(broken.checkout, broken.record.base_commit, env('')).verdict, 'fail');
	assert.deepEqual(verdicts((e) => L.ancestryVerdict(broken.checkout, broken.record.base_commit, e)), ['fail', 'fail', 'unverified']);
});
