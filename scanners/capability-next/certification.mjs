export const SUPPORT_LEVELS = Object.freeze(['discovery', 'contract', 'runtime-tested']);
export const CODEGEN_STATES = Object.freeze(['none', 'scaffold', 'build-tested', 'behavior-tested']);

const SUPPORT_SET = new Set(SUPPORT_LEVELS);
const CODEGEN_SET = new Set(CODEGEN_STATES);

function nonEmpty(value, name) {
	if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${name} must be a non-empty string`);
	return value;
}

function uniqueStrings(values, name) {
	if (!Array.isArray(values)) throw new TypeError(`${name} must be an array`);
	for (const [index, value] of values.entries()) nonEmpty(value, `${name}[${index}]`);
	if (new Set(values).size !== values.length) throw new TypeError(`${name} must not contain duplicates`);
	return Object.freeze([...values].sort());
}

export function certificationRecord({
	targetId, level, codegen = 'none', capabilities = [], evidenceRefs = [], limitations = [], profile = null,
} = {}) {
	nonEmpty(targetId, 'targetId');
	if (!SUPPORT_SET.has(level)) throw new TypeError(`level must be one of: ${SUPPORT_LEVELS.join(', ')}`);
	if (!CODEGEN_SET.has(codegen)) throw new TypeError(`codegen must be one of: ${CODEGEN_STATES.join(', ')}`);
	if (profile !== null) nonEmpty(profile, 'profile');
	const refs = uniqueStrings(evidenceRefs, 'evidenceRefs');
	const caps = uniqueStrings(capabilities, 'capabilities');
	const limits = uniqueStrings(limitations, 'limitations');
	if (level !== 'discovery' && refs.length === 0) throw new TypeError(`${level} certification requires evidenceRefs`);
	if (level === 'runtime-tested' && profile === null) throw new TypeError('runtime-tested certification requires profile');
	if (codegen !== 'none' && refs.length === 0) throw new TypeError(`${codegen} codegen state requires evidenceRefs`);
	return Object.freeze({
		targetId, level, codegen, capabilities: caps,
		evidenceRefs: refs, limitations: limits, profile,
	});
}

export function buildSupportMatrix(certifications = []) {
	if (!Array.isArray(certifications)) throw new TypeError('certifications must be an array');
	const rows = certifications.map((record) => certificationRecord(record));
	rows.sort((a, b) => a.targetId.localeCompare(b.targetId)
		|| SUPPORT_LEVELS.indexOf(a.level) - SUPPORT_LEVELS.indexOf(b.level)
		|| CODEGEN_STATES.indexOf(a.codegen) - CODEGEN_STATES.indexOf(b.codegen));
	const seen = new Set();
	for (const row of rows) {
		const key = `${row.targetId}\u0000${row.level}\u0000${row.codegen}\u0000${row.profile ?? ''}`;
		if (seen.has(key)) throw new TypeError(`duplicate certification row for ${row.targetId}/${row.level}/${row.codegen}/${row.profile ?? '-'}`);
		seen.add(key);
	}
	return Object.freeze(rows);
}
