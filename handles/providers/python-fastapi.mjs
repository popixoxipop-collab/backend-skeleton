import { plan } from './python-fastapi/plan.mjs';
import { emitPythonFastApi } from './python-fastapi/emit.mjs';

// D-handles-providers (G4). Zero-registration descriptor loaded by handles/registry.mjs -- see
// schemas/handles-provider.schema.json for the contract this object's JSON-shaped fields must
// match (plan/emit are functions, checked separately). The real second codegen provider G1's own
// D-adapter-registry EXIT held out for before the java-spring extraction (handles/providers/
// java-spring.mjs) was worth doing at all.
export const provider = {
	contract: 'sbf.handles-provider/1',
	id: 'python-fastapi',
	title: 'Python / FastAPI / SQLModel',
	requiresCapabilities: ['resource.fetch'],
	// D-write-safety-phase0 (item 1): mirrors java-spring.mjs's own updated comment exactly -- kept
	// unchanged rather than emptied. See that file for the full reasoning (checkArtifacts()'s S6
	// safety net for a `handles ran` but manifest-less state still needs this declared).
	outputs: { spec: ['handles/migration.sql'] },
	plan,
	emit(args) {
		return emitPythonFastApi(args);
	},
};
