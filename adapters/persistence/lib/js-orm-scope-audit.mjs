// Mechanical audit of an ORM scope record (adapters/persistence/<orm>/SCOPE.json): schema, version pins,
// recorded oracle results, fixtures, provider evidence and every support claim the record makes.
// An empty finding list means the record is consistent with the committed files and this repository.
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { isPersistenceTargetAdmitted, persistenceTargetById } from '../../../scanners/persistence-next/catalog.mjs';
import { lf, sha256, sha256Lf } from './js-orm-scope-facts.mjs';
import { computeEvidence, diskIo, formatScope } from './js-orm-scope-evidence.mjs';
import { PERSISTENCE_DIR } from './js-orm-scope-providers.mjs';

export const REQUIRED_PINS = {
	prisma: ['prisma'],
	drizzle: ['drizzle-orm', 'drizzle-kit'],
	typeorm: ['typeorm'],
	sequelize: ['sequelize'],
};
export const REQUIRED_CATEGORIES = ['composite-key', 'naming-strategy', 'relation', 'tenant-scope', 'migration-drift'];
export const COUNTEREXAMPLE_CATEGORIES = ['tenant-scope', 'naming-strategy'];
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

const finding = (code, where, message) => ({ code, where, message });
export const formatFinding = (item) => `${item.code} ${item.where}: ${item.message}`;
const list = (value) => (Array.isArray(value) ? value : []);
const sum = (values) => values.reduce((total, value) => total + value, 0);

let compiled = null;
export function validateScopeSchema(scope) {
	if (!compiled) {
		const ajv = new Ajv2020({ allErrors: true, strict: false });
		addFormats(ajv);
		compiled = ajv.compile(JSON.parse(fs.readFileSync(path.join(PERSISTENCE_DIR, 'js-orm-scope.schema.json'), 'utf8')));
	}
	const ok = compiled(scope);
	return { ok, errors: ok ? [] : compiled.errors.map((error) => `${error.instancePath || '(root)'} ${error.message}`) };
}

export function parsePinHeader(text) {
	const match = /^(?:\/\/|--)\s*fixture-pin:\s*(.+?)\s+case:/.exec(text.split('\n', 1)[0]);
	if (!match) return null;
	return match[1].split(/\s+/).map((token) => {
		const at = token.lastIndexOf('@');
		return at > 0 ? { name: token.slice(0, at), version: token.slice(at + 1) } : { name: token, version: '' };
	});
}

function registryFindings(code, where, check, command, version) {
	if (!check) return [finding(code, where, 'no registry check recorded')];
	const out = [];
	if (check.command !== command) out.push(finding(code, where, `registry command ${JSON.stringify(check.command)} is not ${JSON.stringify(command)}`));
	if (check.exit_code !== 0) out.push(finding(code, where, `registry command exited ${check.exit_code}`));
	if (check.output !== version) out.push(finding(code, where, `registry answered ${JSON.stringify(check.output)}, the record says ${JSON.stringify(version)}`));
	if (check.output_sha256 !== sha256(check.output ?? '')) out.push(finding(code, where, 'registry output hash does not match the recorded output'));
	return out;
}

function rulesIdentity({ orm, scope }) {
	const out = [];
	if (scope.contract !== 'bskel.internal.persistence-orm-scope/0') out.push(finding('IDENT', 'contract', `unexpected contract ${scope.contract}`));
	if (scope.orm !== orm) out.push(finding('IDENT', 'orm', `record says ${scope.orm}, expected ${orm}`));
	if (scope.target_id !== `ORM-${orm}-01`) out.push(finding('IDENT', 'target_id', `record says ${scope.target_id}, expected ORM-${orm}-01`));
	return out;
}

