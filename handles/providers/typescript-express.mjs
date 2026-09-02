import { plan } from './typescript-express/plan.mjs';
import { emitTypeScriptExpress } from './typescript-express/emit.mjs';

// G5 (D-typescript-express-provider). Zero-registration descriptor loaded by handles/registry.mjs
// -- see schemas/handles-provider.schema.json for the contract this object's JSON-shaped fields
// must match (plan/emit are functions, checked separately).
export const provider = {
	contract: 'sbf.handles-provider/1',
	id: 'typescript-express',
	title: 'TypeScript / Express / TypeORM',
	requiresCapabilities: ['resource.fetch'],
	// D-typescript-express-registry-parity: migration.sql is manifest-tracked now (like every
	// other provider's, per D-write-safety-phase0), so this declaration is NOT for idempotence
	// exclusion -- it's lib/verify.mjs's S6 safety net (a `handles ran` check that fires even with
	// no manifest entry at all, e.g. a `gate force`d handles gate). See java-spring.mjs's own
	// identical comment for the full reasoning; checkArtifacts() dedupes against the manifest-
	// based check by path, so this never produces a duplicate once a real manifest entry exists.
	outputs: { spec: ['handles/migration.sql'] },
	plan,
	emit(args) {
		return emitTypeScriptExpress(args);
	},
};
