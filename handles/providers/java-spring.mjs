import { plan } from './java-spring/plan.mjs';
import { emitJavaSpring } from './java-spring/emit.mjs';

// D-handles-providers (G4). Zero-registration descriptor loaded by handles/registry.mjs -- see
// schemas/handles-provider.schema.json for the contract this object's JSON-shaped fields must
// match (plan/emit are functions, checked separately). This is the ORIGINAL handles codegen
// (pre-G4: handles/plan.mjs + handles/emit.mjs, un-abstracted) extracted behind the same
// interface handles/providers/python-fastapi.mjs implements -- see D-handles-providers for why
// this extraction only happened once a real second provider existed to factor a boundary
// against.
export const provider = {
	contract: 'sbf.handles-provider/1',
	id: 'java-spring',
	title: 'Java / Spring Boot',
	requiresCapabilities: ['resource.fetch'],
	// D-write-safety-phase0 (item 1): migration.sql is manifest-tracked now (classifyFile()-
	// classified, conflict-blocked, --force --reason-audited), so it no longer needs
	// handles/conformance.mjs's idempotence-check exclusion for correctness -- but this field is
	// ALSO lib/verify.mjs's S6 safety net (a `handles ran` check that fires even with no manifest
	// entry at all, e.g. a `gate force`d handles gate that never really emitted anything), which is
	// still real and still needed. Left unchanged rather than emptied -- checkArtifacts() dedupes
	// against the manifest-based check by path, so this doesn't produce a duplicate when a real
	// manifest entry exists; it only fires as the fallback when one doesn't.
	outputs: { spec: ['handles/migration.sql'] },
	plan,
	emit({ repoRoot, featureId, plan: handlesPlan, resourceFilter = null, force = false, reason = '', dryRun = false, computeDiff = false, enforceRegistry = false }) {
		return emitJavaSpring({ repoRoot, featureId, plan: handlesPlan, basePackage: handlesPlan.basePackage, resourceFilter, force, reason, dryRun, computeDiff, enforceRegistry });
	},
};
