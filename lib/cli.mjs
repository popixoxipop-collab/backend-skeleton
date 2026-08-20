// D2 (D-cli-contract): strict argument parsing (node:util.parseArgs) + the JSON-diagnostic
// channel every `bskel` command shares. This module is arg parsing + output glue only -- same
// "CLI stays thin, real logic lives in lib/" split D1's lib/workflow.mjs and D5's lib/doctor.mjs
// already established. See DECISIONS.md D-cli-contract for the full design and why the catalog's
// own "every handler returns {ok,code,command,diagnostics,next_actions}" prescription was
// rejected (it would break several commands' own schema-validated stdout artifacts).
import { parseArgs } from 'node:util';
import { REPO_GATE_ID } from './gate-definitions.mjs';

export class CliUsageError extends Error {}

const NUMERIC_RE = /^(0|[1-9]\d*)$/;

function numericError(flag, def, got) {
	const bounds = [
		def.numeric.min != null ? `>= ${def.numeric.min}` : null,
		def.numeric.max != null ? `<= ${def.numeric.max}` : null,
	].filter(Boolean).join(' and ');
	return `--${flag} must be a whole number${bounds ? ` ${bounds}` : ''} (got "${got}")`;
}

// D-cli-contract: mechanically transcribed from bin/bskel.mjs's pre-D2 `parseFlags(args, {...})`
// call sites, one entry per command -- `options[flag].type`/`.default` are byte-identical to the
// old spec. New fields this item adds: `numeric` (string-preserving min/max validation -- no
// forced Number() coercion, so existing parseInt()/shell-arg-passing call sites need no changes),
// `required` (existence-only; on failure this ALWAYS prints the command's own `usage` line, which
// is exactly what every pre-D2 required-flag check already did -- see the grounding audit in
// DECISIONS.md), `hidden` (kept out of --help and the usage()<->COMMANDS drift test; currently
// only `--db`, a documented Plane C placeholder that was never in usage() to begin with).
export const COMMANDS = {
	preflight: {
		usage: 'bskel preflight [--max-behind N] [--offline|--no-fetch] [--allow-dirty] [--max-age-minutes N] [--fetch-timeout-seconds N] [--json]',
		options: {
			'max-behind': { type: 'string', default: '0', numeric: { min: 0 } },
			// D-preflight-freshness (S3): --offline is the real name; --no-fetch is kept as an
			// exact alias (see scripts/preflight-base-ref.sh's own comment for why it isn't
			// removed). Both declared here so neither is rejected as unknown.
			offline: { type: 'boolean', default: false },
			'no-fetch': { type: 'boolean', default: false },
			'allow-dirty': { type: 'boolean', default: false },
			// D-preflight-freshness (S3): how long a passed preflight stays fresh before `gate
			// require`/downstream commands treat it as stale purely due to age (see
			// lib/gate-definitions.mjs's `freshness` declaration for the 30-minute default and its
			// data-derived justification). 0 disables the TTL entirely.
			'max-age-minutes': { type: 'string', default: '30', numeric: { min: 0 } },
			'fetch-timeout-seconds': { type: 'string', default: '60', numeric: { min: 0 } },
			json: { type: 'boolean', default: false },
		},
	},
	'gate require': {
		usage: 'bskel gate require <name> [--feature <id>]',
		options: { feature: { type: 'string', default: REPO_GATE_ID } },
		allowPositionals: true,
	},
	'gate force': {
		usage: 'bskel gate force <name> --reason "..." [--feature <id>] [--max-age-minutes N]',
		options: {
			feature: { type: 'string', default: REPO_GATE_ID },
			reason: { type: 'string', default: '' },
			'max-age-minutes': { type: 'string', default: null },
		},
		allowPositionals: true,
	},
	'gate revoke': {
		usage: 'bskel gate revoke <name> --reason "..." [--feature <id>]',
		options: {
			feature: { type: 'string', default: REPO_GATE_ID },
			reason: { type: 'string', default: '' },
		},
		allowPositionals: true,
	},
	'gate history': {
		usage: 'bskel gate history <name> [--feature <id>] [--json]',
		options: {
			feature: { type: 'string', default: REPO_GATE_ID },
			json: { type: 'boolean', default: false },
		},
		allowPositionals: true,
	},
	'gate show': {
		usage: 'bskel gate show [<name>] [--feature <id>]',
		options: { feature: { type: 'string', default: REPO_GATE_ID } },
		allowPositionals: true,
	},
	scan: {
		usage: 'bskel scan [--feature <id>] [--terms a,b,c] [--json] [--accept-low-confidence]',
		options: {
			feature: { type: 'string', default: null },
			terms: { type: 'string', default: '' },
			db: { type: 'boolean', default: false, hidden: true },
			json: { type: 'boolean', default: false },
			'accept-low-confidence': { type: 'boolean', default: false },
		},
	},
	'scan disposition': {
		usage: 'bskel scan disposition --feature <id> --mode reuse|extend|replace|parallel [--note "..."] [--breaking-approved]',
		options: {
			feature: { type: 'string', default: null, required: true },
			mode: { type: 'string', default: null },
			note: { type: 'string', default: '' },
			'breaking-approved': { type: 'boolean', default: false },
		},
	},
	'scan explain': {
		usage: 'bskel scan explain <module> --feature <id> [--json]',
		options: {
			feature: { type: 'string', default: null, required: true },
			json: { type: 'boolean', default: false },
		},
		allowPositionals: true,
	},
	'feature init': {
		usage: 'bskel feature init --slug <name>',
		options: { slug: { type: 'string', default: null, required: true } },
	},
	'contract emit': {
		usage: 'bskel contract emit --feature <id> [--module <name>] [--json] [--openapi-file <path>] [--path-prefix /api/v0]',
		options: {
			feature: { type: 'string', default: null, required: true },
			module: { type: 'string', default: null },
			json: { type: 'boolean', default: false },
			'openapi-file': { type: 'string', default: null },
			'path-prefix': { type: 'string', default: null },
		},
	},
	'contract waive': {
		usage: 'bskel contract waive --feature <id> --code <CODE> (--subject "VERB /path" | --all) --reason "..."',
		options: {
			feature: { type: 'string', default: null, required: true },
			code: { type: 'string', default: null, required: true },
			subject: { type: 'string', default: null },
			all: { type: 'boolean', default: false },
			reason: { type: 'string', default: '' },
			json: { type: 'boolean', default: false },
		},
	},
	'contract validate': {
		usage: 'bskel contract validate --feature <id> --file <envelope.json>',
		options: {
			feature: { type: 'string', default: null, required: true },
			file: { type: 'string', default: null, required: true },
		},
	},
	'contract tool-schema': {
		usage: 'bskel contract tool-schema --feature <id> --operation <operationId>',
		options: {
			feature: { type: 'string', default: null, required: true },
			operation: { type: 'string', default: null, required: true },
		},
	},
	'stack apply': {
		usage: 'bskel stack apply --choice <id> [--apply] [--port N] [--json]',
		options: {
			choice: { type: 'string', default: null },
			apply: { type: 'boolean', default: false },
			port: { type: 'string', default: '8080', numeric: { min: 1, max: 65535 } },
			json: { type: 'boolean', default: false },
		},
	},
	'catalog lint': {
		usage: 'bskel catalog lint [<choice>] [--json]',
		options: { json: { type: 'boolean', default: false } },
		allowPositionals: true,
	},
	'handles plan': {
		usage: 'bskel handles plan --feature <id> [--module <name>] [--resource type1,type2]',
		options: {
			feature: { type: 'string', default: null, required: true },
			module: { type: 'string', default: null },
			resource: { type: 'string', default: '' },
			json: { type: 'boolean', default: false },
		},
	},
	'handles emit': {
		usage: 'bskel handles emit --feature <id> [--module <name>] [--resource type1,type2] [--force --reason "..."]',
		options: {
			feature: { type: 'string', default: null, required: true },
			module: { type: 'string', default: null },
			resource: { type: 'string', default: '' },
			force: { type: 'boolean', default: false },
			reason: { type: 'string', default: '' },
			json: { type: 'boolean', default: false },
		},
	},
	verify: {
		usage: 'bskel verify --feature <id> [--build] [--json]',
		options: {
			feature: { type: 'string', default: null, required: true },
			build: { type: 'boolean', default: false },
			json: { type: 'boolean', default: false },
		},
	},
	status: {
		usage: 'bskel status [--feature <id>] [--json]',
		options: {
			feature: { type: 'string', default: null },
			json: { type: 'boolean', default: false },
		},
	},
	next: {
		usage: 'bskel next [--feature <id>] [--json]',
		options: {
			feature: { type: 'string', default: null },
			json: { type: 'boolean', default: false },
		},
	},
	doctor: {
		usage: 'bskel doctor [--workflow scan|handles|stack] [--json]',
		options: {
			workflow: { type: 'string', default: null },
			json: { type: 'boolean', default: false },
		},
	},
};

