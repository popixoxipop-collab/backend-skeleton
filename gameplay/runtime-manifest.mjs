// G6-C: fail-closed ownership manifests for an Unreal gameplay runtime. A loop's contract and
// plan are immutable inputs; the manifest names every project-local compiler/editor script and
// every shared target that an eventual `gameplay emit --loop` is allowed to change. No code here
// executes Python or UE -- execution comes only after this boundary has proved unambiguous.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

const RUNTIME_SUFFIX = '.runtime.json';
const RUNTIME_SCHEMA_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'schemas', 'gameplay-runtime.schema.json');

let validator = null;

export class GameRuntimeManifestError extends Error {
	constructor(message, { file = null, errors = [] } = {}) {
		super(message);
		this.name = 'GameRuntimeManifestError';
		this.file = file;
		this.errors = errors;
	}
}

function getValidator() {
	if (validator) return validator;
	const ajv = new Ajv2020({ allErrors: true, strict: false });
	validator = ajv.compile(JSON.parse(fs.readFileSync(RUNTIME_SCHEMA_PATH, 'utf8')));
	return validator;
}

function schemaErrors(errors) {
	return (errors ?? []).map((error) => `${error.instancePath || '(root)'} ${error.message}`);
}

function walkRuntimeManifests(root, dir, files) {
	if (!fs.existsSync(dir)) return;
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const candidate = path.join(dir, entry.name);
		if (entry.isDirectory()) walkRuntimeManifests(root, candidate, files);
		else if (entry.isFile() && entry.name.endsWith(RUNTIME_SUFFIX)) files.push(path.relative(root, candidate));
	}
}

export function listGameRuntimeManifestFiles(repoRoot) {
	const files = [];
	walkRuntimeManifests(repoRoot, path.join(repoRoot, 'specs'), files);
	return files.sort((left, right) => left.localeCompare(right));
}

function assertCanonicalPath(repoRoot, file, manifest) {
	const parts = file.split(path.sep);
	if (parts.length !== 4 || parts[0] !== 'specs' || parts[1] !== manifest.loop_id || parts[2] !== 'runtime' || parts[3] !== `${manifest.loop_id}.runtime.json`) {
		throw new GameRuntimeManifestError(`gameplay runtime manifest path "${file}" must be specs/<loop_id>/runtime/<loop_id>.runtime.json`, { file });
	}
	const absolute = path.resolve(repoRoot, file);
	const root = `${path.resolve(repoRoot)}${path.sep}`;
	if (!absolute.startsWith(root)) throw new GameRuntimeManifestError(`gameplay runtime manifest path escapes repo root: "${file}"`, { file });
}

function resolveExistingFile(repoRoot, relative, label, file) {
	if (path.isAbsolute(relative) || path.win32.isAbsolute(relative) || relative.split('/').some((part) => part === '.' || part === '..')) {
		throw new GameRuntimeManifestError(`${label} must be a repository-relative path without . or ..: "${relative}"`, { file });
	}
	const absolute = path.resolve(repoRoot, ...relative.split('/'));
	const root = `${path.resolve(repoRoot)}${path.sep}`;
	if (!absolute.startsWith(root) || !fs.existsSync(absolute)) {
		throw new GameRuntimeManifestError(`${label} does not name an existing file inside the repository: "${relative}"`, { file });
	}
	return relative.split('/').join(path.sep);
}

function normalizeWrite(write, { file, label }) {
	if (write.kind === 'file') {
		if (path.isAbsolute(write.path) || path.win32.isAbsolute(write.path) || write.path.split('/').some((part) => part === '.' || part === '..')) {
			throw new GameRuntimeManifestError(`${label} file write path must be repository-relative without . or ..: "${write.path}"`, { file });
		}
		return { kind: 'file', path: write.path.split('/').join(path.sep) };
	}
	if (!write.path.startsWith('/Game/')) throw new GameRuntimeManifestError(`${label} UE asset path must start with /Game/: "${write.path}"`, { file });
	return { kind: 'ue-asset', path: write.path };
}

function normalizeResultFile(resultFile, { file, label }) {
	if (path.isAbsolute(resultFile) || path.win32.isAbsolute(resultFile) || resultFile.split('/').some((part) => part === '.' || part === '..')) {
		throw new GameRuntimeManifestError(`${label} must be a repository-relative path without . or ..: "${resultFile}"`, { file });
	}
	return resultFile.split('/').join(path.sep);
}

