import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { emitUnits } from '../../_engine.mjs';

const PROVIDER_ROOT = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = path.join(PROVIDER_ROOT, 'templates');
const RESOLVER_TEMPLATE = path.join(TEMPLATES_DIR, 'resolver.ts.tmpl');
const RESOLVERS_INDEX_TEMPLATE = path.join(TEMPLATES_DIR, 'resolvers_index.ts.tmpl');

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

// G5 (D-typescript-express-provider): mirrors python-fastapi/emit.mjs's own 1st-slice shape
// exactly (as it existed at 627c214, before that provider's own separate recover()/snapshot
// follow-up) -- no migration, no recover(), see the EXCLUDED-equivalent reasoning in
// D-typescript-express-provider. Unlike Python, router.ts is infra emitted UNCONDITIONALLY (no
// SessionDep-shaped precondition exists for it -- TypeORM's DataSource is imported directly by
// each resolver, never injected per-request the way FastAPI's Depends()/SQLAlchemy Session is).
export function emitTypeScriptExpress({ repoRoot, featureId, plan, resourceFilter = null, force = false, reason = '', dryRun = false, computeDiff = false }) {
	const handlesDir = path.join(plan.srcRoot, 'handles');
	const resolversDir = path.join(handlesDir, 'resolvers');
	const resolversIndexPath = path.join(resolversDir, 'resolvers_index.ts');

	const infraUnits = [
		{ id: 'codec.ts.tmpl', templatePath: path.join(TEMPLATES_DIR, 'codec.ts.tmpl'), targetAbs: path.join(handlesDir, 'codec.ts'), rendered: render(path.join(TEMPLATES_DIR, 'codec.ts.tmpl'), {}) },
		{ id: 'registry.ts.tmpl', templatePath: path.join(TEMPLATES_DIR, 'registry.ts.tmpl'), targetAbs: path.join(handlesDir, 'registry.ts'), rendered: render(path.join(TEMPLATES_DIR, 'registry.ts.tmpl'), {}) },
		{ id: 'router.ts.tmpl', templatePath: path.join(TEMPLATES_DIR, 'router.ts.tmpl'), targetAbs: path.join(handlesDir, 'router.ts'), rendered: render(path.join(TEMPLATES_DIR, 'router.ts.tmpl'), {}) },
	];

	const resolverUnits = plan.resources
		.filter((r) => r.willGenerateResolver)
		.map((resource) => {
			const targetAbs = path.join(resolversDir, `${camelCase(resource.type)}.ts`);
			const vars = {
				FEATURE_ID: featureId,
				RESOURCE_TYPE: resource.type,
				MODEL: resource.type,
				MODEL_IMPORT_PATH: relativeImportPath(targetAbs, path.join(plan.srcRoot, `${resource.modelImport}.ts`)),
				DATA_SOURCE_NAME: resource.dataSource.name,
				DATA_SOURCE_IMPORT_PATH: relativeImportPath(targetAbs, resource.dataSource.file),
				ID_FIELD: resource.idField,
				SELECT_PROJECTION: resource.selectFields.map((f) => `${f}: row.${f}`).join(', '),
				FETCH_ROUTE_FILE: resource.fetchRoute ? path.relative(repoRoot, resource.fetchRoute.file) : '(unknown)',
				FETCH_ROUTE_LINE: resource.fetchRoute ? resource.fetchRoute.line : '',
			};
			return {
				id: 'resolver.ts.tmpl',
				resourceType: resource.type,
				module: plan.module,
				templatePath: RESOLVER_TEMPLATE,
				targetAbs,
				rendered: render(RESOLVER_TEMPLATE, vars),
				// FEATURE_ID is the only per-feature substitution (mirrors java-spring's/python-fastapi's
				// own resolver templates -- no other var here changes between features for the SAME
				// resource), so recovering the pristine render under a different owner is exactly the
				// same render with FEATURE_ID swapped.
				pristineRenderFor: (ownerId) => render(RESOLVER_TEMPLATE, { ...vars, FEATURE_ID: ownerId }),
			};
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
		// generated file, no longer unconditional (unlike migration.sql, which stays that way).
		postResolverUnit: {
			id: 'resolvers_index.ts.tmpl',
			templatePath: RESOLVERS_INDEX_TEMPLATE,
			targetAbs: resolversIndexPath,
			render: () => {
				const currentResolverFiles = fs.existsSync(resolversDir)
					? fs.readdirSync(resolversDir).filter((f) => f.endsWith('.ts') && f !== 'resolvers_index.ts').sort()
					: [];
				const imports = currentResolverFiles.map((f) => `import './${f.replace(/\.ts$/, '')}';`).join('\n');
				return render(RESOLVERS_INDEX_TEMPLATE, { IMPORTS: imports });
			},
		},
	});

	return {
		...result,
		postEmitNotes: [
			`NOT done automatically: wiring the generated router into your app -- add "import { router as handlesRouter } from './handles/router';" and mount it via your app's own router-composition file (e.g. app.use(handlesRouter)) by hand.`,
		],
	};
}
