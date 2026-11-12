#!/usr/bin/env node
// Read-only consumer of the admitted T10 source providers and the real T07 fact producer.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { adapter as spring } from '../adapters/java-spring.mjs';
import { adapter as fastapi } from '../adapters/python-fastapi.mjs';
import { adapter as express } from '../adapters/typescript-express.mjs';
import { adapter as rails } from '../adapters/ruby-rails.mjs';
import { extractActiveRecordModelFacts, extractEloquentModelFacts } from '../language/ruby-php/model-facts.mjs';
import { fromLegacyAdapterScan } from './legacy.mjs';
import { fromRubyPhpModelFacts } from './model-facts-bridge.mjs';
import { scanPersistenceProvider } from './providers/registry.mjs';

const ADAPTERS = new Map([spring, fastapi, express, rails].map((adapter) => [adapter.id, adapter]));
const MODEL_EXTRACTORS = new Map([
	['rails', extractActiveRecordModelFacts],
	['laravel', extractEloquentModelFacts],
]);

function projectDirectory(root) {
	if (typeof root !== 'string' || !root) throw new TypeError('project root is required');
	const resolved = fs.realpathSync(root);
	if (!fs.statSync(resolved).isDirectory()) throw new TypeError('project root must be a directory');
	return resolved;
}

function sourceFile(root, relativeFile) {
	if (typeof relativeFile !== 'string' || !relativeFile || path.isAbsolute(relativeFile)) throw new TypeError('model file must be repository-relative');
	const parts = relativeFile.replaceAll('\\', '/').split('/');
	if (parts.some((part) => !part || part === '.' || part === '..')) throw new TypeError('model file must stay within project root');
	const file = fs.realpathSync(path.join(root, ...parts));
	if (!file.startsWith(`${root}${path.sep}`) || !fs.statSync(file).isFile()) throw new TypeError('model file must be a regular file within project root');
	return { file, relativeFile: parts.join('/') };
}

export function observePersistenceProject({ projectRoot, provider = null, adapter = null, modelFramework = null, modelFile = null }) {
	const root = projectDirectory(projectRoot);
	const selected = [provider, adapter, modelFramework].filter(Boolean);
	if (selected.length !== 1) throw new TypeError('select exactly one of provider, adapter, or modelFramework');
	if (modelFile && !modelFramework) throw new TypeError('modelFile requires modelFramework');
	if (provider) return scanPersistenceProvider(provider, root);
	if (adapter) {
		const implementation = ADAPTERS.get(adapter);
		if (!implementation) throw new TypeError(`unknown legacy adapter: ${adapter}`);
		const detected = implementation.detect(root);
		if (!detected) throw new Error(`adapter ${adapter} did not detect a project at ${root}`);
		return fromLegacyAdapterScan({ adapterId: adapter, scan: implementation.scan(root, detected), repoRoot: root });
	}
	const extractor = MODEL_EXTRACTORS.get(modelFramework);
	if (!extractor) throw new TypeError(`unknown model-facts framework: ${modelFramework}`);
	if (!modelFile) throw new TypeError('modelFile is required with modelFramework');
	const source = sourceFile(root, modelFile);
	const facts = extractor(fs.readFileSync(source.file, 'utf8'), { file: source.relativeFile });
	return fromRubyPhpModelFacts(facts);
}

export function runObserveCli(argv, output = process.stdout) {
	if (!['--provider', '--adapter', '--model-facts'].includes(argv[1]) || argv.length !== (argv[1] === '--model-facts' ? 4 : 3)) {
		throw new TypeError('usage: node observe-cli.mjs <project-root> --provider <id> | <project-root> --adapter <id> | <project-root> --model-facts <rails|laravel> <relative-model-file>');
	}
	const [projectRoot, mode, id, modelFile] = argv;
	if (mode !== '--model-facts' && modelFile !== undefined) throw new TypeError('model file is only valid with --model-facts');
	if (mode === '--model-facts' && !modelFile) throw new TypeError('model file is required with --model-facts');
	const ir = observePersistenceProject({
		projectRoot,
		...(mode === '--provider' ? { provider: id } : mode === '--adapter' ? { adapter: id } : { modelFramework: id, modelFile }),
	});
	output.write(`${JSON.stringify(ir)}\n`);
	return ir;
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
	try { runObserveCli(process.argv.slice(2)); }
	catch (error) { console.error(error?.message ?? String(error)); process.exitCode = 2; }
}
