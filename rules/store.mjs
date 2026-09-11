// D-business-rules (R1/R2): the I/O boundary for business rules. Paths, reading the hand-authored
// YAML source, and reading/writing the compiled JSON artifact with schema validation on BOTH
// sides -- the exact shape lib/cross-feature-collisions.mjs's
// loadCrossFeatureResolution/saveCrossFeatureResolution and contracts/completeness.mjs's
// loadResolution/saveResolution already hold ("refusing to write an invalid ...").
//
// rules/compile.mjs stays pure and filesystem-free; everything that touches disk lives here.
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { specPath } from '../lib/paths.mjs';
import { readJsonIfExists, writeFileAtomic } from '../lib/fsutil.mjs';
import { validateAgainstSchema, formatSchemaErrors } from '../lib/schema-validate.mjs';
import { RULES_SOURCE_SCHEMA } from './compile.mjs';

// The hand-authored file. Sits directly in the feature's spec dir alongside dependencies.json --
// both are human-authored declarations about this feature's own fields, so they are siblings.
export function rulesSourcePath(root, featureId) {
	return specPath(root, featureId, 'rules.yaml');
}

// The compiled artifact. In its own `rules/` subdirectory, matching how `handles/migration.sql`
// already nests a generated artifact under the feature's spec dir.
export function rulesArtifactPath(root, featureId) {
	return specPath(root, featureId, 'rules', `${featureId}.rules.json`);
}

/**
 * Reads and parses specs/<featureId>/rules.yaml. Returns null when the file does not exist at all
 * -- a legal, common state meaning "this feature declares no hand-authored rules", which still
 * compiles to a real artifact from contract-projected rules alone (R4).
 *
 * Throws on malformed YAML or a wrong/missing `schema` key. Deliberately NOT schema-validated
 * beyond that: rules/compile.mjs resolves every rule against the contract itself and produces
 * strictly better refusals (naming real known fields, real declared types, real enum states) than
 * a structural schema could -- see schemas/feature-rules.schema.json's own description.
 */
export function loadRulesSource(root, featureId) {
	const file = rulesSourcePath(root, featureId);
	if (!fs.existsSync(file)) return null;
	let parsed;
	try {
		parsed = parseYaml(fs.readFileSync(file, 'utf8'));
	} catch (err) {
		throw new Error(`${file}: not valid YAML -- ${err.message}`);
	}
	if (parsed === null || parsed === undefined) return { schema: RULES_SOURCE_SCHEMA, rules: [] };
	if (typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new Error(`${file}: must be a YAML mapping with a "rules:" list, got ${Array.isArray(parsed) ? 'a list' : typeof parsed}`);
	}
	if (parsed.schema !== RULES_SOURCE_SCHEMA) {
		throw new Error(`${file}: expected \`schema: ${RULES_SOURCE_SCHEMA}\` at the top of the file, got ${parsed.schema === undefined ? '(nothing)' : JSON.stringify(parsed.schema)}`);
	}
	if (parsed.rules !== undefined && !Array.isArray(parsed.rules)) {
		throw new Error(`${file}: "rules" must be a list, got ${typeof parsed.rules}`);
	}
	return { schema: parsed.schema, rules: parsed.rules ?? [] };
}

export function loadRulesArtifact(root, featureId) {
	const file = rulesArtifactPath(root, featureId);
	const parsed = readJsonIfExists(file);
	if (parsed === null) return null;
	const { ok, errors } = validateAgainstSchema('feature-rules.schema.json', parsed);
	if (!ok) {
		throw new Error(`${file}: does not match schemas/feature-rules.schema.json:\n${formatSchemaErrors(errors).join('\n')}`);
	}
	return parsed;
}

export function saveRulesArtifact(root, featureId, artifact) {
	const { ok, errors } = validateAgainstSchema('feature-rules.schema.json', artifact);
	if (!ok) {
		throw new Error(`refusing to write an invalid rules artifact for "${featureId}":\n${formatSchemaErrors(errors).join('\n')}`);
	}
	const file = rulesArtifactPath(root, featureId);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	// Tab-indented + trailing newline, matching every other generated JSON artifact in this repo
	// (observe's own <feature>.observed-schema.json uses exactly this). Byte-stable across runs so
	// a no-op recompile leaves the file untouched and the `rules` gate stays green.
	writeFileAtomic(file, `${JSON.stringify(artifact, null, '\t')}\n`);
	return artifact;
}

// A starter rules.yaml, written only when the user explicitly asks for one and only when no file
// exists. Deliberately contains ZERO real rules -- every example is commented out. Writing a live
// rule here would be `bskel` inventing a constraint about the user's domain, exactly the line
// D-greenfield-parameters draws ("does the generated file encode a claim about the user's domain
// that the user did not state?").
export function starterRulesSource(featureId) {
	return `# Business rules for ${featureId}.
#
# Compiled by \`bskel rules check --feature ${featureId}\` into
# specs/${featureId}/rules/${featureId}.rules.json, which is what the generated
# runtime checkers actually execute. Nothing here is enforced until you run that command.
#
# Constraints your OpenAPI document already states (minLength, maximum, enum, ...) are picked up
# AUTOMATICALLY from the contract -- you do not need to repeat them here. This file is only for
# the rules no schema keyword can express.
schema: ${RULES_SOURCE_SCHEMA}
rules: []
#
# Uncomment and adapt any of these -- then run \`bskel rules check --feature ${featureId}\`, which
# verifies every pointer, type, and enum state against your own contract before compiling.
#
#  - id: end-after-start
#    kind: cross
#    operation: createBooking
#    pointers: [/startDate, /endDate]
#    assert: lt
#    reason: "a booking cannot end before it starts"
#
#  - id: publish-flow
#    kind: transition
#    operation: updateArticle
#    pointer: /status
#    from: [draft]
#    to: [published, archived]
#    reason: "an article may only be published or archived out of draft"
#
#  - id: discount-cap
#    kind: field
#    operation: createOrder
#    pointer: /discountPercent
#    assert: maximum
#    value: 50
#    reason: "policy cap, not expressible in the public API schema"
`;
}
