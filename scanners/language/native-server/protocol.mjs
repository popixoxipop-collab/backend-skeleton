import { TextDecoder } from 'node:util';

export const NATIVE_SERVER_PROTOCOL = 'bskel.native-language/1';
export const DEFAULT_BUDGET = Object.freeze({
	maxInputBytes: 4 * 1024 * 1024,
	maxOutputBytes: 4 * 1024 * 1024,
	maxDiagnostics: 1_000,
	maxRoutes: 20_000,
	wallTimeMs: 30_000,
});

const MESSAGE_KINDS = new Set(['analyze-request', 'analyze-response', 'error']);
const LANGUAGES = new Set(['go', 'csharp', 'rust']);
const FATAL_UTF8 = new TextDecoder('utf-8', { fatal: true });

function integerWithin(value, fallback, min, max) {
	if (value == null) return fallback;
	if (!Number.isSafeInteger(value) || value < min || value > max) {
		throw new TypeError(`budget value must be a safe integer in [${min}, ${max}]`);
	}
	return value;
}

export function normalizeBudget(input = {}) {
	if (input == null || typeof input !== 'object' || Array.isArray(input)) {
		throw new TypeError('budget must be an object');
	}
	return Object.freeze({
		maxInputBytes: integerWithin(input.maxInputBytes, DEFAULT_BUDGET.maxInputBytes, 1, 64 * 1024 * 1024),
		maxOutputBytes: integerWithin(input.maxOutputBytes, DEFAULT_BUDGET.maxOutputBytes, 1, 64 * 1024 * 1024),
		maxDiagnostics: integerWithin(input.maxDiagnostics, DEFAULT_BUDGET.maxDiagnostics, 0, 100_000),
		maxRoutes: integerWithin(input.maxRoutes, DEFAULT_BUDGET.maxRoutes, 0, 1_000_000),
		wallTimeMs: integerWithin(input.wallTimeMs, DEFAULT_BUDGET.wallTimeMs, 1, 10 * 60_000),
	});
}

function validateSourceRef(source) {
	if (!source || typeof source !== 'object' || Array.isArray(source)) throw new TypeError('route source must be an object');
	if (typeof source.file !== 'string' || !source.file || source.file.includes('\0')) throw new TypeError('route source.file must be a non-empty logical path');
	if (source.line != null && (!Number.isSafeInteger(source.line) || source.line < 1)) throw new TypeError('route source.line must be null or a positive safe integer');
	if (!Number.isSafeInteger(source.index) || source.index < 0) throw new TypeError('route source.index must be a non-negative safe integer');
}

function validateRoute(route) {
	if (!route || typeof route !== 'object' || Array.isArray(route)) throw new TypeError('route fact must be an object');
	if (typeof route.method !== 'string' || !/^[A-Z]+$/.test(route.method)) throw new TypeError('route method must be an uppercase token');
	if (typeof route.path !== 'string' || !route.path.startsWith('/')) throw new TypeError('route path must be an absolute literal path');
	if (route.handler != null && (typeof route.handler !== 'string' || !route.handler)) throw new TypeError('route handler must be null or a non-empty string');
	if (typeof route.framework !== 'string' || !route.framework) throw new TypeError('route framework must be a non-empty string');
	if (typeof route.confidence !== 'string' || !route.confidence) throw new TypeError('route confidence must be a non-empty string');
	validateSourceRef(route.source);
}

function validateDiagnostic(diagnostic) {
	if (!diagnostic || typeof diagnostic !== 'object' || Array.isArray(diagnostic)) throw new TypeError('diagnostic must be an object');
	if (typeof diagnostic.code !== 'string' || !diagnostic.code) throw new TypeError('diagnostic code must be a non-empty string');
	if (!['unknown', 'warning', 'error', 'info'].includes(diagnostic.severity)) throw new TypeError('diagnostic severity is invalid');
	if (typeof diagnostic.file !== 'string' || !diagnostic.file || diagnostic.file.includes('\0')) throw new TypeError('diagnostic file must be a non-empty logical path');
	if (diagnostic.line != null && (!Number.isSafeInteger(diagnostic.line) || diagnostic.line < 1)) throw new TypeError('diagnostic line must be null or a positive safe integer');
	if (typeof diagnostic.message !== 'string' || !diagnostic.message) throw new TypeError('diagnostic message must be a non-empty string');
}

