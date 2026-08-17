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
	outputs: { spec: ['handles/migration.sql'] },
	plan,
	emit({ repoRoot, featureId, plan: handlesPlan, resourceFilter = null, force = false, reason = '' }) {
		return emitJavaSpring({ repoRoot, featureId, plan: handlesPlan, basePackage: handlesPlan.basePackage, resourceFilter, force, reason });
	},
};
