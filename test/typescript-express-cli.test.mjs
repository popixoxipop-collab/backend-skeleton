// G5 (D-typescript-express-provider): end-to-end CLI tests for the typescript-express adapter --
// the third first-class adapter, alongside java-spring (G1) and python-fastapi (G2). Fixture/
// run() conventions copied from test/python-fastapi-cli.test.mjs, which this file does not modify.
// Fixture shape deliberately mirrors the real oracle's tricky cases (a 2-level router.use('/v1',
// v1) mount tree with no local base paths anywhere, a nested-paren middleware array, a barrel
// re-export) rather than a toy, since no framework-maintained reference exists for this ecosystem
// -- see DECISIONS.md D-typescript-express-provider for why this item's own verification
// confidence is honestly weaker than G2's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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

// A 2-level mount tree with no local base path ANYWHERE (routes/index.ts -> routes/v1/index.ts ->
// routes/v1/users.ts), a nested-paren middleware array (checkRole(['ADMIN'], true) inside
// router.get(path, [middlewares], handler)'s own arg list), a barrel re-export
// (controllers/users/index.ts: export * from './show'), and one entity with a UUID PK plus one
// column deliberately excluded from the handler's own select allow-list.
function buildFixtureRepo() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-typescript-express-fixture-'));
	execFileSync('git', ['init', '--quiet', '--initial-branch=develop'], { cwd: root });
	execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
	execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });

	const backendDir = path.join(root, 'backend');
	fs.mkdirSync(path.join(backendDir, 'src', 'routes', 'v1'), { recursive: true });
	fs.mkdirSync(path.join(backendDir, 'src', 'controllers', 'users'), { recursive: true });
	fs.mkdirSync(path.join(backendDir, 'src', 'orm', 'entities'), { recursive: true });
	fs.mkdirSync(path.join(backendDir, 'src', 'middleware'), { recursive: true });

	fs.writeFileSync(path.join(backendDir, 'package.json'), JSON.stringify({
		name: 'fixture-backend',
		dependencies: { express: '^4.18.2', typeorm: '^0.3.20' },
		devDependencies: { typescript: '^5.9.0' },
	}, null, 2));
	fs.writeFileSync(path.join(backendDir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { baseUrl: 'src' } }, null, 2));

	fs.writeFileSync(path.join(backendDir, 'src', 'data-source.ts'), `
import { DataSource } from 'typeorm';
import { User } from 'orm/entities/User';

export const AppDataSource = new DataSource({
  type: 'postgres',
  entities: [User],
});
`);

	// routes/index.ts: root of the mount tree -- itself has no incoming edge.
	fs.writeFileSync(path.join(backendDir, 'src', 'routes', 'index.ts'), `
import { Router } from 'express';
import v1 from './v1';

const router = Router();
router.use('/v1', v1);
export default router;
`);

	// routes/v1/index.ts: mid-tree hop -- prefix chain so far: /v1.
	fs.writeFileSync(path.join(backendDir, 'src', 'routes', 'v1', 'index.ts'), `
import { Router } from 'express';
import users from './users';

const router = Router();
router.use('/users', users);
export default router;
`);

	// routes/v1/users.ts: the leaf -- real absolute path is /v1/users/:id, entirely from the mount
	// chain, never declared locally. Nested-paren middleware array: checkRole(['ADMIN'], true).
	fs.writeFileSync(path.join(backendDir, 'src', 'routes', 'v1', 'users.ts'), `
import { Router } from 'express';
import { checkJwt } from '../../middleware/checkJwt';
import { checkRole } from '../../middleware/checkRole';
import { show } from '../../controllers/users';

const router = Router();
router.get('/:id', [checkJwt, checkRole(['ADMIN'], true)], show);
export default router;
`);

	fs.writeFileSync(path.join(backendDir, 'src', 'middleware', 'checkJwt.ts'), `
import { Request, Response, NextFunction } from 'express';
export function checkJwt(_req: Request, _res: Response, next: NextFunction): void { next(); }
`);
	fs.writeFileSync(path.join(backendDir, 'src', 'middleware', 'checkRole.ts'), `
import { Request, Response, NextFunction } from 'express';
export function checkRole(_roles: string[], _selfAllowed = false) {
  return (_req: Request, _res: Response, next: NextFunction): void => { next(); };
}
`);

	// Barrel re-export: the router imports 'show' from controllers/users (the index.ts barrel),
	// not from './show' directly -- resolving the real handler needs one hop.
	fs.writeFileSync(path.join(backendDir, 'src', 'controllers', 'users', 'index.ts'), `export * from './show';`);
	fs.writeFileSync(path.join(backendDir, 'src', 'controllers', 'users', 'show.ts'), `
import { Request, Response } from 'express';
import { AppDataSource } from '../../data-source';
import { User } from 'orm/entities/User';

export const show = async (req: Request, res: Response) => {
  const id = req.params.id;
  if (typeof id !== 'string') { res.status(400).json({ detail: 'bad id' }); return; }
  const user = await AppDataSource.getRepository(User).findOne({
    where: { id },
    select: ['id', 'username', 'email'],
  });
  res.json(user);
};
`);

	fs.writeFileSync(path.join(backendDir, 'src', 'orm', 'entities', 'User.ts'), `
import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ unique: true })
  email!: string;

  @Column()
  hashedPassword!: string;

  @Column({ nullable: true })
  username!: string;
}
`);

	fs.writeFileSync(path.join(root, '.gitignore'), 'specs/\n.sbf/\n');
	execFileSync('git', ['add', '-A'], { cwd: root });
	execFileSync('git', ['commit', '--quiet', '-m', 'chore: fixture'], { cwd: root });
	const bareOrigin = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-typescript-express-origin-'));
	execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=develop'], { cwd: bareOrigin });
	execFileSync('git', ['remote', 'add', 'origin', bareOrigin], { cwd: root });
	execFileSync('git', ['push', '--quiet', 'origin', 'develop'], { cwd: root });
	return root;
}

