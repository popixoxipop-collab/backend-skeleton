// D-typescript-express-provider (G5): plan-unit tests (direct plan() calls against hand-built
// scanReport fixtures, mirroring test/python-fastapi-handles.test.mjs's approach) plus a full CLI
// e2e pass for the typescript-express handles provider. See DECISIONS.md.
// The committed test/fixtures/typescript-express/backend/ tree (used by test/conformance-
// harness.test.mjs) is real-shaped but NOT reused here -- this file's own hand-built fixtures each
// isolate exactly one gating condition, the same "small, targeted, not a second full clone" split
// python-fastapi-handles.test.mjs already establishes for this codebase.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { plan as planTypeScriptExpress } from '../handles/providers/typescript-express/plan.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, '..', 'bin', 'bskel.mjs');

function run(args, cwd) {
	try {
		const stdout = execFileSync('node', [CLI, ...args], { cwd, encoding: 'utf8' });
		return { code: 0, stdout };
	} catch (err) {
		return { code: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
	}
}

// ---- plan-unit fixture: one project root, 4 entities each exercising one gating condition in
// isolation (User: everything present -- generates. Widget: no select allow-list. Gadget: integer
// PK, not UUID. Thing: no fetch route at all). ----
function buildPlanFixture() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-typescript-handles-plan-'));
	const srcDir = path.join(root, 'src');
	fs.mkdirSync(path.join(srcDir, 'routes'), { recursive: true });
	fs.mkdirSync(path.join(srcDir, 'controllers'), { recursive: true });
	fs.mkdirSync(path.join(srcDir, 'orm', 'entities'), { recursive: true });
	fs.writeFileSync(path.join(root, 'package.json'), '{}');
	fs.writeFileSync(path.join(root, 'tsconfig.json'), '{}');

	fs.writeFileSync(path.join(srcDir, 'data-source.ts'), `
import { DataSource } from 'typeorm';
export const AppDataSource = new DataSource({ type: 'postgres', entities: [] });
`);

	// The scanner's own `controller.file` is the ROUTER file (which imports the handler by name),
	// not the file that defines the handler -- plan.mjs's resolveHandlerFile() follows that import
	// to find the real defining file, matching the real architecture (see routes/v1/users.ts's own
	// `import { show } from '../../controllers/users'` in test/typescript-express-cli.test.mjs's
	// fixture). Each router file below imports its handler directly (no barrel hop needed here --
	// the barrel-hop path is covered by that other file's own fixture).
	const usersRouterPath = path.join(srcDir, 'routes', 'users.ts');
	fs.writeFileSync(usersRouterPath, `import { showUser } from '../controllers/users';\n`);
	const usersControllerPath = path.join(srcDir, 'controllers', 'users.ts');
	fs.writeFileSync(usersControllerPath, `
import { AppDataSource } from '../data-source';
import { User } from '../orm/entities';

export const showUser = async (req, res) => {
  const user = await AppDataSource.getRepository(User).findOne({
    where: { id: req.params.id },
    select: ['id', 'email'],
  });
  res.json(user);
};
`);
	const widgetsRouterPath = path.join(srcDir, 'routes', 'widgets.ts');
	fs.writeFileSync(widgetsRouterPath, `import { showWidget } from '../controllers/widgets';\n`);
	const widgetsControllerPath = path.join(srcDir, 'controllers', 'widgets.ts');
	fs.writeFileSync(widgetsControllerPath, `
import { AppDataSource } from '../data-source';
import { Widget } from '../orm/entities';

export const showWidget = async (req, res) => {
  // deliberately no field allow-list literal anywhere in this handler
  const widget = await AppDataSource.getRepository(Widget).findOne({ where: { id: req.params.id } });
  res.json(widget);
};
`);
	const gadgetsRouterPath = path.join(srcDir, 'routes', 'gadgets.ts');
	fs.writeFileSync(gadgetsRouterPath, `import { showGadget } from '../controllers/gadgets';\n`);
	const gadgetsControllerPath = path.join(srcDir, 'controllers', 'gadgets.ts');
	fs.writeFileSync(gadgetsControllerPath, `
import { AppDataSource } from '../data-source';
import { Gadget } from '../orm/entities';

export const showGadget = async (req, res) => {
  const gadget = await AppDataSource.getRepository(Gadget).findOne({
    where: { id: req.params.id },
    select: ['id', 'name'],
  });
  res.json(gadget);
};
`);

	const entitiesPath = path.join(srcDir, 'orm', 'entities', 'index.ts');
	fs.writeFileSync(entitiesPath, `
import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id!: string;
  @Column() email!: string;
}

@Entity('widgets')
export class Widget {
  @PrimaryGeneratedColumn('uuid')
  id!: string;
  @Column() name!: string;
}

@Entity('gadgets')
export class Gadget {
  @PrimaryGeneratedColumn()
  id!: number;
  @Column() name!: string;
}

@Entity('things')
export class Thing {
  @PrimaryGeneratedColumn('uuid')
  id!: string;
}
`);

	const scanReport = {
		related_modules: [{
			module: 'users',
			controllers: [
				{ className: 'UsersRouter', basePath: '/users', endpoints: [
					{ verb: 'GET', path: '/users/:id', operationId: null, method: 'showUser', line: 1 },
				], file: usersRouterPath },
				{ className: 'WidgetsRouter', basePath: '/widgets', endpoints: [
					{ verb: 'GET', path: '/widgets/:id', operationId: null, method: 'showWidget', line: 1 },
				], file: widgetsRouterPath },
				{ className: 'GadgetsRouter', basePath: '/gadgets', endpoints: [
					{ verb: 'GET', path: '/gadgets/:id', operationId: null, method: 'showGadget', line: 1 },
				], file: gadgetsRouterPath },
			],
			entities: [
				{ className: 'User', table: 'users', idField: 'id', idFieldIsUuid: true, file: entitiesPath },
				{ className: 'Widget', table: 'widgets', idField: 'id', idFieldIsUuid: true, file: entitiesPath },
				{ className: 'Gadget', table: 'gadgets', idField: 'id', idFieldIsUuid: false, file: entitiesPath },
				{ className: 'Thing', table: 'things', idField: 'id', idFieldIsUuid: true, file: entitiesPath },
			],
		}],
	};
	return { root, scanReport };
}

