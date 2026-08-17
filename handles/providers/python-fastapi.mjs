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
	// No migration.sql -- this provider generates no schema-owning artifact (no recover(), no
	// sbf_handle table -- see D-handles-providers EXCLUDED). lib/verify.mjs falls back to
	// ['handles/migration.sql'] only when it can't resolve a provider at all, never for this one.
	outputs: { spec: [] },
	plan,
	emit(args) {
		return emitPythonFastApi(args);
	},
};
