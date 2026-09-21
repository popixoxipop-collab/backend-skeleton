// G6-B: zero-registration discovery for gameplay planners/providers. This deliberately mirrors
// handles/registry.mjs, but requires only plan() for now: an installed read-only planner must not
// be mistaken for an Unreal artifact emitter or cause codegen.gameplay to become true.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

const REGISTRY_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROVIDERS_DIR = path.join(REGISTRY_DIR, 'providers');
const SCHEMAS_ROOT = path.join(REGISTRY_DIR, '..', 'schemas');
const SUPPORTED_CONTRACT = 'sbf.gameplay-provider/1';

let _ajv = null;
function ajv() {
	if (!_ajv) _ajv = new Ajv2020({ allErrors: true, strict: false });
	return _ajv;
}

function loadProviderSchema() {
	return JSON.parse(fs.readFileSync(path.join(SCHEMAS_ROOT, 'gameplay-provider.schema.json'), 'utf8'));
}

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
		return { error: { file, message: 'must `export const provider = {...}` (sbf.gameplay-provider/1 shape) -- no such export found' } };
	}
	if (descriptor.contract !== SUPPORTED_CONTRACT) {
		return { error: { file, message: `declares contract "${descriptor.contract}" -- this build only understands "${SUPPORTED_CONTRACT}"` } };
	}
	if (descriptor.id !== id) {
		return { error: { file, message: `provider.id "${descriptor.id}" must equal its filename "${id}"` } };
	}
	const { plan, ...jsonShape } = descriptor;
	const validate = ajv().getSchema(schema.$id) ?? ajv().compile(schema);
	if (!validate(jsonShape)) {
		const details = (validate.errors ?? []).map((error) => `${error.instancePath || '(root)'} ${error.message}`).join('; ');
		return { error: { file, message: `does not match schemas/gameplay-provider.schema.json: ${details}` } };
	}
	if (typeof plan !== 'function') return { error: { file, message: 'provider.plan must be a function' } };
	return { provider: descriptor };
}

export async function loadGameplayProviders({ providersDir = PROVIDERS_DIR } = {}) {
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

export function gameplayProviderById(providers, id) {
	return providers.find((provider) => provider.id === id) ?? null;
}

export const { providers: GAMEPLAY_PROVIDERS, errors: GAMEPLAY_PROVIDER_LOAD_ERRORS } = await loadGameplayProviders();
