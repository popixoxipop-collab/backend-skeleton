import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { emitUnits } from '../../_engine.mjs';
import { sha256File } from '../../../lib/fsutil.mjs';
import { specPath } from '../../../lib/paths.mjs';
import { loadFeatureFile } from '../../../lib/featurelifecycle.mjs';

const PROVIDER_ROOT = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = path.join(PROVIDER_ROOT, 'templates');
const RESOLVER_TEMPLATE = path.join(TEMPLATES_DIR, 'resolver.ts.tmpl');
const RESOLVER_POLICY_TEMPLATE = path.join(TEMPLATES_DIR, 'resolverPolicy.ts.tmpl');
const RESOLVERS_INDEX_TEMPLATE = path.join(TEMPLATES_DIR, 'resolvers_index.ts.tmpl');
const MIGRATION_TEMPLATE = path.join(TEMPLATES_DIR, 'migration.sql.tmpl');

// D-typescript-express-registry-parity: a resource's fetch route file is the closest analog this
// provider has to java-spring's/python-fastapi's own "service file" -- there is no separate
// service layer this scanner extracts, so the static registration-gap check (mirrors Phase 1 item
// 2 exactly) reads the same file `FETCH_ROUTE_FILE` already points at. Checks for an IMPORT of
// recordSnapshotWrapper.ts, not the string "recordSnapshot(" alone -- that string is also the name
// of handleService.ts's own lower-level persistence function (a real, deliberate naming overlap
// recordSnapshotWrapper.ts.tmpl's own header explains), so a bare substring match would produce
// false negatives on files that only import the OTHER recordSnapshot.
const RECORD_SNAPSHOT_WRAPPER_IMPORT_RE = /from\s+['"][^'"]*recordSnapshotWrapper['"]/;

function hasRecordSnapshotWrapper(filePath) {
	if (!filePath || !fs.existsSync(filePath)) return false;
	return RECORD_SNAPSHOT_WRAPPER_IMPORT_RE.test(fs.readFileSync(filePath, 'utf8'));
}

function render(templatePath, vars) {
	let content = fs.readFileSync(templatePath, 'utf8');
	for (const [key, value] of Object.entries(vars)) {
		content = content.replaceAll(`{{${key}}}`, String(value));
	}
	return content;
}

// PascalCase -> camelCase filename, good enough for the class names this scanner actually
// extracts (ASCII identifiers only, same assumption every other provider's own naming makes).
function camelCase(s) {
	return s.length > 0 ? s[0].toLowerCase() + s.slice(1) : s;
}

// Relative TS import specifier from `fromFile`'s own directory to `toFile`, extension-stripped,
// forward-slash-joined (Node import specifiers are never OS-path-separated), always explicitly
// relative (`./x`, not bare `x`) so generated code never depends on a target's own tsconfig
// `baseUrl` being set a particular way.
function relativeImportPath(fromFile, toFile) {
	const fromDir = path.dirname(fromFile);
	let rel = path.relative(fromDir, toFile).replace(/\.ts$/, '');
	rel = rel.split(path.sep).join('/');
	if (!rel.startsWith('.')) rel = `./${rel}`;
	return rel;
}