test('plan: fetch route resolved via the module\'s own controller file (no barrel needed here), User has everything present -> generates', () => {
	const { root, scanReport } = buildPlanFixture();
	const result = planTypeScriptExpress({ repoRoot: root, scanReport, module: 'users', resourceFilter: ['User'] });
	const user = result.resources.find((r) => r.type === 'User');
	assert.ok(user.fetchRoute, 'expected a fetchRoute for User');
	assert.equal(user.fetchRoute.method, 'showUser');
	assert.equal(user.willGenerateResolver, true, `expected User to generate -- notes: ${JSON.stringify(result.notes)}`);
});

test('plan: no literal select: [...] allow-list in the fetch handler -> resolver NOT generated, with a note naming the leak risk (Widget)', () => {
	const { root, scanReport } = buildPlanFixture();
	const result = planTypeScriptExpress({ repoRoot: root, scanReport, module: 'users', resourceFilter: ['Widget'] });
	const widget = result.resources.find((r) => r.type === 'Widget');
	assert.equal(widget.willGenerateResolver, false);
	assert.equal(widget.selectFields, null);
	assert.ok(result.notes.some((n) => n.includes('Widget') && n.includes('select') && n.includes('leak')));
});

test('plan: idField exists but is not UUID-typed (bare @PrimaryGeneratedColumn()) -> resolver NOT generated, with a note naming the structural UUID constraint (Gadget)', () => {
	const { root, scanReport } = buildPlanFixture();
	const result = planTypeScriptExpress({ repoRoot: root, scanReport, module: 'users', resourceFilter: ['Gadget'] });
	const gadget = result.resources.find((r) => r.type === 'Gadget');
	assert.equal(gadget.willGenerateResolver, false);
	assert.ok(result.notes.some((n) => n.includes('Gadget') && n.includes('not UUID-typed')));
});

test('plan: no single-resource GET route on a name-matching router -> resolver NOT generated (Thing has no controller at all)', () => {
	const { root, scanReport } = buildPlanFixture();
	const result = planTypeScriptExpress({ repoRoot: root, scanReport, module: 'users', resourceFilter: ['Thing'] });
	const thing = result.resources.find((r) => r.type === 'Thing');
	assert.equal(thing.willGenerateResolver, false);
	assert.equal(thing.fetchRoute, null);
	assert.ok(result.notes.some((n) => n.includes('Thing') && n.includes('no single-resource GET route')));
});

