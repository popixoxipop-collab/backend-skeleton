// T05 JVM language-analysis foundation.
//
// This is intentionally a *draft* language-layer protocol. It does not replace the existing
// sbf.adapter/2 contract and is not wired into scanners/index.mjs yet. T05 owns only the JVM
// analysis boundary here; cross-tool artifact identity remains owned by the contract track.

export const JVM_ANALYSIS_REQUEST_SCHEMA = 'sbf.jvm.analysis-request/0-draft';
export const JVM_SYNTAX_FACTS_SCHEMA = 'sbf.jvm.syntax-facts/0-draft';

const SHA256_RE = /^[0-9a-f]{64}$/;
const MODES = new Set(['syntax', 'semantic']);

function own(value, key) {
	return Object.prototype.hasOwnProperty.call(value, key);
}

export function isRepoRelativePath(value, { allowDot = false } = {}) {
	if (typeof value !== 'string' || value.length === 0) return false;
	if (value.includes('\\') || value.includes('\0')) return false;
	if (value.startsWith('/') || /^[A-Za-z]:\//.test(value)) return false;
	if (value === '.') return allowDot;
	const parts = value.split('/');
	if (parts.some((part) => part === '' || part === '.' || part === '..')) return false;
	return true;
}

function requireObject(value, label, errors) {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		errors.push(`${label} must be an object`);
		return false;
	}
	return true;
}

function validatePathList(value, label, errors, { allowEmpty = false, allowDot = false } = {}) {
	if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
		errors.push(`${label} must be ${allowEmpty ? 'an' : 'a non-empty'} array`);
		return;
	}
	const seen = new Set();
	for (const item of value) {
		if (!isRepoRelativePath(item, { allowDot })) errors.push(`${label} contains an unsafe/non-relative path: ${String(item)}`);
		if (seen.has(item)) errors.push(`${label} contains a duplicate path: ${String(item)}`);
		seen.add(item);
	}
}

// Validates the static language-analysis request. Target build/bootstrap execution is not part of
// this protocol: semantic mode means "semantic facts may be supplied by an approved helper",
// never "run Gradle/Maven while validating this request".
export function validateJvmAnalysisRequest(request) {
	const errors = [];
	if (!requireObject(request, 'request', errors)) return { ok: false, errors };

	if (request.schema !== JVM_ANALYSIS_REQUEST_SCHEMA) errors.push(`schema must be ${JVM_ANALYSIS_REQUEST_SCHEMA}`);
	if (request.language !== 'java') errors.push('language must be java in the initial T05 draft; Kotlin is a separate future profile');
	if (!Number.isInteger(request.languageLevel) || request.languageLevel < 8 || request.languageLevel > 25) {
		errors.push('languageLevel must be an integer between 8 and 25');
	}
	if (!MODES.has(request.mode)) errors.push('mode must be syntax or semantic');
	if (request.allowTargetExecution !== false) errors.push('allowTargetExecution must be exactly false');

	if (requireObject(request.project, 'project', errors)) {
		if (!isRepoRelativePath(request.project.root, { allowDot: true })) errors.push('project.root must be a repository-relative path or .');
		validatePathList(request.project.sourceRoots, 'project.sourceRoots', errors);
		validatePathList(request.project.buildFiles ?? [], 'project.buildFiles', errors, { allowEmpty: true });
	}

	if (!Array.isArray(request.files) || request.files.length === 0) {
		errors.push('files must be a non-empty array');
	} else {
		const seen = new Set();
		for (let i = 0; i < request.files.length; i++) {
			const file = request.files[i];
			if (!requireObject(file, `files[${i}]`, errors)) continue;
			if (!isRepoRelativePath(file.path)) errors.push(`files[${i}].path must be repository-relative`);
			if (!SHA256_RE.test(file.sha256 ?? '')) errors.push(`files[${i}].sha256 must be lowercase sha256 hex`);
			if (seen.has(file.path)) errors.push(`files contains a duplicate path: ${String(file.path)}`);
			seen.add(file.path);
		}
	}

	if (request.mode === 'semantic') {
		if (!SHA256_RE.test(request.classpathFingerprint ?? '')) {
			errors.push('semantic mode requires classpathFingerprint as lowercase sha256 hex');
		}
	} else if (own(request, 'classpathFingerprint')) {
		errors.push('syntax mode must not carry classpathFingerprint');
	}

	return { ok: errors.length === 0, errors };
}

function validateByteSpan(span, label, errors) {
	if (!requireObject(span, label, errors)) return;
	if (!Number.isInteger(span.start) || span.start < 0) errors.push(`${label}.start must be a non-negative integer`);
	if (!Number.isInteger(span.end) || span.end < 0) errors.push(`${label}.end must be a non-negative integer`);
	if (Number.isInteger(span.start) && Number.isInteger(span.end) && span.end < span.start) errors.push(`${label}.end must be >= start`);
}

export function validateJvmSyntaxFacts(facts) {
	const errors = [];
	if (!requireObject(facts, 'facts', errors)) return { ok: false, errors };
	if (facts.schema !== JVM_SYNTAX_FACTS_SCHEMA) errors.push(`schema must be ${JVM_SYNTAX_FACTS_SCHEMA}`);
	if (facts.language !== 'java') errors.push('language must be java');
	if (!isRepoRelativePath(facts.path)) errors.push('path must be repository-relative');
	if (!(facts.packageName === null || typeof facts.packageName === 'string')) errors.push('packageName must be string or null');
	if (!Array.isArray(facts.imports)) errors.push('imports must be an array');
	if (!Array.isArray(facts.topLevelTypes)) errors.push('topLevelTypes must be an array');
	if (!Array.isArray(facts.diagnostics)) errors.push('diagnostics must be an array');

	if (Array.isArray(facts.imports)) {
		for (let i = 0; i < facts.imports.length; i++) {
			const item = facts.imports[i];
			if (!requireObject(item, `imports[${i}]`, errors)) continue;
			if (typeof item.name !== 'string' || item.name.length === 0) errors.push(`imports[${i}].name must be non-empty`);
			if (typeof item.static !== 'boolean' || typeof item.wildcard !== 'boolean') errors.push(`imports[${i}] static/wildcard must be booleans`);
			validateByteSpan(item.byteSpan, `imports[${i}].byteSpan`, errors);
		}
	}

	if (Array.isArray(facts.topLevelTypes)) {
		const allowedKinds = new Set(['class', 'record', 'interface', 'enum', 'annotation']);
		for (let i = 0; i < facts.topLevelTypes.length; i++) {
			const type = facts.topLevelTypes[i];
			if (!requireObject(type, `topLevelTypes[${i}]`, errors)) continue;
			if (!allowedKinds.has(type.kind)) errors.push(`topLevelTypes[${i}].kind is unsupported`);
			if (typeof type.name !== 'string' || type.name.length === 0) errors.push(`topLevelTypes[${i}].name must be non-empty`);
			for (const field of ['annotations', 'modifiers', 'extendsTypes', 'implementsTypes', 'permitsTypes']) {
				if (!Array.isArray(type[field])) errors.push(`topLevelTypes[${i}].${field} must be an array`);
			}
			validateByteSpan(type.byteSpan, `topLevelTypes[${i}].byteSpan`, errors);
		}
	}
	return { ok: errors.length === 0, errors };
}