function describeParseArgsError(err, spec) {
	const known = [
		...Object.keys(spec.options).filter((f) => !spec.options[f].hidden),
		'help', 'json', 'quiet',
	].sort().map((f) => `--${f}`).join(', ');
	return `${err.message}\nusage: ${spec.usage}\nknown flags: ${known}`;
}

// Returns the SAME shape `parseFlags()` (pre-D2) returned: `{ _: [...positionals], ...values }`
// -- every existing `flags.feature`/`flags._[0]`/`flags['max-behind']` call site in bin/bskel.mjs
// needed zero changes for this. `flags.help === true` short-circuits BEFORE required-field
// validation (so `bskel handles emit --help` renders help instead of failing on missing
// --feature). Throws CliUsageError -- never calls process.exit itself, so this stays unit-testable
// without spawning a process (see test/cli-contract.test.mjs).
export function parseCommand(name, argv) {
	const spec = COMMANDS[name];
	if (!spec) throw new Error(`bskel-internal: no COMMANDS entry for "${name}"`);

	const parseArgsOptions = { help: { type: 'boolean' }, quiet: { type: 'boolean' } };
	for (const [flag, def] of Object.entries(spec.options)) parseArgsOptions[flag] = { type: def.type };
	parseArgsOptions.json ??= { type: 'boolean' };

	let parsed;
	try {
		parsed = parseArgs({
			args: argv,
			options: parseArgsOptions,
			strict: true,
			allowPositionals: Boolean(spec.allowPositionals),
		});
	} catch (err) {
		throw new CliUsageError(describeParseArgsError(err, spec));
	}

	const out = { _: parsed.positionals ?? [] };
	for (const [flag, def] of Object.entries(spec.options)) {
		out[flag] = Object.hasOwn(parsed.values, flag) ? parsed.values[flag] : def.default;
	}
	out.json = parsed.values.json ?? false;
	out.quiet = Boolean(parsed.values.quiet);
	out.help = Boolean(parsed.values.help);

	for (const [flag, def] of Object.entries(spec.options)) {
		if (!def.numeric || out[flag] == null) continue;
		const value = out[flag];
		if (!NUMERIC_RE.test(value) || (def.numeric.min != null && Number(value) < def.numeric.min) || (def.numeric.max != null && Number(value) > def.numeric.max)) {
			throw new CliUsageError(numericError(flag, def, value));
		}
	}

	if (out.help) return out;

	for (const [flag, def] of Object.entries(spec.options)) {
		if (def.required && !out[flag]) throw new CliUsageError(`usage: ${spec.usage}`);
	}

	return out;
}