test('adapter selection: typescript-express is chosen (specificity 85), high confidence', () => {
	const root = buildFixtureRepo();
	const scan = run(['scan', '--terms', 'user', '--json'], root);
	assert.equal(scan.code, 0);
	const report = JSON.parse(scan.stdout);
	assert.equal(report.adapter, 'typescript-express');
	assert.equal(report.confidence, 'high');
});

test('mount-tree resolution: the leaf route\'s real path is the full 2-hop prefix chain (/v1/users/:id), never declared locally at any single site', () => {
	const root = buildFixtureRepo();
	const scan = run(['scan', '--terms', 'user', '--json'], root);
	const report = JSON.parse(scan.stdout);
	const usersModule = report.related_modules.find((m) => m.module === 'users');
	assert.ok(usersModule, 'expected a "users" module');
	const controller = usersModule.controllers[0];
	assert.equal(controller.basePath, '/v1/users');
	assert.equal(controller.endpoints[0].verb, 'GET');
	assert.equal(controller.endpoints[0].path, '/v1/users/:id');
	assert.equal(controller.endpoints[0].method, 'show');
});

test('balanced-paren middleware extraction: checkRole([\'ADMIN\'], true) inside the middleware array does not truncate path/handler extraction', () => {
	const root = buildFixtureRepo();
	const scan = run(['scan', '--terms', 'user', '--json'], root);
	const report = JSON.parse(scan.stdout);
	const usersModule = report.related_modules.find((m) => m.module === 'users');
	const ep = usersModule.controllers[0].endpoints[0];
	// The handler ("show", the LAST positional arg) must be correctly identified despite the
	// nested-paren middleware array sitting between the path literal and it.
	assert.equal(ep.method, 'show');
	const sourceText = fs.readFileSync(usersModule.controllers[0].file, 'utf8');
	const actualLine = sourceText.split('\n').findIndex((l) => l.includes("router.get('/:id'")) + 1;
	assert.equal(ep.line, actualLine);
});