// G5 (D-typescript-express-provider), registry parity added in D-typescript-express-registry-parity:
// migration.sql/recover()/enforcement now mirror java-spring's/python-fastapi's own shape --
// see that DECISIONS.md entry for the full design (notably: no decorator-based interception
// mechanism exists in TypeScript the way Java has AOP and Python has decorators, so
// recordSnapshotWrapper.ts is a higher-order function instead). Unlike Python, router.ts is infra
// emitted UNCONDITIONALLY (no SessionDep-shaped precondition exists for it -- TypeORM's
// DataSource is imported directly by each resolver, never injected per-request the way FastAPI's
// Depends()/SQLAlchemy Session is).
export function emitTypeScriptExpress({ repoRoot, featureId, plan, resourceFilter = null, force = false, reason = '', dryRun = false, computeDiff = false, enforceRegistry = false }) {
	const handlesDir = path.join(plan.srcRoot, 'handles');
	const resolversDir = path.join(handlesDir, 'resolvers');
	const resolversIndexPath = path.join(resolversDir, 'resolvers_index.ts');
	// D-typescript-express-registry-parity: repo-relative (specs/<id>/handles/migration.sql), not
	// under plan.srcRoot -- mirrors java-spring's/python-fastapi's own migrationPath exactly.
	const migrationPath = path.join(repoRoot, 'specs', featureId, 'handles', 'migration.sql');

	const infraUnits = [
		{ id: 'codec.ts.tmpl', templatePath: path.join(TEMPLATES_DIR, 'codec.ts.tmpl'), targetAbs: path.join(handlesDir, 'codec.ts'), rendered: render(path.join(TEMPLATES_DIR, 'codec.ts.tmpl'), {}) },
		{ id: 'registry.ts.tmpl', templatePath: path.join(TEMPLATES_DIR, 'registry.ts.tmpl'), targetAbs: path.join(handlesDir, 'registry.ts'), rendered: render(path.join(TEMPLATES_DIR, 'registry.ts.tmpl'), {}) },
		{ id: 'router.ts.tmpl', templatePath: path.join(TEMPLATES_DIR, 'router.ts.tmpl'), targetAbs: path.join(handlesDir, 'router.ts'), rendered: render(path.join(TEMPLATES_DIR, 'router.ts.tmpl'), { ENFORCE_REGISTRY: enforceRegistry ? 'true' : 'false' }) },
		// D-typescript-express-registry-parity: repo-wide (one registry table, one service module,
		// one wrapper), mirroring java-spring's global/handle/* infra exactly -- not per-resource.
		{ id: 'handleEntities.ts.tmpl', templatePath: path.join(TEMPLATES_DIR, 'handleEntities.ts.tmpl'), targetAbs: path.join(handlesDir, 'handleEntities.ts'), rendered: render(path.join(TEMPLATES_DIR, 'handleEntities.ts.tmpl'), {}) },
		{ id: 'handleService.ts.tmpl', templatePath: path.join(TEMPLATES_DIR, 'handleService.ts.tmpl'), targetAbs: path.join(handlesDir, 'handleService.ts'), rendered: render(path.join(TEMPLATES_DIR, 'handleService.ts.tmpl'), {}) },
		{ id: 'recordSnapshotWrapper.ts.tmpl', templatePath: path.join(TEMPLATES_DIR, 'recordSnapshotWrapper.ts.tmpl'), targetAbs: path.join(handlesDir, 'recordSnapshotWrapper.ts'), rendered: render(path.join(TEMPLATES_DIR, 'recordSnapshotWrapper.ts.tmpl'), {}) },
	];

	// D-resolver-policy-split, ported here in D-typescript-express-registry-parity: mirrors
	// java-spring's/python-fastapi's own contractRefFor/featureUidFor exactly, including the
	// cross-feature adoption-safety fix -- see D-resolver-policy-split in DECISIONS.md.
	const contractRefFor = (id) => sha256File(specPath(repoRoot, id, 'contracts', `${id}.schema.json`));
	const featureUidFor = (id) => loadFeatureFile(repoRoot, id)?.feature_uid ?? '00000000-0000-0000-0000-000000000000';
	const contractRef = contractRefFor(featureId);
	const featureUid = featureUidFor(featureId);

	const willGenerate = plan.resources.filter((r) => r.willGenerateResolver);
	const resolverUnits = willGenerate.flatMap((resource) => {
		const targetAbs = path.join(resolversDir, `${camelCase(resource.type)}.ts`);
		const policyTargetAbs = path.join(resolversDir, `${camelCase(resource.type)}Policy.ts`);
		const vars = {
			FEATURE_ID: featureId,
			RESOURCE_TYPE: resource.type,
			RESOURCE_TYPE_CAMEL: camelCase(resource.type),
			MODEL: resource.type,
			MODEL_IMPORT_PATH: relativeImportPath(targetAbs, path.join(plan.srcRoot, `${resource.modelImport}.ts`)),
			DATA_SOURCE_NAME: resource.dataSource.name,
			DATA_SOURCE_IMPORT_PATH: relativeImportPath(targetAbs, resource.dataSource.file),
			ID_FIELD: resource.idField,
			SELECT_PROJECTION: resource.selectFields.map((f) => `${f}: row.${f}`).join(', '),
			FETCH_ROUTE_FILE: resource.fetchRoute ? path.relative(repoRoot, resource.fetchRoute.file) : '(unknown)',
			FETCH_ROUTE_LINE: resource.fetchRoute ? resource.fetchRoute.line : '',
		};
		// D-resolver-policy-split: CONTRACT_REF/FEATURE_UID live ONLY in the policy unit now, not
		// the resolver unit -- FEATURE_ID is the only per-feature substitution the resolver itself
		// still carries, so its own pristineRenderFor only ever needs to swap that one var.
		const policyVars = { FEATURE_ID: featureId, RESOURCE_TYPE: resource.type, CONTRACT_REF: contractRef, FEATURE_UID: featureUid };
		return [
			{
				id: 'resolver.ts.tmpl',
				resourceType: resource.type,
				module: plan.module,
				templatePath: RESOLVER_TEMPLATE,
				targetAbs,
				rendered: render(RESOLVER_TEMPLATE, vars),
				pristineRenderFor: (ownerId) => render(RESOLVER_TEMPLATE, { ...vars, FEATURE_ID: ownerId }),
			},
			{
				id: 'resolverPolicy.ts.tmpl',
				resourceType: resource.type,
				module: plan.module,
				templatePath: RESOLVER_POLICY_TEMPLATE,
				targetAbs: policyTargetAbs,
				rendered: render(RESOLVER_POLICY_TEMPLATE, policyVars),
				// Only FEATURE_ID varies by owner for the resolver unit above; CONTRACT_REF/FEATURE_UID
				// vary by owner HERE, exactly like java-spring's/python-fastapi's own policy unit.
				pristineRenderFor: (ownerId) => render(RESOLVER_POLICY_TEMPLATE, {
					...policyVars,
					FEATURE_ID: ownerId,
					CONTRACT_REF: ownerId === featureId ? contractRef : contractRefFor(ownerId),
					FEATURE_UID: ownerId === featureId ? featureUid : featureUidFor(ownerId),
				}),
			},
		];
	});

	const orphanScan = (!resourceFilter && plan.module) ? {
		dir: resolversDir,
		module: plan.module,
		matchesFile: (file) => file.endsWith('.ts') && file !== 'resolvers_index.ts',
		// Filename can't reliably recover the exact class-name casing -- read the `type: 'X'` field
		// the resolver template itself carries instead of guessing from the filename, same content-
		// read approach python-fastapi's own orphan scan already uses.
		resourceTypeOf: (_file, content) => {
			const m = content.match(/^\s*type:\s*'([^']+)'/m);
			return m ? m[1] : null;
		},
	} : null;

	const result = emitUnits({
		repoRoot, featureId, provider: 'typescript-express', force, reason, infraUnits, resolverUnits, orphanScan, dryRun, computeDiff,
		// D-patch-transactions (Continued): the resolvers barrel's own import list is regenerated
		// from the resolvers directory's REAL current contents (not just this run's own
		// resolverUnits) -- an orphaned resolver from a different feature/module (O2's "never
		// delete, only report" policy leaves it on disk) still needs its own `register(...)` call
		// imported, or that resource type silently stops being servable. `render()` is called by
		// emitUnits() itself AFTER its resolver loop writes this run's own files, so this always
		// sees the final on-disk listing -- now conflict-safe/manifest-tracked like every other
		// generated file. D-typescript-express-registry-parity: excludes `*Policy.ts` files
		// explicitly -- those have no `register(...)` side effect of their own (their sibling
		// resolver file already imports them directly), importing them a second time here would
		// be a spurious, pointless barrel entry.
		// D-write-safety-phase0/D-typescript-express-registry-parity: migration.sql now shares
		// this array with resolvers_index.ts (widened from a single optional unit to an array
		// specifically so this provider could have both at once -- see D-typescript-express-registry-parity
		// in DECISIONS.md for why migration.sql needed the SAME manifest-tracked treatment
		// java-spring/python-fastapi already have, from day one).
		postResolverUnits: [
			{
				id: 'resolvers_index.ts.tmpl',
				templatePath: RESOLVERS_INDEX_TEMPLATE,
				targetAbs: resolversIndexPath,
				render: () => {
					const currentResolverFiles = fs.existsSync(resolversDir)
						? fs.readdirSync(resolversDir).filter((f) => f.endsWith('.ts') && f !== 'resolvers_index.ts' && !f.endsWith('Policy.ts')).sort()
						: [];
					const imports = currentResolverFiles.map((f) => `import './${f.replace(/\.ts$/, '')}';`).join('\n');
					return render(RESOLVERS_INDEX_TEMPLATE, { IMPORTS: imports });
				},
			},
			{
				id: 'migration.sql.tmpl', templatePath: MIGRATION_TEMPLATE, targetAbs: migrationPath,
				render: () => render(MIGRATION_TEMPLATE, { FEATURE_ID: featureId }),
				kind: 'migration', ownership: 'feature', owner: featureId,
			},
		],
	});

	// D-write-safety-phase1 (item 2), ported here: per-resource, conditional on enforceRegistry
	// actually being on -- mirrors java-spring's/python-fastapi's own registrationGaps exactly.
	const registrationGaps = [];
	const postEmitNotes = [
		`NOT done automatically: wiring the generated router into your app -- add "import { router as handlesRouter } from './handles/router';" and mount it via your app's own router-composition file (e.g. app.use(handlesRouter)) by hand.`,
		'NOT done automatically: wrapping an existing route handler with recordSnapshot(...) (see handles/recordSnapshotWrapper.ts) to have it register/snapshot automatically. Codegen never touches an existing business logic file.',
	];
	if (enforceRegistry) {
		for (const resource of willGenerate) {
			const fetchRouteFile = resource.fetchRoute?.file ?? null;
			if (hasRecordSnapshotWrapper(fetchRouteFile)) continue;
			const relFile = fetchRouteFile ? path.relative(repoRoot, fetchRouteFile) : '(unknown)';
			const note = `${resource.type}: --enforce-registry is on, but no import of recordSnapshotWrapper.ts was found anywhere in ${relFile} -- this resource may never get its first HandleRegistry row, and every fetch()/patch() call against it will 404 until something registers it. Wrap ${resource.type}'s own create-flow route with recordSnapshot(...) (or call registerHandle() by hand at least once per resource), then re-emit. See D-handle-registry-enforcement in DECISIONS.md for the full bootstrapping explanation.`;
			postEmitNotes.push(note);
			registrationGaps.push({ resourceType: resource.type, file: relFile, note });
		}
	}

	return {
		...result,
		postEmitNotes,
		registrationGaps,
	};
}