test('plan: --resource filter narrows to the named entity only', () => {
	const { root, scanReport } = buildPlanFixture();
	const result = planTypeScriptExpress({ repoRoot: root, scanReport, module: 'users', resourceFilter: ['User'] });
	assert.deepEqual(result.resources.map((r) => r.type), ['User']);
});

test('plan: no ancestor with BOTH package.json and tsconfig.json -> throws naming the project-root limitation, not a silent guess', () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-typescript-handles-plan-noroot-'));
	const entitiesPath = path.join(root, 'src', 'orm', 'entities', 'index.ts');
	fs.mkdirSync(path.dirname(entitiesPath), { recursive: true });
	fs.writeFileSync(entitiesPath, '');
	const scanReport = { related_modules: [{ module: 'users', controllers: [], entities: [{ className: 'User', table: 'users', idField: 'id', idFieldIsUuid: true, file: entitiesPath }] }] };
	assert.throws(() => planTypeScriptExpress({ repoRoot: root, scanReport, module: 'users', resourceFilter: null }), /could not detect a TypeScript project root/);
});

test('plan: two genuinely different project roots among this module\'s own files -> throws naming both candidates', () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-typescript-handles-plan-ambiguous-'));
	const aDir = path.join(root, 'pkg_a');
	const bDir = path.join(root, 'pkg_b');
	fs.mkdirSync(aDir, { recursive: true });
	fs.mkdirSync(bDir, { recursive: true });
	fs.writeFileSync(path.join(aDir, 'package.json'), '{}');
	fs.writeFileSync(path.join(aDir, 'tsconfig.json'), '{}');
	fs.writeFileSync(path.join(bDir, 'package.json'), '{}');
	fs.writeFileSync(path.join(bDir, 'tsconfig.json'), '{}');
	const entitiesPath = path.join(aDir, 'entities.ts');
	const controllerPath = path.join(bDir, 'controller.ts');
	fs.writeFileSync(entitiesPath, '');
	fs.writeFileSync(controllerPath, '');
	const scanReport = {
		related_modules: [{
			module: 'users',
			controllers: [{ className: 'UsersRouter', basePath: '/users', endpoints: [], file: controllerPath }],
			entities: [{ className: 'User', table: 'users', idField: 'id', idFieldIsUuid: true, file: entitiesPath }],
		}],
	};
	assert.throws(() => planTypeScriptExpress({ repoRoot: root, scanReport, module: 'users', resourceFilter: null }), /ambiguous TypeScript project root/);
});

// ---- e2e (CLI) fixture: reuses the committed test/fixtures/typescript-express/backend/ tree
// (the same one test/conformance-harness.test.mjs and test/typescript-express-cli.test.mjs's own
// mount-tree fixture cover from different angles) via a fresh scratch copy + real git repo. ----
const FIXTURE_SRC = path.join(__dirname, 'fixtures', 'typescript-express');

function buildE2eFixtureRepo() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-typescript-handles-e2e-'));
	fs.cpSync(FIXTURE_SRC, root, { recursive: true });
	execFileSync('git', ['init', '--quiet', '--initial-branch=develop'], { cwd: root });
	execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
	execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
	fs.writeFileSync(path.join(root, '.gitignore'), 'specs/\n.sbf/\n');
	execFileSync('git', ['add', '-A'], { cwd: root });
	execFileSync('git', ['commit', '--quiet', '-m', 'chore: fixture'], { cwd: root });
	const bareOrigin = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-typescript-handles-e2e-origin-'));
	execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=develop'], { cwd: bareOrigin });
	execFileSync('git', ['remote', 'add', 'origin', bareOrigin], { cwd: root });
	execFileSync('git', ['push', '--quiet', 'origin', 'develop'], { cwd: root });
	return root;
}