function normalizeStep(repoRoot, step, index, file, kind) {
	const writesOrReads = kind === 'emit' ? 'writes' : 'reads';
	return {
		id: step.id,
		script: resolveExistingFile(repoRoot, step.script, `${kind}_steps[${index}].script`, file),
		args: step.args.map((arg, argIndex) => normalizeResultFile(arg, { file, label: `${kind}_steps[${index}].args[${argIndex}]` })),
		result_file: normalizeResultFile(step.result_file, { file, label: `${kind}_steps[${index}].result_file` }),
		[writesOrReads]: step[writesOrReads].map((write, writeIndex) => normalizeWrite(write, { file, label: `${kind}_steps[${index}].${writesOrReads}[${writeIndex}]` })),
	};
}

function normalizeManifest(repoRoot, raw, file) {
	const validate = getValidator();
	if (!validate(raw)) {
		const errors = schemaErrors(validate.errors);
		throw new GameRuntimeManifestError(`invalid gameplay runtime manifest at ${file}: ${errors.join('; ')}`, { file, errors });
	}
	assertCanonicalPath(repoRoot, file, raw);
	const compiler = {
		script: resolveExistingFile(repoRoot, raw.compiler.script, 'compiler.script', file),
		world_anchors: resolveExistingFile(repoRoot, raw.compiler.world_anchors, 'compiler.world_anchors', file),
		output: raw.compiler.output.split('/').join(path.sep),
	};
	const expectedOutput = path.join('specs', raw.loop_id, 'game_plan.json');
	if (compiler.output !== expectedOutput) {
		throw new GameRuntimeManifestError(`compiler.output must be "${expectedOutput}" for loop "${raw.loop_id}"`, { file });
	}
	const runtime = {
		project_file: resolveExistingFile(repoRoot, raw.runtime.project_file, 'runtime.project_file', file),
		exclusive_session: raw.runtime.exclusive_session,
		emit_steps: raw.runtime.emit_steps.map((step, index) => normalizeStep(repoRoot, step, index, file, 'emit')),
		verify_steps: raw.runtime.verify_steps.map((step, index) => normalizeStep(repoRoot, step, index, file, 'verify')),
	};
	const ids = new Set();
	for (const step of [...runtime.emit_steps, ...runtime.verify_steps]) {
		if (ids.has(step.id)) throw new GameRuntimeManifestError(`runtime step id "${step.id}" is declared more than once`, { file });
		ids.add(step.id);
	}
	return {
		schema: 'sbf.gameplay-runtime/1',
		file,
		loop_id: raw.loop_id,
		compiler,
		runtime,
		summary: {
			emit_step_count: runtime.emit_steps.length,
			verify_step_count: runtime.verify_steps.length,
			write_target_count: runtime.emit_steps.reduce((count, step) => count + step.writes.length, 0),
		},
	};
}

function assertWriteOwnership(manifests) {
	const owners = new Map();
	for (const manifest of manifests) {
		for (const step of manifest.runtime.emit_steps) {
			for (const write of step.writes) {
				const key = `${write.kind}:${write.path}`;
				const existing = owners.get(key);
				if (existing && existing.exclusive_session !== manifest.runtime.exclusive_session) {
					throw new GameRuntimeManifestError(`write target "${write.path}" is claimed by loops "${existing.loop_id}" and "${manifest.loop_id}" with different exclusive_session values`, { file: manifest.file });
				}
				owners.set(key, { loop_id: manifest.loop_id, exclusive_session: manifest.runtime.exclusive_session });
			}
		}
	}
}

// contracts is passed from the game-contract parser so manifest validation cannot quietly bless a
// loop whose source contract was never shape/reference-checked in this process.
export function readGameRuntimeManifests(repoRoot, { contracts = [] } = {}) {
	const knownLoops = new Set(contracts.map((contract) => contract.loop_id));
	const files = listGameRuntimeManifestFiles(repoRoot);
	const manifests = files.map((file) => {
		let raw;
		try {
			raw = JSON.parse(fs.readFileSync(path.join(repoRoot, file), 'utf8'));
		} catch (error) {
			throw new GameRuntimeManifestError(`could not read gameplay runtime manifest "${file}": ${error.message}`, { file });
		}
		const manifest = normalizeManifest(repoRoot, raw, file);
		if (!knownLoops.has(manifest.loop_id)) throw new GameRuntimeManifestError(`runtime manifest loop_id "${manifest.loop_id}" has no validated game contract`, { file });
		return manifest;
	});
	const loopIds = new Set();
	for (const manifest of manifests) {
		if (loopIds.has(manifest.loop_id)) throw new GameRuntimeManifestError(`loop_id "${manifest.loop_id}" has more than one runtime manifest`, { file: manifest.file });
		loopIds.add(manifest.loop_id);
	}
	assertWriteOwnership(manifests);
	return { manifests, files_read: files };
}