function rulesPins({ orm, scope, io }) {
	const out = [];
	const packages = list(scope.pins?.packages);
	const byName = new Map(packages.map((pkg) => [pkg.name, pkg]));
	if (byName.size !== packages.length) out.push(finding('PIN-FORMAT', 'pins.packages', 'a package is pinned twice'));
	for (const name of REQUIRED_PINS[orm]) {
		if (!byName.get(name)?.version) out.push(finding('PIN-MISSING', `pins.packages[${name}]`, 'the ORM package has no pinned version'));
	}
	if (!scope.pins?.checked_at) out.push(finding('PIN-REGISTRY', 'pins.checked_at', 'registry check date is missing'));
	for (const pkg of packages) {
		const where = `pins.packages[${pkg.name}]`;
		if (!EXACT_VERSION.test(pkg.version ?? '')) out.push(finding('PIN-FORMAT', where, `version ${JSON.stringify(pkg.version)} is not an exact version`));
		out.push(...registryFindings('PIN-REGISTRY', where, pkg.registry_check, `npm view ${pkg.name}@${pkg.version} version`, pkg.version));
	}
	for (const item of list(scope.pins?.not_covered)) {
		const where = `pins.not_covered[${item.name}@${item.dist_tag}]`;
		const pinned = byName.get(item.name);
		if (!pinned) out.push(finding('PIN-NOT-COVERED', where, 'lists a package that is not pinned'));
		else if (pinned.version === item.version) out.push(finding('PIN-NOT-COVERED', where, 'the version listed as not covered is the pinned version'));
		out.push(...registryFindings('PIN-NOT-COVERED', where, item.registry_check, `npm view ${item.name}@${item.dist_tag} version`, item.version));
	}
	const installed = scope.oracle?.environment?.installed ?? {};
	const wanted = Object.fromEntries(packages.filter((pkg) => pkg.oracle_install).map((pkg) => [pkg.name, pkg.version]));
	if (!isDeepStrictEqual(installed, wanted)) out.push(finding('PIN-ENV', 'oracle.environment.installed', `installed ${JSON.stringify(installed)} differs from the pins ${JSON.stringify(wanted)}`));
	const referenced = new Set();
	for (const file of io.listFiles('fixtures')) {
		const header = parsePinHeader(io.readText(file));
		if (!header || header.length === 0) {
			out.push(finding('PIN-FIXTURE-HEADER', file, 'first line carries no fixture-pin header'));
			continue;
		}
		for (const { name, version } of header) {
			if (byName.get(name)?.version === version) referenced.add(name);
			else out.push(finding('PIN-FIXTURE-HEADER', file, `header pins ${name}@${version} but the record pins ${byName.get(name)?.version ?? 'nothing'}`));
		}
	}
	for (const pkg of packages) {
		if (pkg.role !== 'support' && !referenced.has(pkg.name)) out.push(finding('PIN-FIXTURE-UNUSED', `pins.packages[${pkg.name}]`, 'no fixture header references this pin'));
	}
	const expectedVersions = packages.filter((pkg) => pkg.role !== 'support').map((pkg) => `${pkg.name}@${pkg.version}`).sort();
	if (!isDeepStrictEqual([...list(scope.profile?.versions)].sort(), expectedVersions)) out.push(finding('PIN-PROFILE', 'profile.versions', `profile versions ${JSON.stringify(scope.profile?.versions)} differ from the pins ${JSON.stringify(expectedVersions)}`));
	const environment = scope.oracle?.environment;
	if (environment && !(scope.profile?.platform ?? '').includes(environment.node)) out.push(finding('PIN-PROFILE', 'profile.platform', `does not name the recorded runtime ${environment.node}`));
	if (environment && !(scope.profile?.platform ?? '').includes(`${environment.platform}-${environment.arch}`)) out.push(finding('PIN-PROFILE', 'profile.platform', `does not name the recorded platform ${environment.platform}-${environment.arch}`));
	return out;
}

