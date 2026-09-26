#!/usr/bin/env node
// T11-05: read-only, repeatable parity check for a pre-existing pinned checkout.
//
// This tool never clones, installs dependencies, boots target code, runs Rails routes, or writes
// into the target repository. The caller owns acquisition/licensing and passes a checkout path.
// An exact expected ref can be supplied to reject corpus drift before scanning.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runScan } from '../../scanners/index.mjs';
import { ADAPTERS } from '../../scanners/registry.mjs';
import { LEGACY_HTTP_ADAPTER_IDS } from './baselines.mjs';
import { bridgeLegacyHttpScan } from './bridge.mjs';
import { compareLegacyHttpReports, legacyHttpSemanticDigest, legacyHttpSemanticSnapshot } from './parity.mjs';
import { assertLegacyCorpusCheckoutComplete } from './checkout-completeness.mjs';

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BASELINES_FILE = path.join(REPO_ROOT, 'test', 'http-legacy-next', 'fixtures', 'corpus-baseline.json');

function loadBaselines() {
	let data;
	try {
		data = JSON.parse(fs.readFileSync(BASELINES_FILE, 'utf8'));
	} catch (err) {
		fail(`could not read T11 corpus baseline file: ${err.message}`);
	}
	if (data?.contract !== 'sbf.t11-http-corpus-baseline/1' || !Array.isArray(data.entries)) {
		fail('invalid T11 corpus baseline file contract');
	}
	const byId = new Map();
	for (const entry of data.entries) {
		if (!entry?.id || byId.has(entry.id)) fail(`invalid/duplicate corpus baseline id "${entry?.id ?? '(missing)'}"`);
		byId.set(entry.id, entry);
	}
	return byId;
}

function fail(message, code = 2) {
	console.error(`t11-http-corpus-parity: ${message}`);
	process.exit(code);
}

function parseArgs(argv) {
	const out = { repo: null, baseline: null, adapter: null, ref: null, semanticSha256: null, terms: [] };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === '--repo') out.repo = argv[++i];
		else if (arg === '--baseline') out.baseline = argv[++i];
		else if (arg === '--adapter') out.adapter = argv[++i];
		else if (arg === '--ref') out.ref = argv[++i];
		else if (arg === '--semantic-sha256') out.semanticSha256 = argv[++i];
		else if (arg === '--term') out.terms.push(argv[++i]);
		else fail(`unknown argument "${arg}"`);
	}
	if (!out.repo) fail('--repo is required');

	if (out.baseline) {
		if (out.adapter || out.ref || out.semanticSha256 || out.terms.length > 0) {
			fail('--baseline cannot be combined with --adapter, --ref, --semantic-sha256, or --term');
		}
		const entry = loadBaselines().get(out.baseline);
		if (!entry) fail(`unknown --baseline "${out.baseline}"`);
		out.adapter = entry.adapter;
		out.ref = entry.ref;
		out.semanticSha256 = entry.semantic_sha256;
		out.terms = [...entry.terms];
	}

	if (!out.adapter) fail('--adapter is required unless --baseline is used');
	if (!LEGACY_HTTP_ADAPTER_IDS.includes(out.adapter)) fail(`--adapter must be one of: ${LEGACY_HTTP_ADAPTER_IDS.join(', ')}`);
	if (out.terms.length === 0 || out.terms.some((term) => !term)) fail('at least one non-empty --term is required');
	if (out.ref && !/^[0-9a-f]{40}$/i.test(out.ref)) fail('--ref must be an exact 40-hex commit SHA');
	if (out.semanticSha256 && !/^[0-9a-f]{64}$/i.test(out.semanticSha256)) fail('--semantic-sha256 must be a 64-hex SHA-256 digest');
	return out;
}

function headSha(repoRoot) {
	try {
		return execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
	} catch (err) {
		fail(`could not resolve target checkout HEAD: ${err.stderr?.toString().trim() || err.message}`);
	}
}

const args = parseArgs(process.argv.slice(2));
const repoRoot = path.resolve(args.repo);
if (!fs.existsSync(repoRoot)) fail(`repo path does not exist: ${repoRoot}`);

const observedRef = headSha(repoRoot);
if (args.ref && observedRef.toLowerCase() !== args.ref.toLowerCase()) {
	fail(`checkout ref mismatch: expected ${args.ref}, observed ${observedRef}`, 3);
}

let checkoutCompleteness;
try {
	checkoutCompleteness = assertLegacyCorpusCheckoutComplete({
		repoRoot,
		adapterId: args.adapter,
	});
} catch (err) {
	fail(err.message, 9);
}
if (checkoutCompleteness.git_head.toLowerCase() !== observedRef.toLowerCase()) {
	fail('checkout completeness guard observed a different git head', 9);
}

let report;
try {
	report = runScan({ repoRoot, terms: args.terms });
} catch (err) {
	fail(`scan failed: ${err.message}`, 4);
}
if (report.adapter !== args.adapter) {
	fail(`adapter mismatch: expected "${args.adapter}", detected "${report.adapter}"`, 5);
}
const adapter = ADAPTERS.find((entry) => entry.id === report.adapter);
if (!adapter) fail(`detected adapter "${report.adapter}" is absent from registry`, 6);

const bridged = bridgeLegacyHttpScan({ adapter, report });
const parity = compareLegacyHttpReports(report, bridged.legacy_report);
if (!parity.equal) {
	console.error(JSON.stringify({ parity }, null, 2));
	fail('legacy bridge semantic parity failed', 7);
}

const snapshot = legacyHttpSemanticSnapshot(report);
const semanticDigest = legacyHttpSemanticDigest(snapshot);
if (args.semanticSha256 && semanticDigest.toLowerCase() !== args.semanticSha256.toLowerCase()) {
	fail(`semantic digest mismatch: expected ${args.semanticSha256}, observed ${semanticDigest}`, 8);
}
const endpointCount = snapshot.modules.reduce(
	(sum, module) => sum + module.controllers.reduce((inner, controller) => inner + controller.endpoints.length, 0),
	0,
);
const entityCount = snapshot.modules.reduce((sum, module) => sum + module.entities.length, 0);

console.log(JSON.stringify({
	contract: 'sbf.t11-http-corpus-parity/1',
	repo: repoRoot,
	baseline_id: args.baseline,
	checkout_completeness: checkoutCompleteness,
	observed_ref: observedRef,
	expected_ref: args.ref,
	expected_adapter: args.adapter,
	detected_adapter: report.adapter,
	terms: args.terms,
	verdict: report.verdict,
	module_count: snapshot.modules.length,
	endpoint_count: endpointCount,
	entity_count: entityCount,
	files_read_count: snapshot.files_read.length,
	unknown_count: report.unknowns.length,
	expected_semantic_sha256: args.semanticSha256,
	legacy_semantic_sha256: semanticDigest,
	bridge_parity: parity,
}, null, 2));
