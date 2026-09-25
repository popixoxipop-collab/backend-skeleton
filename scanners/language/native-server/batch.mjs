import { analyzeGoGinSource } from './go.mjs';
import { analyzeCSharpAspNetSource } from './csharp.mjs';
import { analyzeRustServerSource } from './rust.mjs';

const BATCH_ANALYZERS = Object.freeze({
	go: analyzeGoGinSource,
	csharp: analyzeCSharpAspNetSource,
	rust: analyzeRustServerSource,
});

function analyzeOne(language, source, file) {
	const analyze = BATCH_ANALYZERS[language];
	if (!analyze) throw new TypeError(`batch language is not implemented: ${JSON.stringify(language)}`);
	return analyze(source, { file });
}

export const DEFAULT_BATCH_LIMITS = Object.freeze({
	maxFiles: 4096,
	maxTotalBytes: 16 * 1024 * 1024,
});

function integerLimit(value, fallback, max, name) {
	if (value == null) return fallback;
	if (!Number.isSafeInteger(value) || value < 1 || value > max) {
		throw new RangeError(`${name} must be a safe integer in [1, ${max}]`);
	}
	return value;
}

function logicalFile(value) {
	if (typeof value !== 'string' || !value || /[\0\r\n]/.test(value)) {
		throw new TypeError('batch file must be a non-empty single-line logical path');
	}
	return value;
}

function routeOrder(a, b) {
	return a.source.file.localeCompare(b.source.file)
		|| a.source.index - b.source.index
		|| a.method.localeCompare(b.method)
		|| a.path.localeCompare(b.path);
}

function diagnosticOrder(a, b) {
	return a.file.localeCompare(b.file)
		|| (a.line ?? Number.MAX_SAFE_INTEGER) - (b.line ?? Number.MAX_SAFE_INTEGER)
		|| a.code.localeCompare(b.code)
		|| a.message.localeCompare(b.message);
}

export function analyzeNativeServerFiles({
	language,
	files,
	limits = {},
} = {}) {
	if (typeof language !== 'string' || !language) throw new TypeError('language must be a non-empty string');
	if (!Array.isArray(files) || files.length === 0) throw new TypeError('files must be a non-empty array');
	if (limits == null || typeof limits !== 'object' || Array.isArray(limits)) throw new TypeError('limits must be an object');

	const maxFiles = integerLimit(limits.maxFiles, DEFAULT_BATCH_LIMITS.maxFiles, DEFAULT_BATCH_LIMITS.maxFiles, 'maxFiles');
	const maxTotalBytes = integerLimit(limits.maxTotalBytes, DEFAULT_BATCH_LIMITS.maxTotalBytes, DEFAULT_BATCH_LIMITS.maxTotalBytes, 'maxTotalBytes');
	if (files.length > maxFiles) throw new RangeError(`batch file count exceeds maxFiles (${files.length} > ${maxFiles})`);

	const seen = new Set();
	const normalized = [];
	let totalBytes = 0;
	for (let index = 0; index < files.length; index++) {
		const entry = files[index];
		if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new TypeError(`files[${index}] must be an object`);
		const file = logicalFile(entry.file);
		if (seen.has(file)) throw new TypeError(`duplicate batch logical path ${JSON.stringify(file)}`);
		seen.add(file);
		if (typeof entry.source !== 'string') throw new TypeError(`files[${index}].source must be a string`);
		const bytes = Buffer.byteLength(entry.source, 'utf8');
		totalBytes += bytes;
		if (totalBytes > maxTotalBytes) {
			throw new RangeError(`batch source bytes exceed maxTotalBytes (${totalBytes} > ${maxTotalBytes})`);
		}
		normalized.push({ file, source: entry.source, inputIndex: index, bytes });
	}

	// Input ordering is not semantic. Sort before analysis so filesystem/listing order cannot
	// change the aggregate result. Source spans remain per-file byte/string offsets.
	normalized.sort((a, b) => a.file.localeCompare(b.file));

	const routes = [];
	const diagnostics = [];
	const fileResults = [];
	const frameworks = new Set();
	const limitations = new Set();
	for (const entry of normalized) {
		const result = analyzeOne(language, entry.source, entry.file);
		routes.push(...result.routes);
		diagnostics.push(...result.diagnostics);
		if (result.framework) frameworks.add(result.framework);
		for (const limitation of result.limitations ?? []) limitations.add(limitation);
		fileResults.push({
			file: entry.file,
			bytes: entry.bytes,
			framework: result.framework,
			route_count: result.routes.length,
			diagnostic_count: result.diagnostics.length,
		});
	}

	routes.sort(routeOrder);
	diagnostics.sort(diagnosticOrder);
	const frameworkList = [...frameworks].sort();
	return {
		language,
		file_count: normalized.length,
		total_bytes: totalBytes,
		frameworks: frameworkList,
		routes,
		diagnostics,
		files: fileResults,
		limitations: [...limitations].sort(),
		notes: [
			'Batch aggregation is source-file scoped and deterministic; it does not assign project ownership or operation identity.',
			'Duplicate method/path facts across files are preserved for later project/reconciliation layers rather than deduplicated here.',
		],
	};
}