function rulesSteps({ scope, io }) {
	const out = [];
	const steps = list(scope.oracle?.steps);
	const ids = new Set();
	for (const step of steps) {
		const where = `oracle.steps[${step.id}]`;
		if (ids.has(step.id)) out.push(finding('STEP-RESULT', where, 'duplicate step id'));
		ids.add(step.id);
		if (step.exit_code !== step.expect_exit) out.push(finding('STEP-RESULT', where, `exit code ${step.exit_code} is not the expected ${step.expect_exit}`));
		if (step.runs !== 2 || step.deterministic !== true) out.push(finding('STEP-RESULT', where, 'step was not recorded as two identical runs'));
		if (!io.exists(step.result_file)) {
			out.push(finding('STEP-RESULT', where, `${step.result_file} is missing`));
			continue;
		}
		const content = lf(io.readText(step.result_file));
		if (sha256(content) !== step.output_sha256) out.push(finding('STEP-RESULT', where, `${step.result_file} differs from its recorded sha256`));
		if (Buffer.byteLength(content) !== step.output_bytes) out.push(finding('STEP-RESULT', where, `${step.result_file} differs from its recorded size`));
	}
	const known = new Set(steps.map((step) => step.result_file));
	for (const file of io.listFiles('oracle/results')) {
		if (!known.has(file)) out.push(finding('STEP-ORPHAN', file, 'result file belongs to no step'));
	}
	const cases = list(scope.cases);
	const caseIds = new Set(cases.map((item) => item.id));
	for (const step of steps) {
		if (!caseIds.has(step.case)) out.push(finding('STEP-CASE', `oracle.steps[${step.id}]`, `step belongs to unknown case ${step.case}`));
	}
	for (const scopeCase of cases) {
		const where = `cases[${scopeCase.id}]`;
		const owned = steps.filter((step) => step.case === scopeCase.id).map((step) => step.id).sort();
		if (!isDeepStrictEqual(owned, [...list(scopeCase.oracle_steps)].sort())) out.push(finding('STEP-CASE', where, `oracle_steps ${JSON.stringify(scopeCase.oracle_steps)} differ from the steps that name this case ${JSON.stringify(owned)}`));
		const first = steps.find((step) => step.id === scopeCase.oracle_steps?.[0]);
		if (scopeCase.category !== 'migration-drift' && first?.role !== 'expected-schema') out.push(finding('STEP-CASE', where, 'the first oracle step of a non-drift case must be an expected-schema step'));
	}
	return out;
}

function rulesFixtures({ scope, io }) {
	const out = [];
	const referenced = new Set();
	for (const scopeCase of list(scope.cases)) {
		for (const file of list(scopeCase.fixture?.files)) {
			referenced.add(file.path);
			if (!io.exists(file.path)) out.push(finding('FIXTURE-HASH', `cases[${scopeCase.id}]`, `${file.path} is missing`));
			else if (sha256Lf(io.readText(file.path)) !== file.sha256) out.push(finding('FIXTURE-HASH', `cases[${scopeCase.id}]`, `${file.path} differs from its recorded sha256`));
		}
	}
	const plane = scope.probes?.migration_plane;
	for (const item of [...list(plane?.layout), plane?.control].filter(Boolean)) {
		referenced.add(item.from);
		if (!io.exists(item.from)) out.push(finding('PROBE', 'probes.migration_plane', `${item.from} is missing`));
	}
	for (const file of io.listFiles('fixtures')) {
		if (!referenced.has(file) && !file.startsWith('fixtures/_harness/')) out.push(finding('FIXTURE-ORPHAN', file, 'fixture file is referenced by no case or probe'));
	}
	return out;
}

function rulesCases({ scope, evidence }) {
	const out = [];
	const cases = list(scope.cases);
	const seen = new Set();
	for (const scopeCase of cases) {
		const where = `cases[${scopeCase.id}]`;
		if (seen.has(scopeCase.id)) out.push(finding('CASE-DUP', where, 'duplicate case id'));
		seen.add(scopeCase.id);
		const ev = evidence.cases?.[scopeCase.id];
		if (!ev) {
			out.push(finding('EVIDENCE-MISMATCH', where, 'no recomputed evidence for this case'));
			continue;
		}
		const pairs = [
			['expected', scopeCase.expected, ev.expected],
			['expected_changes', scopeCase.expected_changes ?? null, ev.expected_changes ?? null],
			['provider', scopeCase.provider, ev.provider],
			['agreement', scopeCase.agreement, ev.agreement],
			['outcome', scopeCase.outcome, ev.outcome],
		];
		for (const [field, recorded, recomputed] of pairs) {
			if (!isDeepStrictEqual(recorded, recomputed)) out.push(finding('EVIDENCE-MISMATCH', `${where}.${field}`, 'recorded value differs from the value recomputed from the committed files and this repository'));
		}
	}
	const categories = new Set(cases.map((item) => item.category));
	for (const category of REQUIRED_CATEGORIES) {
		if (!categories.has(category)) out.push(finding('CASE-CATEGORY', 'cases', `no case for ${category}`));
	}
	for (const category of COUNTEREXAMPLE_CATEGORIES) {
		if (!cases.some((item) => item.category === category && item.kind === 'counterexample')) out.push(finding('CASE-CATEGORY', 'cases', `no counterexample case for ${category}`));
	}
	return out;
}

