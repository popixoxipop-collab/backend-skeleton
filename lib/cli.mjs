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
// DECISIONS.md), `hidden` (kept out of --help and the usage()<->COMMANDS drift test -- unused as
// of A4, which gave `scan`'s own `--db` a real implementation and its own usage() documentation).
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
	// D-gate-export: unlike `gate show`, always feature-scoped -- the whole point is one feature's
	// own evidence trail across all 5 gates, not a single gate/repo-level snapshot.
	'gate export': {
		usage: 'bskel gate export --feature <id> [--out <path>] [--sign --key <privateKeyPath>] [--json]',
		options: {
			feature: { type: 'string', default: null, required: true },
			out: { type: 'string', default: null },
			sign: { type: 'boolean', default: false },
			key: { type: 'string', default: null },
			json: { type: 'boolean', default: false },
		},
	},
	// D-gate-attestation-signing.
	'attest keygen': {
		usage: 'bskel attest keygen --out <dir> [--force] [--json]',
		options: {
			out: { type: 'string', default: null, required: true },
			force: { type: 'boolean', default: false },
			json: { type: 'boolean', default: false },
		},
	},
	'attest verify': {
		usage: 'bskel attest verify --file <path> --pubkey <path> [--json]',
		options: {
			file: { type: 'string', default: null, required: true },
			pubkey: { type: 'string', default: null, required: true },
			json: { type: 'boolean', default: false },
		},
	},
	scan: {
		usage: 'bskel scan [--feature <id>] [--terms a,b,c] [--json] [--accept-low-confidence] [--db [--database-url-env <NAME>] [--schema public]]',
		options: {
			feature: { type: 'string', default: null },
			terms: { type: 'string', default: '' },
			// A4 (D-db-schema-plane): --db now does something real (Plane A migration-file scan,
			// Plane C live introspection when --database-url-env is also given) -- no longer a
			// documented-but-inert placeholder, so no longer `hidden`.
			db: { type: 'boolean', default: false },
			'database-url-env': { type: 'string', default: null },
			schema: { type: 'string', default: 'public' },
			json: { type: 'boolean', default: false },
			'accept-low-confidence': { type: 'boolean', default: false },
		},
	},
	'scan disposition': {
		usage: 'bskel scan disposition --feature <id> --mode reuse|extend|replace|parallel [--module <name>] [--note "..."] [--breaking-approved]',
		options: {
			feature: { type: 'string', default: null, required: true },
			mode: { type: 'string', default: null },
			// S2 (D-gate-precision, part 2): optional -- defaults to the same top-scored module
			// contracts/emit.mjs's selectModule() would ALSO pick with no --module override, so an
			// omitted flag here never silently disagrees with what `contract emit`/`handles plan`
			// actually use by default.
			module: { type: 'string', default: null },
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
	'scan cross-feature-check': {
		usage: 'bskel scan cross-feature-check --feature <id> [--db [--database-url-env <NAME>] [--schema public]] [--json]',
		options: {
			feature: { type: 'string', default: null, required: true },
			// D-cross-feature-fk-inference: byte-identical shape to `scan`'s own --db/--database-url-env/
			// --schema (resolved via the SAME resolveDbSchemaOrExit() helper) -- omitting them entirely
			// is the exact prior behavior, unchanged.
			db: { type: 'boolean', default: false },
			'database-url-env': { type: 'string', default: null },
			schema: { type: 'string', default: 'public' },
			json: { type: 'boolean', default: false },
		},
	},
	'scan cross-feature-waive': {
		usage: 'bskel scan cross-feature-waive --feature <id> --signal resource_type|table|operation_id|db_foreign_key --identifier <name> --other-feature <id> --reason "..." [--json]',
		options: {
			feature: { type: 'string', default: null, required: true },
			signal: { type: 'string', default: null, required: true },
			identifier: { type: 'string', default: null, required: true },
			'other-feature': { type: 'string', default: null, required: true },
			reason: { type: 'string', default: '' },
			json: { type: 'boolean', default: false },
		},
	},
	'feature init': {
		usage: 'bskel feature init --slug <name>',
		options: { slug: { type: 'string', default: null, required: true } },
	},
	'feature list': {
		usage: 'bskel feature list [--all] [--json]',
		options: { all: { type: 'boolean', default: false }, json: { type: 'boolean', default: false } },
	},
	'feature show': {
		usage: 'bskel feature show <id> [--json]',
		options: { json: { type: 'boolean', default: false } },
		allowPositionals: true,
	},
	'feature rename': {
		usage: 'bskel feature rename <id> --to <new-slug> --reason "..." [--json]',
		options: {
			to: { type: 'string', default: null, required: true },
			reason: { type: 'string', default: '' },
			json: { type: 'boolean', default: false },
		},
		allowPositionals: true,
	},
	'feature link': {
		usage: 'bskel feature link <keepId> <aliasId> --reason "..." [--json]',
		options: { reason: { type: 'string', default: '' }, json: { type: 'boolean', default: false } },
		allowPositionals: true,
	},
	'feature archive': {
		usage: 'bskel feature archive <id> --reason "..." [--json]',
		options: { reason: { type: 'string', default: '' }, json: { type: 'boolean', default: false } },
		allowPositionals: true,
	},
	'contract emit': {
		usage: 'bskel contract emit --feature <id> [--module <name>] [--json] [--openapi-file <path>] [--path-prefix /api/v0] [--descriptions]',
		options: {
			feature: { type: 'string', default: null, required: true },
			module: { type: 'string', default: null },
			json: { type: 'boolean', default: false },
			'openapi-file': { type: 'string', default: null },
			'path-prefix': { type: 'string', default: null },
			// A10 (D-openapi-description): the one source-backed field that is NOT default-on --
			// measured real cost (2,442.7 bytes/operation average) is larger than every other field
			// this whole passthrough effort copies combined, so it stays opt-in rather than joining
			// A7/A8/A9's default-on behavior.
			descriptions: { type: 'boolean', default: false },
		},
	},
	// A6 (D-openapi-export): the export direction. `--allow-unprefixed` is deliberately NOT a
	// default-on convenience -- it overrides a refusal that exists because the scan found a global
	// path-prefix signal the contract's own paths don't reflect, which is a wrong-paths-handed-to-a
	// -client-generator risk, not a cosmetic one. `--status-codes` defaults to `range` (invents
	// nothing); `literal` trades that for tooling compatibility, with a printed caveat.
	'contract export': {
		usage: 'bskel contract export --feature <id> [--out <path>] [--json] [--allow-unprefixed] [--status-codes range|literal]',
		options: {
			feature: { type: 'string', default: null, required: true },
			out: { type: 'string', default: null },
			'allow-unprefixed': { type: 'boolean', default: false },
			'status-codes': { type: 'string', default: 'range' },
			json: { type: 'boolean', default: false },
		},
	},
	// D-contract-history: read-only, so no --module/--openapi-file/etc -- it only ever reads what
	// git already recorded for this feature's own contract file.
	'contract history': {
		usage: 'bskel contract history --feature <id> [--json]',
		options: {
			feature: { type: 'string', default: null, required: true },
			json: { type: 'boolean', default: false },
		},
	},
	'contract waive': {
		usage: 'bskel contract waive --feature <id> --code <CODE> (--subject "VERB /path" | --all) --reason "..." [--expires <Nd>]',
		options: {
			feature: { type: 'string', default: null, required: true },
			code: { type: 'string', default: null, required: true },
			subject: { type: 'string', default: null },
			all: { type: 'boolean', default: false },
			reason: { type: 'string', default: '' },
			// D-waiver-expiry: no default -- an un-timed waiver never expires, same "opt-in only,
			// never silently starts a clock" posture --max-age-minutes already takes elsewhere.
			expires: { type: 'string', default: null },
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
	'dependency declare': {
		usage: 'bskel dependency declare --feature <id> --resource <Type> --field <name> --source-feature <id> --source-resource <Type> --source-field <name> --reason "..." [--memo "..."] [--json]',
		options: {
			feature: { type: 'string', default: null, required: true },
			resource: { type: 'string', default: null, required: true },
			field: { type: 'string', default: null, required: true },
			'source-feature': { type: 'string', default: null, required: true },
			'source-resource': { type: 'string', default: null, required: true },
			'source-field': { type: 'string', default: null, required: true },
			reason: { type: 'string', default: '' },
			memo: { type: 'string', default: null },
			json: { type: 'boolean', default: false },
		},
	},
	'dependency remove': {
		usage: 'bskel dependency remove --feature <id> --resource <Type> --field <name> --source-feature <id> --source-resource <Type> --source-field <name> --reason "..." [--json]',
		options: {
			feature: { type: 'string', default: null, required: true },
			resource: { type: 'string', default: null, required: true },
			field: { type: 'string', default: null, required: true },
			'source-feature': { type: 'string', default: null, required: true },
			'source-resource': { type: 'string', default: null, required: true },
			'source-field': { type: 'string', default: null, required: true },
			reason: { type: 'string', default: '' },
			json: { type: 'boolean', default: false },
		},
	},
	'dependency list': {
		usage: 'bskel dependency list --feature <id> [--json]',
		options: {
			feature: { type: 'string', default: null, required: true },
			json: { type: 'boolean', default: false },
		},
	},
	'stack apply': {
		usage: 'bskel stack apply --choice <id> [--apply] [--port N] [--force --reason "..."] [--json]',
		options: {
			choice: { type: 'string', default: null },
			apply: { type: 'boolean', default: false },
			port: { type: 'string', default: '8080', numeric: { min: 1, max: 65535 } },
			// D-write-safety-phase0 (item 2): mirrors handles emit's own --force/--reason exactly --
			// a file that diverged from what `stack apply` itself last wrote is refused without this.
			force: { type: 'boolean', default: false },
			reason: { type: 'string', default: '' },
			json: { type: 'boolean', default: false },
		},
	},
	'catalog lint': {
		usage: 'bskel catalog lint [<choice>] [--json]',
		options: { json: { type: 'boolean', default: false } },
		allowPositionals: true,
	},
	'handles plan': {
		usage: 'bskel handles plan --feature <id> [--module <name>] [--resource type1,type2] [--diff] [--ast]',
		options: {
			feature: { type: 'string', default: null, required: true },
			module: { type: 'string', default: null },
			resource: { type: 'string', default: '' },
			diff: { type: 'boolean', default: false },
			// A2 Phase 2 (D-java-ast-helper): opt-in only -- runs the real JavaParser + Symbol
			// Solver helper alongside the always-on regex classification and reports any
			// disagreement. Never automatic; see ast-bridge.mjs.
			ast: { type: 'boolean', default: false },
			json: { type: 'boolean', default: false },
		},
	},
	'handles emit': {
		usage: 'bskel handles emit --feature <id> [--module <name>] [--resource type1,type2] [--force --reason "..."] [--check] [--diff] [--enforce-registry on|off [--reason "..."]]',
		options: {
			feature: { type: 'string', default: null, required: true },
			module: { type: 'string', default: null },
			resource: { type: 'string', default: '' },
			force: { type: 'boolean', default: false },
			reason: { type: 'string', default: '' },
			check: { type: 'boolean', default: false },
			diff: { type: 'boolean', default: false },
			// O3 (D-handle-registry-enforcement): repo-wide, singleton state (java-spring/
			// python-fastapi's shared global/handle infra, not per-feature) -- omitted entirely
			// (default null) reuses whatever `.sbf/handles-manifest.json` last recorded, so a
			// re-emit that doesn't mention this flag never silently reverts a previously-enabled
			// protection. An explicit `on`->`off` transition requires the SAME `--reason` flag
			// `--force` already uses, not a new one -- mirrors that convention rather than adding
			// a second audited-override mechanism.
			'enforce-registry': { type: 'string', default: null },
			json: { type: 'boolean', default: false },
		},
	},
	// O7 (D-handle-audit-report): read-only, requires --database-url-env (unlike `scan --db`,
	// there is no meaningful "run without a live connection" mode for this command -- its entire
	// purpose IS the live query). Reuses `--resource type1,type2`'s exact multi-value convention
	// from `handles plan`/`handles emit` rather than a new singular flag name.
	'handles audit': {
		usage: 'bskel handles audit --feature <id> --database-url-env <NAME> [--resource type1,type2] [--json]',
		options: {
			feature: { type: 'string', default: null, required: true },
			'database-url-env': { type: 'string', default: null, required: true },
			resource: { type: 'string', default: '' },
			json: { type: 'boolean', default: false },
		},
	},
	// D-runtime-conformance-receipts: mirrors `handles emit`'s own flag shape (force/reason/check/
	// diff) -- a separate top-level noun from `handles`, not a flag on it, since observing runtime
	// traffic and generating UUID-addressable field handles are orthogonal capabilities.
	// D-runtime-conformance-receipts: --module is python-fastapi-only in practice (java-spring's
	// own detectBasePackage() needs no module/feature context at all, mirroring `handles emit`'s
	// own asymmetry -- java's own --module is likewise a no-op for its own base-package detection).
	'observe emit': {
		usage: 'bskel observe emit --feature <id> [--module <name>] [--force --reason "..."] [--check] [--diff] [--json]',
		options: {
			feature: { type: 'string', default: null, required: true },
			module: { type: 'string', default: null },
			force: { type: 'boolean', default: false },
			reason: { type: 'string', default: '' },
			check: { type: 'boolean', default: false },
			diff: { type: 'boolean', default: false },
			json: { type: 'boolean', default: false },
		},
	},
	'observe import': {
		usage: 'bskel observe import --feature <id> --receipts <path> [--fail-on-violation] [--json]',
		options: {
			feature: { type: 'string', default: null, required: true },
			receipts: { type: 'string', default: null, required: true },
			'fail-on-violation': { type: 'boolean', default: false },
			json: { type: 'boolean', default: false },
		},
	},
	// P2b (D-greenfield-parameters): every parameter below defaults to `null` rather than to its
	// real default value, on purpose -- `cmdNew` has to distinguish "not passed" from "passed the
	// same value the default happens to be" to (a) reject a Spring-only flag given with --stack
	// fastapi and vice versa, and (b) avoid an extra network round-trip validating a --java-version
	// nobody actually asked for. The real defaults live in new/spring.mjs / new/fastapi.mjs, one
	// place each.
	new: {
		usage: 'bskel new --stack spring|fastapi --slug <name> [--dir <path>] [--offline] [--json] [--name <text>] [--description <text>] [--project-version <v>] [--group-id <pkg>] [--artifact-id <id>] [--package-name <pkg>] [--java-version <n>] [--packaging jar|war] [--dependencies a,b,c] [--add-dependencies a,b,c] [--python-version <spec>] [--port N] [--license <spdx>] [--database postgres|sqlite|none]',
		options: {
			stack: { type: 'string', default: null, required: true },
			slug: { type: 'string', default: null, required: true },
			dir: { type: 'string', default: null },
			offline: { type: 'boolean', default: false },

			// Both stacks.
			name: { type: 'string', default: null },
			description: { type: 'string', default: null },
			// NOT `--version`: that is already a GLOBAL flag intercepted in main() before any
			// command-specific parsing (it prints `bskel <version>`), so a command-level --version
			// would be unreachable. This names the GENERATED project's own version field.
			'project-version': { type: 'string', default: null },

			// --stack spring only.
			'group-id': { type: 'string', default: null },
			'artifact-id': { type: 'string', default: null },
			'package-name': { type: 'string', default: null },
			'java-version': { type: 'string', default: null },
			packaging: { type: 'string', default: null },
			dependencies: { type: 'string', default: null },
			'add-dependencies': { type: 'string', default: null },

			// --stack fastapi only. `--port`'s numeric bounds mirror `stack apply --port` exactly
			// (the default differs -- 8000 is uvicorn's, 8080 is Spring's -- but the VALIDATION shape
			// is the one this CLI already declares for a port).
			'python-version': { type: 'string', default: null },
			port: { type: 'string', default: null, numeric: { min: 1, max: 65535 } },
			license: { type: 'string', default: null },
			database: { type: 'string', default: null },

			// Declared-but-hidden: accepted by the parser purely so `cmdNew` can answer with the
			// SPECIFIC reason each is refused (new/index.mjs's SPRING_REFUSED_PARAMS) instead of a
			// bare "Unknown option". `hidden` keeps them out of --help and out of
			// test/doc-integrity.test.mjs's usage()<->COMMANDS flag-set equality check.
			type: { type: 'string', default: null, hidden: true },
			language: { type: 'string', default: null, hidden: true },
			'boot-version': { type: 'string', default: null, hidden: true },
		},
	},
	'handles patch approve': {
		usage: 'bskel handles patch approve --feature <id> [--module <name>] --resource <Type> --field <name> --strategy patch-wrapper|null-means-unchanged --reason "..." [--json]',
		options: {
			feature: { type: 'string', default: null, required: true },
			module: { type: 'string', default: null },
			resource: { type: 'string', default: null, required: true },
			field: { type: 'string', default: null, required: true },
			strategy: { type: 'string', default: null, required: true },
			reason: { type: 'string', default: '' },
			json: { type: 'boolean', default: false },
		},
	},
	// D-patch-transactions: content-addressed patch transactions, Slice 1 (config_check ->
	// config_apply). `propose`/`approve` only touch specs/, so no --force escape exists on either --
	// re-propose is the only remediation for a stale target. `rollback` alone gets --force (reverting
	// to a known-good, git-recoverable prior state is materially lower-risk than forcing a forward
	// edit whose collateral effects were never re-verified).
	'patch propose': {
		usage: 'bskel patch propose --feature <id> [--kind config-apply --choice <stackChoiceId> --target <config_check target path> | --kind ddl-apply --database-url-env <NAME> --sql-file <path> [--schema public]] [--json]',
		options: {
			feature: { type: 'string', default: null, required: true },
			// D-ddl-apply: default 'config-apply' -- omitting --kind entirely is byte-identical to
			// this project's prior behavior. choice/target/database-url-env/sql-file are validated
			// by hand inside cmdPatchPropose (kind-conditional requirements aren't expressible via
			// this table's own unconditional `required: true`), matching this file's existing
			// convention for kind-conditional flags (e.g. --reason on approve/rollback).
			kind: { type: 'string', default: 'config-apply' },
			choice: { type: 'string', default: null },
			target: { type: 'string', default: null },
			'database-url-env': { type: 'string', default: null },
			schema: { type: 'string', default: 'public' },
			'sql-file': { type: 'string', default: null },
			json: { type: 'boolean', default: false },
		},
	},
	'patch approve': {
		usage: 'bskel patch approve --feature <id> --transaction <id> --reason "..." [--json]',
		options: {
			feature: { type: 'string', default: null, required: true },
			transaction: { type: 'string', default: null, required: true },
			reason: { type: 'string', default: '' },
			json: { type: 'boolean', default: false },
		},
	},
	'patch apply': {
		usage: 'bskel patch apply --feature <id> --transaction <id> [--confirm <id-or-dropped-table-name>] [--json]',
		options: {
			feature: { type: 'string', default: null, required: true },
			transaction: { type: 'string', default: null, required: true },
			// D-ddl-apply: required for any kind other than config-apply -- what value it must
			// exactly equal is kind- AND transaction-specific (getPatchKind(kind).requiredConfirmValue(txn)):
			// the transaction id for a non-drop ddl-apply transaction, or the sorted, comma-joined
			// dropped-table name(s) for one that drops a table. Checked by hand inside cmdPatchApply
			// once the transaction's own kind/shape is known, not declaratively here. Ignored for
			// config-apply.
			confirm: { type: 'string', default: null },
			json: { type: 'boolean', default: false },
		},
	},
	'patch rollback': {
		usage: 'bskel patch rollback --feature <id> --transaction <id> --reason "..." [--force] [--json]',
		options: {
			feature: { type: 'string', default: null, required: true },
			transaction: { type: 'string', default: null, required: true },
			reason: { type: 'string', default: '' },
			force: { type: 'boolean', default: false },
			json: { type: 'boolean', default: false },
		},
	},
	'patch list': {
		usage: 'bskel patch list --feature <id> [--json]',
		options: {
			feature: { type: 'string', default: null, required: true },
			json: { type: 'boolean', default: false },
		},
	},
	verify: {
		usage: 'bskel verify --feature <id> [--build [--allow-skip-build]] [--json]',
		options: {
			feature: { type: 'string', default: null, required: true },
			build: { type: 'boolean', default: false },
			// S6 (D-verify-integrity): an explicit --build request must not silently no-op when no
			// build tool is recognized -- this is the one opt-out, matching --force/--offline's own
			// "explicit request needs an explicit escape hatch" shape elsewhere in this CLI.
			'allow-skip-build': { type: 'boolean', default: false },
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
	serve: {
		usage: 'bskel serve [--port N] [--host <addr>] [--database-url-env <NAME> [--schema public] [--sign-key <path>] [--require-sign-key]] [--json]',
		options: {
			// min:0 (unlike stack apply --port's min:1) -- 0 is the standard "let the OS pick a free
			// ephemeral port" sentinel, genuinely useful both for tests and for a user who doesn't care
			// which port they get, not just a testing convenience.
			port: { type: 'string', default: '4747', numeric: { min: 0, max: 65535 } },
			host: { type: 'string', default: '127.0.0.1' },
			// D-ddl-apply: every new DB-schema/patch-transaction route is gated behind this one flag
			// being present -- a plain `bskel serve` (no --database-url-env) stays byte-identical to
			// today, those paths simply don't exist (404, not 403), mirroring --host's own "safe
			// default, explicit override" convention. --sign-key is optional even when the DB surface
			// is enabled (see D-ddl-apply's "detect and warn, never hard-require" signing posture).
			'database-url-env': { type: 'string', default: null },
			schema: { type: 'string', default: 'public' },
			'sign-key': { type: 'string', default: null },
			// D-ddl-apply: opt-in-to-MORE-strictness -- refuses to even start the DDL surface without
			// --sign-key also given, closing this feature's own named "mandatory signing... cheap,
			// well-justified near-term addition" EXIT item. A no-op when --database-url-env wasn't
			// given at all (nothing to enforce on a surface that isn't running), same as --schema/
			// --sign-key themselves already being inert outside that case.
			'require-sign-key': { type: 'boolean', default: false },
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