function runToHandlesEmit(root) {
	run(['preflight'], root);
	run(['feature', 'init', '--slug', 'user-management'], root);
	run(['scan', '--feature', '001-user-management', '--terms', 'user', '--json'], root);
	run(['scan', 'disposition', '--feature', '001-user-management', '--mode', 'extend', '--note', 'test'], root);
	run(['gate', 'force', 'contract', '--feature', '001-user-management', '--reason', 'handles-only test, no OpenAPI oracle for this ecosystem'], root);
	run(['scan', 'cross-feature-check', '--feature', '001-user-management'], root); // D-cross-feature-collision: single-feature fixture, always passes
	return run(['handles', 'emit', '--feature', '001-user-management', '--module', 'users', '--json'], root);
}

// D-typescript-express-registry-parity: this provider is no longer 1st-slice-only -- migration.sql/
// handleEntities.ts/handleService.ts/recordSnapshotWrapper.ts/<Type>Policy.ts are all real now.
test('e2e: handles emit writes exactly the expected files, including migration.sql and the full registry stack', () => {
	const root = buildE2eFixtureRepo();
	const emit = runToHandlesEmit(root);
	assert.equal(emit.code, 0, emit.stderr);
	const result = JSON.parse(emit.stdout);
	assert.deepEqual(result.written.sort(), [
		'backend/src/handles/codec.ts',
		'backend/src/handles/handleEntities.ts',
		'backend/src/handles/handleService.ts',
		'backend/src/handles/recordSnapshotWrapper.ts',
		'backend/src/handles/registry.ts',
		'backend/src/handles/resolvers/resolvers_index.ts',
		'backend/src/handles/resolvers/user.ts',
		'backend/src/handles/resolvers/userPolicy.ts',
		'backend/src/handles/router.ts',
		'specs/001-user-management/handles/migration.sql',
	].sort());
	assert.ok(result.postEmitNotes.some((n) => n.includes('handles/router')), 'expected the router-wiring note');
	assert.ok(result.postEmitNotes.some((n) => n.includes('recordSnapshotWrapper')), 'expected the recordSnapshotWrapper-wiring note');
});

test('e2e: checkAccess always throws HandleAccessDeniedError (403), patchField always throws HandleNotImplementedError (501), hashedPassword never referenced by the resolver', () => {
	const root = buildE2eFixtureRepo();
	runToHandlesEmit(root);
	const resolverSrc = fs.readFileSync(path.join(root, 'backend', 'src', 'handles', 'resolvers', 'user.ts'), 'utf8');
	assert.match(resolverSrc, /HandleAccessDeniedError/);
	assert.match(resolverSrc, /HandleNotImplementedError/);
	assert.ok(!resolverSrc.includes('hashedPassword'), 'the resolver must only ever project through the discovered select allow-list, never the raw entity\'s own fields directly');
});

test('e2e: the router checks PATCH kind explicitly (kind !== "f" or pointer == null), not just pointer-presence', () => {
	const root = buildE2eFixtureRepo();
	runToHandlesEmit(root);
	const routerSrc = fs.readFileSync(path.join(root, 'backend', 'src', 'handles', 'router.ts'), 'utf8');
	assert.match(routerSrc, /decoded\.kind !== 'f' \|\| decoded\.pointer == null/);
});

// D-typescript-express-registry-parity: migration.sql is real and manifest-tracked now -- `bskel
// verify` must track a real migration artifact, mirroring java-spring's/python-fastapi's own
// verify-integration test exactly.
test('e2e: bskel verify passes the handles gate and tracks a real migration.sql artifact', () => {
	const root = buildE2eFixtureRepo();
	const emit = runToHandlesEmit(root);
	assert.equal(emit.code, 0, emit.stderr);
	const verify = run(['verify', '--feature', '001-user-management', '--json'], root);
	const report = JSON.parse(verify.stdout);
	const migrationArtifact = report.artifacts.find((a) => a.artifact.includes('migration'));
	assert.ok(migrationArtifact, 'expected a migration artifact check now that migration.sql is real');
	assert.equal(migrationArtifact.exists, true);
	const handlesArtifacts = report.artifacts.filter((a) => a.artifact.includes('handles'));
	assert.ok(handlesArtifacts.length > 0);
	assert.ok(handlesArtifacts.every((a) => a.exists === true));
});