function caseClaim(construct, ev) {
	const provider = ev.provider;
	const absent = provider.mode === 'absent';
	const results = absent || !ev.agreement ? [] : list(construct.facets).map((facet) => ev.agreement[facet]).filter(Boolean);
	const comparator = provider.changes ? [...provider.changes.call_expected_v2_observed_v1.unknowns, ...provider.changes.call_expected_v1_observed_v2.unknowns] : [];
	return {
		absent,
		notDetected: provider.detected === false,
		matched: sum(results.map((item) => item.matched)),
		oracleOnly: sum(results.map((item) => item.oracle_only.length)),
		wrong: results.some((item) => item.result === 'mismatch' || item.result === 'provider-extra'),
		omits: results.some((item) => item.result === 'provider-omits'),
		unknowns: provider.unknowns.length + comparator.length,
		diagnostics: provider.diagnostics.length,
	};
}

function gapHolds(gap, facets, claims) {
	const some = (predicate) => claims.some(predicate);
	switch (gap) {
		case 'wrong-value': return some((item) => item.wrong);
		case 'silent-omission': return some((item) => item.omits) && claims.filter((item) => item.omits).every((item) => item.unknowns === 0 && item.diagnostics === 0);
		case 'diagnostic': return some((item) => item.diagnostics > 0);
		case 'ir-unknown': return some((item) => item.unknowns > 0);
		case 'absent-provider': return claims.length > 0 && claims.every((item) => item.absent);
		case 'not-modeled': return facets.length === 0;
		default: return false;
	}
}

function rulesConstructs({ orm, scope, evidence, admitted }) {
	const out = [];
	const constructs = list(scope.constructs);
	const cases = new Map(list(scope.cases).map((item) => [item.id, item]));
	const ids = new Set();
	const referencedCases = new Set();
	for (const construct of constructs) {
		const where = `constructs[${construct.id}]`;
		const raise = (code, message) => out.push(finding(code, where, `${construct.support}: ${message}`));
		if (ids.has(construct.id)) raise('CONSTRUCT-REF', 'duplicate construct id');
		ids.add(construct.id);
		const facets = list(construct.facets);
		const known = list(construct.cases).filter((id) => cases.has(id));
		for (const id of list(construct.cases)) {
			if (!cases.has(id)) raise('CONSTRUCT-REF', `references unknown case ${id}`);
		}
		known.forEach((id) => referencedCases.add(id));
		if (known.length > 0 && !known.some((id) => cases.get(id).category === construct.category)) raise('CONSTRUCT-REF', `none of its cases has category ${construct.category}`);
		if (construct.planned_in && !construct.planned_in.startsWith(`ORM-${orm}-`)) raise('PLAN', `planned_in ${construct.planned_in} belongs to another target`);
		const driftRefs = known.filter((id) => cases.get(id).category === 'migration-drift').length;
		if (facets.includes('changes') && (facets.length !== 1 || driftRefs !== known.length)) raise('CLAIM-FACETS', 'the changes facet is for drift cases only and stands alone');
		if (!facets.includes('changes') && facets.length > 0 && driftRefs > 0) raise('CLAIM-FACETS', 'a drift case can only be claimed on the changes facet');
		if (!admitted && construct.implementation === 'implemented') raise('CLAIM-UNADMITTED', `claims an implementation but ${orm} is not admitted in the persistence catalog`);

		const claims = known.filter((id) => evidence.cases?.[id]).map((id) => ({ id, ...caseClaim(construct, evidence.cases[id]) }));
		const total = (key) => sum(claims.map((item) => item[key]));
		if (construct.support === 'supported' || construct.support === 'partial') {
			if (!admitted) raise('CLAIM-UNADMITTED', `${orm} is not admitted in the persistence catalog`);
			for (const item of claims) {
				if (item.absent) raise('CLAIM-PROVIDER-ABSENT', `case ${item.id} has no provider output`);
				else if (item.notDetected) raise('CLAIM-NOT-DETECTED', `the provider did not detect case ${item.id}`);
				if (item.wrong) raise('CLAIM-DIVERGES', `provider output differs from the oracle in case ${item.id}`);
			}
			if (total('matched') === 0) raise('CLAIM-NO-MATCH', 'no fact of the claimed facets matched the oracle');
		}
		if (construct.support === 'supported') {
			for (const item of claims) {
				if (item.omits) raise('CLAIM-OMITS', `the provider omits facts the oracle has in case ${item.id}`);
				if (item.unknowns + item.diagnostics > 0) raise('CLAIM-GAP-REPORTED', `the provider reports an unknown or a diagnostic in case ${item.id}`);
			}
		}
		if (construct.support === 'partial' && total('oracleOnly') === 0) raise('CLAIM-NO-GAP', 'the provider omits nothing on the claimed facets');
		if (construct.support === 'unsupported' && facets.length > 0 && claims.length > 0 && total('matched') > 0
			&& claims.every((item) => !item.absent && !item.notDetected && !item.wrong && !item.omits && item.unknowns + item.diagnostics === 0)) {
			raise('CLAIM-UNDERSTATED', 'the provider output equals the oracle on every claimed facet');
		}
		if (construct.support === 'unknown') {
			for (const item of claims) {
				if (item.wrong) raise('CLAIM-DIVERGES', `the provider asserts a value that differs from the oracle in case ${item.id}`);
			}
		}
		if (construct.support !== 'supported' && !gapHolds(construct.gap_behavior, facets, claims)) {
			raise('CLAIM-GAP-UNVERIFIED', `gap_behavior ${construct.gap_behavior} is not what the recomputed provider output shows`);
		}
	}
	for (const id of cases.keys()) {
		if (!referencedCases.has(id)) out.push(finding('CONSTRUCT-REF', `cases[${id}]`, 'no construct references this case'));
	}
	for (const category of REQUIRED_CATEGORIES) {
		if (!constructs.some((item) => item.category === category)) out.push(finding('CONSTRUCT-REF', 'constructs', `no construct for ${category}`));
	}
	if (!constructs.some((item) => item.support === 'unknown')) out.push(finding('CONSTRUCT-REF', 'constructs', 'no construct stays unknown'));
	return out;
}

