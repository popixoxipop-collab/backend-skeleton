// Runs the repository's own persistence providers over the committed fixtures of an ORM scope record.
// Not a test file: the nested runner collects only *.test.mjs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { scanPrismaPersistence } from '../../../scanners/persistence-next/providers/prisma.mjs';
import { adapter as expressTs } from '../../../scanners/adapters/typescript-express.mjs';
import { fromLegacyAdapterScan } from '../../../scanners/persistence-next/legacy.mjs';
import { comparePersistenceIr } from '../../../scanners/persistence-next/drift.mjs';
import { isPersistenceTargetAdmitted, persistenceTargetById } from '../../../scanners/persistence-next/catalog.mjs';
import { scanMigrations } from '../../../scanners/db/migrations.mjs';
import { irFacts, sortedUnique } from './js-orm-scope-facts.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PERSISTENCE_DIR = path.resolve(HERE, '..');
export const ORMS = ['prisma', 'drizzle', 'typeorm', 'sequelize'];

export function ripgrepAvailable() {
	return spawnSync('rg', ['--version'], { stdio: 'ignore' }).status === 0;
}

function withTempRoot(prefix, fn) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	try {
		return fn(root);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

function copyInto(root, from, to) {
	const target = path.join(root, to);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.copyFileSync(from, target);
}

function prismaIr(ormDir, schemaFile) {
	return withTempRoot('orm-scope-prisma-', (root) => {
		copyInto(root, path.join(ormDir, schemaFile), 'prisma/schema.prisma');
		return scanPrismaPersistence(root);
	});
}

function typeormIr(ormDir, scope, files) {
	return withTempRoot('orm-scope-typeorm-', (root) => {
		const typeorm = scope.pins.packages.find((pkg) => pkg.name === 'typeorm');
		fs.writeFileSync(path.join(root, 'package.json'), `${JSON.stringify({ name: 'orm-scope-harness', private: true, dependencies: { express: '*', typeorm: typeorm.version } })}\n`);
		copyInto(root, path.join(ormDir, 'fixtures/_harness/routes.ts'), 'src/routes.ts');
		for (const file of files) copyInto(root, path.join(ormDir, file), `src/${path.basename(file)}`);
		const detected = expressTs.detect(root);
		if (!detected) return { detected: false, ir: null };
		const scan = expressTs.scan(root, detected);
		return { detected: true, ir: fromLegacyAdapterScan({ adapterId: expressTs.id, scan, repoRoot: root }) };
	});
}

function filesUnder(scopeCase, prefix) {
	return scopeCase.fixture.files.map((file) => file.path).filter((file) => file.startsWith(prefix));
}

function changeStrings(forward, backward) {
	const out = [];
	for (const finding of forward.findings) {
		if (finding.code === 'column-missing') out.push(`add-column ${finding.table}.${finding.column}`);
		else if (finding.code === 'table-missing') out.push(`create-table ${finding.table}`);
		else out.push(`${finding.code} ${finding.table}`);
	}
	for (const finding of backward.findings) {
		if (finding.code === 'column-missing') out.push(`drop-column ${finding.table}.${finding.column}`);
		else if (finding.code === 'table-missing') out.push(`drop-table ${finding.table}`);
		else out.push(`${finding.code} ${finding.table}`);
	}
	return sortedUnique(out);
}

function comparatorRecord(v1, v2) {
	const forward = comparePersistenceIr({ expected: v2, observed: v1 });
	const backward = comparePersistenceIr({ expected: v1, observed: v2 });
	const describe = (compared) => ({
		findings: compared.findings.map((f) => `${f.code} ${f.table ?? ''}${f.column ? `.${f.column}` : ''}`.trim()).sort(),
		unknowns: compared.unknowns.map((u) => u.code).sort(),
	});
	return {
		call_expected_v2_observed_v1: describe(forward),
		call_expected_v1_observed_v2: describe(backward),
		changes: changeStrings(forward, backward),
	};
}

const PROVIDER_MODES = {
	prisma: { mode: 't10-provider', invocation: 'scanPrismaPersistence(<temp root holding the fixture as prisma/schema.prisma>)' },
	typeorm: { mode: 'legacy-adapter-bridge', invocation: 'typescript-express adapter scan + fromLegacyAdapterScan (temp repo: package.json, Express router stub, fixture .ts files)' },
};

// Recomputes the provider block of one case. Pure function of the committed files and the repository sources.
export function recomputeProvider(orm, scope, scopeCase) {
	const ormDir = path.join(PERSISTENCE_DIR, orm);
	const target = persistenceTargetById(orm);
	const admitted = isPersistenceTargetAdmitted(orm);
	if (!PROVIDER_MODES[orm] || !admitted) {
		return { mode: 'absent', invocation: null, admitted, facts: null, unknowns: [], inferred_tables: [], diagnostics: [], detected: null, changes: null, blocker: target?.blocker ?? null };
	}
	const { mode, invocation } = PROVIDER_MODES[orm];
	const isDrift = scopeCase.category === 'migration-drift';
	const base = { mode, invocation, admitted, blocker: null };
	if (orm === 'prisma') {
		const schemas = scopeCase.fixture.files.map((file) => file.path);
		if (isDrift) {
			const v1 = prismaIr(ormDir, schemas.find((file) => file.endsWith('v1.prisma')));
			const v2 = prismaIr(ormDir, schemas.find((file) => file.endsWith('v2.prisma')));
			return { ...base, facts: null, unknowns: [], inferred_tables: [], diagnostics: [], detected: true, changes: comparatorRecord(v1, v2) };
		}
		const ir = prismaIr(ormDir, schemas[0]);
		return { ...base, ...irFacts(ir), detected: true, changes: null };
	}
	if (isDrift) {
		const v1 = typeormIr(ormDir, scope, filesUnder(scopeCase, 'fixtures/drift-v1/'));
		const v2 = typeormIr(ormDir, scope, filesUnder(scopeCase, 'fixtures/drift-v2/'));
		const detected = v1.detected && v2.detected;
		return { ...base, facts: null, unknowns: [], inferred_tables: [], diagnostics: [], detected, changes: detected ? comparatorRecord(v1.ir, v2.ir) : null };
	}
	const run = typeormIr(ormDir, scope, scopeCase.fixture.files.map((file) => file.path));
	const facts = run.ir ? irFacts(run.ir) : { facts: null, unknowns: [], inferred_tables: [], diagnostics: [] };
	return { ...base, ...facts, detected: run.detected, changes: null };
}

// Probes the repository's migration scanner with the migration layout this ORM's tooling writes,
// plus a Flyway-layout positive control so an empty result cannot be a scanner that finds nothing.
export function runMigrationProbe(orm, probe) {
	const ormDir = path.join(PERSISTENCE_DIR, orm);
	const summarize = (scan) => ({ tool: scan.tool, files: scan.files.length, tables: scan.tables.length });
	const observed = withTempRoot('orm-scope-migration-', (root) => {
		for (const item of probe.layout) copyInto(root, path.join(ormDir, item.from), item.to);
		return summarize(scanMigrations(root));
	});
	const controlObserved = withTempRoot('orm-scope-migration-control-', (root) => {
		copyInto(root, path.join(ormDir, probe.control.from), probe.control.to);
		return summarize(scanMigrations(root));
	});
	return { observed, control_observed: controlObserved };
}