test('e2e: re-emit is idempotent -- nothing rewritten, resolver stays byte-identical', () => {
	const root = buildE2eFixtureRepo();
	runToHandlesEmit(root);
	const resolverPath = path.join(root, 'backend', 'src', 'handles', 'resolvers', 'user.ts');
	const before = fs.readFileSync(resolverPath, 'utf8');
	const second = run(['handles', 'emit', '--feature', '001-user-management', '--module', 'users', '--json'], root);
	assert.equal(second.code, 0, second.stderr);
	const result = JSON.parse(second.stdout);
	assert.deepEqual(result.written, []);
	assert.equal(fs.readFileSync(resolverPath, 'utf8'), before);
});

test('e2e: hand-editing a generated resolver then re-running exits 15 and leaves the file byte-for-byte untouched', () => {
	const root = buildE2eFixtureRepo();
	runToHandlesEmit(root);
	const resolverPath = path.join(root, 'backend', 'src', 'handles', 'resolvers', 'user.ts');
	const edited = `${fs.readFileSync(resolverPath, 'utf8')}\n// hand-finished by a human\n`;
	fs.writeFileSync(resolverPath, edited);
	const second = run(['handles', 'emit', '--feature', '001-user-management', '--module', 'users'], root);
	assert.equal(second.code, 15);
	assert.equal(fs.readFileSync(resolverPath, 'utf8'), edited);
});

// D-patch-transactions (Continued): resolvers_index.ts used to be written OUTSIDE emitUnits()
// entirely -- no --force gate, no manifest tracking, no dirty-tree guard, unlike every other
// generated file. The following tests prove it now gets the exact same conflict-safe treatment
// infra files (codec.ts/registry.ts/router.ts) already get, via emitUnits()'s new postResolverUnit.
const BARREL_REL_PATH = 'backend/src/handles/resolvers/resolvers_index.ts';
const MANIFEST_REL_PATH = '.sbf/handles-manifest.json';

function reestablishThroughContract(root) {
	// Mirrors runToHandlesEmit's own preflight->...->cross-feature-check chain -- needed again
	// after a hand-edit + commit advances HEAD, which stales the head_sha-based preflight gate.
	run(['preflight'], root);
	run(['scan', '--feature', '001-user-management', '--terms', 'user', '--json'], root);
	run(['scan', 'disposition', '--feature', '001-user-management', '--mode', 'extend', '--note', 'test'], root);
	run(['gate', 'force', 'contract', '--feature', '001-user-management', '--reason', 'handles-only test, no OpenAPI oracle for this ecosystem'], root);
	run(['scan', 'cross-feature-check', '--feature', '001-user-management'], root);
}

test('e2e: resolvers_index.ts content is unchanged from before this item -- still a real barrel importing every resolver', () => {
	const root = buildE2eFixtureRepo();
	runToHandlesEmit(root);
	const barrelContent = fs.readFileSync(path.join(root, BARREL_REL_PATH), 'utf8');
	assert.match(barrelContent, /import '\.\/user';/);
});

test('e2e: resolvers_index.ts gains a real, infra-shaped manifest entry after emit (previously never manifest-tracked at all)', () => {
	const root = buildE2eFixtureRepo();
	runToHandlesEmit(root);
	const manifest = JSON.parse(fs.readFileSync(path.join(root, MANIFEST_REL_PATH), 'utf8'));
	const entry = manifest.files[BARREL_REL_PATH];
	assert.ok(entry, 'expected a manifest entry for resolvers_index.ts');
	assert.equal(entry.kind, 'infra', 'must be kind: infra (repo-owned) -- lib/verify.mjs labels anything else "handles resolver"');
	assert.equal(entry.ownership, 'repo');
	assert.equal(entry.owner, '_repo');
});

test('e2e: a hand-edited resolvers_index.ts blocks re-emit with exit 15 and is left byte-for-byte untouched (previously: silently clobbered)', () => {
	const root = buildE2eFixtureRepo();
	runToHandlesEmit(root);
	const barrelPath = path.join(root, BARREL_REL_PATH);
	const edited = `${fs.readFileSync(barrelPath, 'utf8')}\n// hand-added import by a human\n`;
	fs.writeFileSync(barrelPath, edited);

	const second = run(['handles', 'emit', '--feature', '001-user-management', '--module', 'users', '--json'], root);
	assert.equal(second.code, 15);
	assert.equal(fs.readFileSync(barrelPath, 'utf8'), edited);
	const body = JSON.parse(second.stdout);
	assert.ok(body.conflicts.some((c) => c.path === BARREL_REL_PATH && c.kind === 'infra'), `expected an infra conflict for the barrel, got: ${JSON.stringify(body.conflicts)}`);
});