function rulesCatalogStatus({ orm, scope, admitted }) {
	const out = [];
	const live = persistenceTargetById(orm);
	const expected = {
		id: live.id,
		state: live.state,
		ingestion: live.ingestion,
		producer: live.producer,
		requires_live_verification: live.requires_live_verification,
		blocker: live.blocker ?? null,
		limitations: live.limitations,
	};
	if (!isDeepStrictEqual(scope.catalog, expected)) out.push(finding('CATALOG', 'catalog', `record ${JSON.stringify(scope.catalog)} differs from the live catalog entry ${JSON.stringify(expected)}`));
	if (scope.status?.support_completed !== false) out.push(finding('STATUS', 'status.support_completed', 'a development target must not claim completed support'));
	if (scope.status?.runtime_tested !== false) out.push(finding('STATUS', 'status.runtime_tested', 'runtime verification is not claimed'));
	const compared = list(scope.cases).some((item) => item.agreement);
	const level = compared ? 'oracle-compared' : list(scope.oracle?.steps).length > 0 ? 'oracle-recorded' : 'source-fixture';
	if (scope.status?.evidence_level !== level) out.push(finding('STATUS', 'status.evidence_level', `record says ${scope.status?.evidence_level}, the evidence supports ${level}`));
	if (!admitted && level === 'oracle-compared') out.push(finding('STATUS', 'status.evidence_level', 'a target that is not admitted has no provider output to compare'));
	const supported = list(scope.constructs).filter((item) => item.support === 'supported').map((item) => item.id).sort();
	if (!isDeepStrictEqual([...list(scope.profile?.capabilities)].sort(), supported)) out.push(finding('PROFILE-CAPS', 'profile.capabilities', `capabilities ${JSON.stringify(scope.profile?.capabilities)} differ from the constructs marked supported ${JSON.stringify(supported)}`));
	return out;
}