test('entity extraction: User table/idField/idFieldIsUuid extracted from @Entity(\'users\')/@PrimaryGeneratedColumn(\'uuid\'), attaches to the "users" module by name-match', () => {
	const root = buildFixtureRepo();
	const scan = run(['scan', '--terms', 'user', '--json'], root);
	const report = JSON.parse(scan.stdout);
	const usersModule = report.related_modules.find((m) => m.module === 'users');
	const userEntity = usersModule.entities.find((e) => e.className === 'User');
	assert.ok(userEntity, 'expected the User entity attached to the users module');
	assert.equal(userEntity.table, 'users');
	assert.equal(userEntity.idField, 'id');
	assert.equal(userEntity.idFieldIsUuid, true);
});

test('capabilities declared honestly: api.operations/api.request-shape false, resource.fetch/codegen.handles true, and doctor detects this fixture', () => {
	const root = buildFixtureRepo();
	const doctor = run(['doctor', '--json'], root);
	const report = JSON.parse(doctor.stdout);
	const adapterInfo = report.adapters.find((a) => a.id === 'typescript-express');
	assert.ok(adapterInfo, 'expected typescript-express listed in doctor output');
	assert.equal(adapterInfo.capabilities['api.operations'], false);
	assert.equal(adapterInfo.capabilities['api.request-shape'], false);
	assert.equal(adapterInfo.capabilities['resource.fetch'], true);
	assert.equal(adapterInfo.capabilities['codegen.handles'], true);
	assert.equal(adapterInfo.detects, true);
});

function runWorkflowThroughScan(root, featureId, terms) {
	run(['preflight'], root);
	run(['feature', 'init', '--slug', featureId.replace(/^\d+-/, '')], root);
	run(['scan', '--feature', featureId, '--terms', terms, '--json'], root);
	run(['scan', 'disposition', '--feature', featureId, '--mode', 'extend', '--note', 'test'], root);
}

test('handles plan/emit against a typescript-express-scanned feature dispatches to the typescript-express provider, generates a resolver for User, and passes the handles gate', () => {
	const root = buildFixtureRepo();
	runWorkflowThroughScan(root, '001-user-management', 'user');
	run(['gate', 'force', 'contract', '--feature', '001-user-management', '--reason', 'handles-only test, no OpenAPI oracle for this ecosystem'], root);

	const plan = run(['handles', 'plan', '--feature', '001-user-management', '--module', 'users', '--json'], root);
	assert.equal(plan.code, 0);
	const planJson = JSON.parse(plan.stdout);
	assert.equal(planJson.provider, 'typescript-express');
	const userResource = planJson.resources.find((r) => r.type === 'User');
	assert.ok(userResource, 'expected a User resource in the plan');
	assert.equal(userResource.willGenerateResolver, true, `User should generate a resolver -- notes: ${JSON.stringify(planJson.notes)}`);

	const emit = run(['handles', 'emit', '--feature', '001-user-management', '--module', 'users'], root);
	assert.equal(emit.code, 0, emit.stderr);
	assert.ok(!(emit.stderr ?? '').includes('is this a Spring Boot project?'));

	const resolverPath = path.join(root, 'backend', 'src', 'handles', 'resolvers', 'user.ts');
	assert.ok(fs.existsSync(resolverPath), 'expected backend/src/handles/resolvers/user.ts to be written');

	const gate = run(['gate', 'require', 'handles', '--feature', '001-user-management'], root);
	assert.equal(gate.code, 0);

	const foreignFiles = execFileSync('find', [root, '-name', '*.java', '-o', '-name', '*.py'], { encoding: 'utf8' }).trim();
	assert.equal(foreignFiles, '', 'no .java or .py file should ever be written for a typescript-express-scanned feature');
});
