import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

const CONFORMANCE_ROOT = path.dirname(fileURLToPath(import.meta.url));
const SCHEMAS_ROOT = path.join(CONFORMANCE_ROOT, '..', 'schemas');

let _ajv = null;
function ajv() {
	if (!_ajv) _ajv = new Ajv2020({ allErrors: true, strict: false });
	return _ajv;
}

function loadHandlesPlanSchema() {
	return JSON.parse(fs.readFileSync(path.join(SCHEMAS_ROOT, 'handles-plan.schema.json'), 'utf8'));
}

// P4 (D-extension-conformance): schemas/handles-plan.schema.json existed since G4 (multi-provider
// handles codegen) but had no real consumer anywhere in the codebase -- bin/bskel.mjs renders a
// provider's plan() output directly, never validating it against this schema. This is that
// schema's first real use: proof a third-party provider's plan() actually produces the shape
// schemas/handles-plan.schema.json (and this project's own CLI renderer) expect, plus an emit()
// idempotence check equivalent to stack/apply.mjs's applyPlan() re-apply guarantee -- a second
// emit() against files the first emit() already wrote must report nothing new to write.
//
// Found live while grounding this against the real java-spring provider: `provider.outputs.spec`
// (e.g. `handles/migration.sql`, under `specs/<featureId>/`) is BY DESIGN regenerated
// unconditionally on every emit() call, unlike the manifest-tracked generated-code files --
// handles/providers/java-spring/emit.mjs's own comment documents this as pre-existing, intentional
// behavior, not a bug this item should flag. `provider.outputs.spec` is exactly the schema field
// (schemas/handles-provider.schema.json, required) that already distinguishes these two
// categories, so the idempotence check excludes those declared paths instead of hardcoding
// per-provider knowledge into this harness.
export function checkProviderConformance(provider, { repoRoot, scanReport, module = null, resourceFilter = null, featureId = 'zz-conformance-check' } = {}) {
	const errors = [];
	let plan;
	try {
		plan = provider.plan({ repoRoot, scanReport, module, resourceFilter });
	} catch (err) {
		errors.push(`plan() threw: ${err.message}`);
		return { provider: provider.id, ok: false, errors };
	}

	const schema = loadHandlesPlanSchema();
	const validateFn = ajv().getSchema(schema.$id) ?? ajv().compile(schema);
	if (!validateFn(plan)) {
		const details = (validateFn.errors ?? []).map((e) => `${e.instancePath || '(root)'} ${e.message}`).join('; ');
		errors.push(`plan() output does not match schemas/handles-plan.schema.json: ${details}`);
	}

	let first;
	try {
		first = provider.emit({ repoRoot, featureId, plan, resourceFilter, force: false, reason: '' });
	} catch (err) {
		errors.push(`emit() threw: ${err.message}`);
		return { provider: provider.id, ok: false, errors };
	}

	let second;
	try {
		second = provider.emit({ repoRoot, featureId, plan, resourceFilter, force: false, reason: '' });
	} catch (err) {
		errors.push(`emit() threw on its second, idempotent call: ${err.message}`);
		return { provider: provider.id, ok: false, errors };
	}
	const specOwnedPaths = new Set((provider.outputs?.spec ?? []).map((relPath) => path.join('specs', featureId, relPath)));
	const unexpectedWrites = (second.written ?? []).filter((w) => !specOwnedPaths.has(w));
	if (!Array.isArray(second.written) || unexpectedWrites.length !== 0) {
		errors.push(`emit() is not idempotent -- a second call against files the first call already wrote reported written: ${JSON.stringify(second.written)} (expected only provider.outputs.spec entries, if any: ${JSON.stringify([...specOwnedPaths])})`);
	}

	return { provider: provider.id, ok: errors.length === 0, errors, firstEmitWritten: first.written };
}