function rulesProbes({ scope, evidence }) {
	const out = [];
	const plane = scope.probes?.migration_plane;
	const live = evidence.migration_plane;
	if (!plane || !live) return [finding('PROBE', 'probes.migration_plane', 'missing')];
	if (!isDeepStrictEqual(plane.observed, live.observed)) out.push(finding('PROBE', 'probes.migration_plane.observed', `recorded ${JSON.stringify(plane.observed)} differs from the recomputed ${JSON.stringify(live.observed)}`));
	if (!isDeepStrictEqual(plane.control_observed, live.control_observed)) out.push(finding('PROBE', 'probes.migration_plane.control_observed', `recorded ${JSON.stringify(plane.control_observed)} differs from the recomputed ${JSON.stringify(live.control_observed)}`));
	if (live.control_observed.tool === 'none' || live.control_observed.files < 1) out.push(finding('PROBE', 'probes.migration_plane.control', 'the positive control was not read by the migration scanner, so an empty result proves nothing'));
	const constructIds = new Set(list(scope.constructs).map((item) => item.id));
	for (const id of list(scope.probes?.live_database?.affected)) {
		if (!constructIds.has(id)) out.push(finding('PROBE', 'probes.live_database.affected', `unknown construct ${id}`));
	}
	const blockedIds = new Set();
	for (const item of list(scope.oracle?.blocked)) {
		if (blockedIds.has(item.id)) out.push(finding('PROBE', `oracle.blocked[${item.id}]`, 'duplicate blocked id'));
		blockedIds.add(item.id);
		for (const id of list(item.affects)) {
			if (!constructIds.has(id)) out.push(finding('PROBE', `oracle.blocked[${item.id}]`, `affects unknown construct ${id}`));
		}
	}
	for (const step of list(scope.oracle?.steps)) {
		if (step.role === 'blocked-probe' && !blockedIds.has(step.id)) out.push(finding('PROBE', `oracle.steps[${step.id}]`, 'a blocked-probe step needs a matching oracle.blocked entry'));
	}
	return out;
}

function rulesPlan({ orm, scope }) {
	const out = [];
	const plan = scope.evidence_plan ?? {};
	const keys = [`ORM-${orm}-02`, `ORM-${orm}-03`];
	for (const key of keys) {
		if (!plan[key]) out.push(finding('PLAN', `evidence_plan[${key}]`, 'missing'));
	}
	for (const key of Object.keys(plan)) {
		if (!keys.includes(key)) out.push(finding('PLAN', `evidence_plan[${key}]`, 'not a follow-up step of this target'));
	}
	const [second, third] = keys.map((key) => plan[key]);
	if (second && !(list(second.depends_on).includes(`ORM-${orm}-01`) && list(second.depends_on).includes('T10-02'))) out.push(finding('PLAN', `evidence_plan[${keys[0]}]`, 'must depend on its scope record and on T10-02'));
	if (third && !list(third.depends_on).includes(keys[0])) out.push(finding('PLAN', `evidence_plan[${keys[1]}]`, `must depend on ${keys[0]}`));
	const blocker = persistenceTargetById(orm).blocker?.split(':')[0] ?? null;
	for (const key of keys) {
		if (blocker && plan[key] && !list(plan[key].blocked_by).includes(blocker)) out.push(finding('PLAN', `evidence_plan[${key}]`, `must list the catalog blocker ${blocker}`));
	}
	const planned = new Map(list(scope.constructs).filter((item) => item.planned_in).map((item) => [item.id, item.planned_in]));
	for (const [id, key] of planned) {
		if (!list(plan[key]?.constructs).includes(id)) out.push(finding('PLAN', `evidence_plan[${key}]`, `does not list ${id}, which is planned in it`));
	}
	for (const key of keys) {
		for (const id of list(plan[key]?.constructs)) {
			if (planned.get(id) !== key) out.push(finding('PLAN', `evidence_plan[${key}]`, `lists ${id}, which is not planned in it`));
		}
	}
	return out;
}

export function auditCanonicalFormat(orm, io = diskIo(orm)) {
	const text = io.readText('SCOPE.json');
	return formatScope(JSON.parse(text)) === text ? [] : [finding('FORMAT', 'SCOPE.json', 'file is not in canonical form (tab-indented JSON with a final newline)')];
}

export function auditScope(orm, scope, { evidence, io = diskIo(orm) } = {}) {
	const schema = validateScopeSchema(scope);
	const out = schema.errors.map((message) => finding('SCHEMA', 'schema', message));
	try {
		const context = { orm, scope, io, evidence: evidence ?? computeEvidence(orm, scope, io), admitted: isPersistenceTargetAdmitted(orm) };
		for (const rule of [rulesIdentity, rulesPins, rulesSteps, rulesFixtures, rulesCases, rulesConstructs, rulesCatalogStatus, rulesProbes, rulesPlan]) {
			out.push(...rule(context));
		}
	} catch (error) {
		if (schema.ok) throw error;
		out.push(finding('SCHEMA', 'structure', `audit stopped on a malformed record: ${error.message}`));
	}
	return out;
}
