// G4: zero-registration codegen provider discovery -- mirrors scanners/registry.mjs's exact
// mechanism (D-adapter-registry, G1), with one deliberate difference: a provider is selected by
// EXACT id match against scanReport.adapter (bin/bskel.mjs), never arbitrated by specificity --
// there is nothing to arbitrate since selection is 1:1, not "which of these best matches this
// repo". See D-handles-providers in DECISIONS.md.
//
// SECURITY: `loadProviders({providersDir})` below is a test seam ONLY -- same rule as scanners/
// registry.mjs's loadAdapters, never wire it to a CLI flag or environment variable.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

const REGISTRY_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROVIDERS_DIR = path.join(REGISTRY_DIR, 'providers');
const SCHEMAS_ROOT = path.join(REGISTRY_DIR, '..', 'schemas');
const SUPPORTED_CONTRACT = 'sbf.handles-provider/1';

let _ajv = null;
function ajv() {
	if (!_ajv) _ajv = new Ajv2020({ allErrors: true, strict: false });
	return _ajv;
}

function loadProviderSchema() {
	return JSON.parse(fs.readFileSync(path.join(SCHEMAS_ROOT, 'handles-provider.schema.json'), 'utf8'));
}

// Filenames only -- `providers/<id>/` implementation directories don't end in .mjs so they're
// naturally excluded, no special-casing needed. Same O6-style determinism (.sort()) and `_`/`.`
// skip convention as scanners/registry.mjs's candidateFiles.
function candidateFiles(dir) {
	if (!fs.existsSync(dir)) return [];
	return fs.readdirSync(dir)
		.filter((name) => name.endsWith('.mjs') && !name.startsWith('_') && !name.startsWith('.'))
		.sort()
		.map((name) => path.join(dir, name));
}

async function loadOneProvider(file, schema) {
	const id = path.basename(file, '.mjs');
	let mod;
	try {
		mod = await import(pathToFileURL(file).href);
	} catch (err) {
		return { error: { file, message: `failed to load: ${err.message}` } };
	}
	const descriptor = mod.provider;
	if (!descriptor || typeof descriptor !== 'object') {
		return { error: { file, message: 'must `export const provider = {...}` (sbf.handles-provider/1 shape) -- no such export found' } };
	}
	if (descriptor.contract !== SUPPORTED_CONTRACT) {
		return { error: { file, message: `declares contract "${descriptor.contract}" -- this build only understands "${SUPPORTED_CONTRACT}"` } };
	}
	if (descriptor.id !== id) {
		return { error: { file, message: `provider.id "${descriptor.id}" must equal its filename "${id}"` } };
	}
	const { plan, emit, ...jsonShape } = descriptor;
	const validateFn = ajv().getSchema(schema.$id) ?? ajv().compile(schema);
	if (!validateFn(jsonShape)) {
		const details = (validateFn.errors ?? []).map((e) => `${e.instancePath || '(root)'} ${e.message}`).join('; ');
		return { error: { file, message: `does not match schemas/handles-provider.schema.json: ${details}` } };
	}
	for (const fnName of ['plan', 'emit']) {
		if (typeof descriptor[fnName] !== 'function') {
			return { error: { file, message: `provider.${fnName} must be a function` } };
		}
	}
	return { provider: descriptor };
}

export async function loadProviders({ providersDir = PROVIDERS_DIR } = {}) {
	const schema = loadProviderSchema();
	const providers = [];
	const errors = [];
	for (const file of candidateFiles(providersDir)) {
		const result = await loadOneProvider(file, schema);
		if (result.error) errors.push(result.error);
		else providers.push(result.provider);
	}
	return { providers, errors };
}

export function providerById(providers, id) {
	return providers.find((p) => p.id === id) ?? null;
}

// Top-level await -- see scanners/registry.mjs's identical note for why this is safe. bin/bskel.mjs's
// cmdHandlesPlan/cmdHandlesEmit stay synchronous callers of PROVIDERS.
export const { providers: PROVIDERS, errors: PROVIDER_LOAD_ERRORS } = await loadProviders();
