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
	// G4 follow-up (D-handles-providers): this provider now generates a real recover()
	// lifecycle + sbf_handle/sbf_handle_snapshot migration, mirroring java-spring's own O4 work --
	// the EXCLUDED reasoning that used to justify an empty outputs.spec here is stale.
	outputs: { spec: ['handles/migration.sql'] },
	plan,
	emit(args) {
		return emitPythonFastApi(args);
	},
};