test('e2e: --force --reason overwrites a COMMITTED diverged resolvers_index.ts, records last_force in the manifest', () => {
	const root = buildE2eFixtureRepo();
	runToHandlesEmit(root);
	const barrelPath = path.join(root, BARREL_REL_PATH);
	fs.writeFileSync(barrelPath, `${fs.readFileSync(barrelPath, 'utf8')}\n// hand-added import by a human\n`);
	execFileSync('git', ['add', '-A'], { cwd: root });
	execFileSync('git', ['commit', '--quiet', '-m', 'hand edit barrel'], { cwd: root });
	reestablishThroughContract(root);

	const forced = run(['handles', 'emit', '--feature', '001-user-management', '--module', 'users', '--force', '--reason', 'intentional overwrite for test', '--json'], root);
	assert.equal(forced.code, 0, forced.stderr);
	const forcedJson = JSON.parse(forced.stdout);
	assert.ok(forcedJson.forced.includes(BARREL_REL_PATH), `expected ${BARREL_REL_PATH} in forced, got: ${JSON.stringify(forcedJson.forced)}`);
	assert.ok(!fs.readFileSync(barrelPath, 'utf8').includes('hand-added import'), 'the hand edit must be gone after a successful force');

	const manifest = JSON.parse(fs.readFileSync(path.join(root, MANIFEST_REL_PATH), 'utf8'));
	assert.equal(manifest.files[BARREL_REL_PATH].last_force.reason, 'intentional overwrite for test');
});

test('e2e: --force --reason refuses an UNCOMMITTED diverged resolvers_index.ts -- overwrite must stay recoverable', () => {
	const root = buildE2eFixtureRepo();
	runToHandlesEmit(root);
	const barrelPath = path.join(root, BARREL_REL_PATH);
	const edited = `${fs.readFileSync(barrelPath, 'utf8')}\n// uncommitted hand edit\n`;
	fs.writeFileSync(barrelPath, edited);
	// deliberately NOT committed

	const forced = run(['handles', 'emit', '--feature', '001-user-management', '--module', 'users', '--force', '--reason', 'try anyway'], root);
	assert.equal(forced.code, 15, 'a refused --force must still report as blocked, not silently succeed');
	assert.equal(fs.readFileSync(barrelPath, 'utf8'), edited, 'file must remain untouched when --force is refused for being uncommitted');
});

test('e2e: handles emit --check --diff reports a real diff for a diverged resolvers_index.ts without writing it', () => {
	const root = buildE2eFixtureRepo();
	runToHandlesEmit(root);
	const barrelPath = path.join(root, BARREL_REL_PATH);
	const edited = `${fs.readFileSync(barrelPath, 'utf8')}\n// hand-added import by a human\n`;
	fs.writeFileSync(barrelPath, edited);

	const check = run(['handles', 'emit', '--feature', '001-user-management', '--module', 'users', '--check', '--diff', '--json'], root);
	assert.equal(check.code, 15);
	assert.equal(fs.readFileSync(barrelPath, 'utf8'), edited, '--check must never write');
	const body = JSON.parse(check.stdout);
	const action = body.actions.find((a) => a.path === BARREL_REL_PATH);
	assert.ok(action, 'expected an action entry for the barrel');
	assert.equal(action.kind, 'infra', 'regression guard: must never be kind "spec" again -- that label is now factually false once conflict-tracked');
	assert.ok(action.diff && action.diff.length > 0, 'expected a real unified diff attached');
});

test('e2e: no orphan is ever reported for resolvers_index.ts itself', () => {
	const root = buildE2eFixtureRepo();
	const emit = runToHandlesEmit(root);
	const body = JSON.parse(emit.stdout);
	assert.ok(!body.orphans.some((o) => o.path === BARREL_REL_PATH), `resolvers_index.ts must never appear as its own orphan, got: ${JSON.stringify(body.orphans)}`);
});