export function renderCommandHelp(name) {
	const spec = COMMANDS[name];
	const lines = [`usage: ${spec.usage}`, '', 'flags:'];
	for (const [flag, def] of Object.entries(spec.options)) {
		if (def.hidden) continue;
		const parts = [def.type];
		if (def.default != null && def.type !== 'boolean') parts.push(`default: ${def.default}`);
		if (def.required) parts.push('required');
		lines.push(`  --${flag}  (${parts.join(', ')})`);
	}
	lines.push('  --json  (boolean)');
	lines.push('  --quiet  (boolean)');
	lines.push('  --help  (boolean)');
	lines.push('', "see 'bskel --help' for the full command list");
	return `${lines.join('\n')}\n`;
}

// D-cli-contract: the additive JSON diagnostic -- only ever printed on a PAYLOAD-LESS early-exit
// path (a command that would otherwise have exited with empty stdout). Commands whose stdout is
// itself a schema-validated artifact (scan/contract emit/handles plan, etc.) never call this --
// see DECISIONS.md for why wrapping those would break `bskel scan --json > brownfield-scan.json`.
export function diagnostic({ command, code, reason, message, next_actions = [] }) {
	return {
		schema: 'sbf.cli-diagnostic/1',
		ok: false,
		command,
		code,
		reason,
		diagnostics: [{ level: 'error', reason, message }],
		next_actions,
	};
}