export function validateMessage(message) {
	if (!message || typeof message !== 'object' || Array.isArray(message)) throw new TypeError('protocol message must be an object');
	if (message.protocol !== NATIVE_SERVER_PROTOCOL) throw new TypeError(`unsupported protocol ${JSON.stringify(message.protocol)}`);
	if (!MESSAGE_KINDS.has(message.kind)) throw new TypeError(`unsupported message kind ${JSON.stringify(message.kind)}`);
	if (typeof message.requestId !== 'string' || message.requestId.length === 0 || message.requestId.length > 256) {
		throw new TypeError('requestId must be a non-empty string of at most 256 characters');
	}
	if (message.kind === 'analyze-request') {
		if (!LANGUAGES.has(message.language)) throw new TypeError(`unsupported language ${JSON.stringify(message.language)}`);
		if (typeof message.file !== 'string' || !message.file || message.file.includes('\0')) throw new TypeError('file must be a non-empty logical path');
		if (typeof message.source !== 'string') throw new TypeError('source must be a string');
		normalizeBudget(message.budget ?? {});
	}
	if (message.kind === 'analyze-response') {
		if (!LANGUAGES.has(message.language)) throw new TypeError(`unsupported language ${JSON.stringify(message.language)}`);
		if (!Array.isArray(message.routes) || !Array.isArray(message.diagnostics)) throw new TypeError('analyze-response requires routes[] and diagnostics[]');
		for (const route of message.routes) validateRoute(route);
		for (const diagnostic of message.diagnostics) validateDiagnostic(diagnostic);
		if (typeof message.backend !== 'string' || !message.backend) throw new TypeError('analyze-response backend must be a non-empty string');
		if (message.groups != null && !Array.isArray(message.groups)) throw new TypeError('analyze-response groups must be an array when present');
		if (message.limitations != null && (!Array.isArray(message.limitations) || message.limitations.some((x) => typeof x !== 'string'))) throw new TypeError('analyze-response limitations must be string[] when present');
	}
	if (message.kind === 'error' && (typeof message.code !== 'string' || typeof message.message !== 'string')) {
		throw new TypeError('error messages require string code and message');
	}
	return message;
}

export function encodeNdjson(message, budgetInput = {}) {
	validateMessage(message);
	const budget = normalizeBudget(budgetInput);
	const line = JSON.stringify(message) + '\n';
	const bytes = Buffer.byteLength(line, 'utf8');
	if (bytes > budget.maxOutputBytes) throw new RangeError(`encoded protocol message exceeds maxOutputBytes (${bytes} > ${budget.maxOutputBytes})`);
	return line;
}

export function decodeNdjsonLine(input, budgetInput = {}) {
	const budget = normalizeBudget(budgetInput);
	const bytes = Buffer.isBuffer(input) || input instanceof Uint8Array ? Buffer.from(input) : Buffer.from(String(input), 'utf8');
	if (bytes.length > budget.maxInputBytes) throw new RangeError(`protocol input exceeds maxInputBytes (${bytes.length} > ${budget.maxInputBytes})`);
	let text;
	try {
		text = FATAL_UTF8.decode(bytes);
	} catch {
		throw new TypeError('protocol input is not valid UTF-8');
	}
	let trimmed = text;
	if (trimmed.endsWith('\r\n')) trimmed = trimmed.slice(0, -2);
	else if (trimmed.endsWith('\n')) trimmed = trimmed.slice(0, -1);
	if (!trimmed || trimmed.includes('\n') || trimmed.includes('\r')) throw new TypeError('decodeNdjsonLine expects exactly one non-empty JSON line');
	let message;
	try {
		message = JSON.parse(trimmed);
	} catch (err) {
		throw new TypeError(`protocol input is not valid JSON: ${err.message}`);
	}
	return validateMessage(message);
}
