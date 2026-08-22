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
	// No migration.sql -- this 1st-slice provider generates no schema-owning artifact (no
	// recover(), no sbf_handle table), matching java-spring/python-fastapi's own pre-O4/
	// pre-follow-up state, not a gap specific to this provider.
	outputs: { spec: [] },
	plan,
	emit(args) {
		return emitTypeScriptExpress(args);
	},
};
