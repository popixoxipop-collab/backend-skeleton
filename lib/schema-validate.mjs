// S5 (D-persistence-integrity): validates this tool's own persisted JSON documents against their
// declared schemas at read/write boundaries. Separate singleton from contracts/validate.mjs's own
// ajv() -- that one validates runtime AGENT ENVELOPES against a per-feature contract (a different
// concern), and lib/ importing from contracts/ would be a backwards dependency direction (contracts/
// already imports from lib/, see bin/bskel.mjs's import graph).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMAS_ROOT = path.join(__dirname, '..', 'schemas');

let _ajv = null;
function ajv() {
	if (!_ajv) {
		_ajv = new Ajv2020({ allErrors: true, strict: false });
		try {
			addFormats(_ajv);
		} catch {
			// ajv-formats not installed -- format keywords (uuid, date-time) become no-ops rather
			// than a hard failure; structural validation below still catches everything else.
		}
	}
	return _ajv;
}

const _schemaCache = new Map();
function loadSchema(schemaFileName) {
	let schema = _schemaCache.get(schemaFileName);
	if (!schema) {
		schema = JSON.parse(fs.readFileSync(path.join(SCHEMAS_ROOT, schemaFileName), 'utf8'));
		_schemaCache.set(schemaFileName, schema);
	}
	return schema;
}

// Validates `data` against `schemas/<schemaFileName>`. Returns {ok, errors} (mirrors
// contracts/validate.mjs's validateEnvelopeStructure() return shape) rather than throwing --
// callers decide how to surface a failure (a plain Error for lib-style read functions, a
// fail()/EXIT_CODES call for CLI-layer ones), matching this codebase's existing split between
// "throws, main()'s catch-all translates it" and "already-CLI-code calls fail() directly".
export function validateAgainstSchema(schemaFileName, data) {
	const schema = loadSchema(schemaFileName);
	const validateFn = ajv().getSchema(schema.$id) ?? ajv().compile(schema);
	const ok = validateFn(data);
	return { ok, errors: ok ? [] : (validateFn.errors ?? []) };
}

// Renders ajv errors into the same "path message" shape contracts/validate.mjs's callers already
// build inline (envelope validation errors) -- centralized here so every call site formats
// consistently instead of re-deriving `${e.instancePath} ${e.message}` on its own.
export function formatSchemaErrors(errors) {
	return errors.map((e) => `${e.instancePath || '(root)'} ${e.message}`);
}
