import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { GATE_NAMES, GATE_DEFINITIONS, VERIFY_POLICY, gateScopeId } from './gate-definitions.mjs';
import { EXIT } from './gates.mjs';
import { specPath } from './paths.mjs';
import { loadManifest, manifestPath } from './handles-manifest.mjs';
import { resolveWithinRoot } from './fsutil.mjs';
import { PROVIDERS, providerById } from '../handles/registry.mjs';
import { ADAPTERS, adapterById } from '../scanners/registry.mjs';

// S6: iterates the single shared gate definition list (lib/gate-definitions.mjs) instead of a
// local GATE_SPECS -- before this fix, GATE_SPECS was a second, hand-maintained gate list that
// drifted from bin/bskel.mjs's GATE_RECOMPUTERS: `stack` was registered as a real, writable gate
// but simply absent from GATE_SPECS, so `stack apply` could pass a repo-scoped `stack` gate that
// `bskel verify` would never even look at. There is only one list left to consult now.
export function collectGateStatuses(root, featureId, { getGate, requireNamedGate }) {
	return GATE_NAMES.map((name) => {
		const def = GATE_DEFINITIONS[name];
		const scopeId = gateScopeId(name, featureId);
		const record = getGate(root, scopeId, name);
		const result = requireNamedGate(root, name, featureId);
		return {
			gate: name,
			scope: def.scope,
			policy: def.verifyPolicy,
			required: def.verifyPolicy === VERIFY_POLICY.REQUIRED, // kept for existing JSON consumers
			blocking: isBlockingGateResult(def, result),
			ran: record !== null,
			...result,
		};
	});
}

// Whether one gate's current result should block the overall verify verdict. Policy
// interpretation lives in exactly this one place.
export function isBlockingGateResult(def, result) {
	if (result.code === EXIT.PASS) return false;
	if (def.verifyPolicy === VERIFY_POLICY.REQUIRED) return true;
	// required-when-present: a gate that has never run (not_run) does not block -- but once it
	// HAS run, every non-pass status (stale, awaiting_disposition, ...) still blocks. "Optional"
	// means "not every feature needs this", not "once run, correctness stops mattering".
	return result.status !== 'not_run';
}

// D5: exported so lib/doctor.mjs can reuse the exact same detection logic (does this repo have a
// recognized build wrapper at all) instead of re-implementing it -- `bskel doctor --workflow
// handles` and `bskel verify --build` must never disagree about what counts as "a build tool was
// found" for the same repo.
export function detectBuildCommand(repoRoot) {
	if (fs.existsSync(path.join(repoRoot, 'gradlew'))) {
		return { tool: 'gradle', cmd: './gradlew', args: ['compileJava', '--console=plain'] };
	}
	if (fs.existsSync(path.join(repoRoot, 'pom.xml'))) {
		return { tool: 'maven', cmd: './mvnw', args: ['compile', '-q'] };
	}
	if (fs.existsSync(path.join(repoRoot, 'package.json'))) {
		return { tool: 'npm', cmd: 'npm', args: ['run', 'build', '--if-present'] };
	}
	return null;
}

export function runBuildCheck(repoRoot) {
	const build = detectBuildCommand(repoRoot);
	if (!build) return { ran: false, ok: null, tool: null, message: 'no recognized build tool (gradlew/pom.xml/package.json) found' };
	try {
		execFileSync(build.cmd, build.args, { cwd: repoRoot, encoding: 'utf8', stdio: 'pipe' });
		return { ran: true, ok: true, tool: build.tool };
	} catch (err) {
		// S6 (D-verify-integrity): a failing build's most useful diagnostic text sometimes lands
		// entirely on stderr (confirmed live -- npm's own generic "> pkg build\n> cmd" banner goes
		// to stdout, the actual fatal error to stderr). Capturing stdout alone silently dropped it.
		// Each stream gets its OWN last-30-lines window, not one combined window -- a long stdout
		// must not crowd out a short stderr message.
		const stdout = (err.stdout || '').toString().trim();
		const stderr = (err.stderr || '').toString().trim();
		const parts = [];
		if (stdout) parts.push(`--- stdout (last 30 lines) ---\n${stdout.split('\n').slice(-30).join('\n')}`);
		if (stderr) parts.push(`--- stderr (last 30 lines) ---\n${stderr.split('\n').slice(-30).join('\n')}`);
		return { ran: true, ok: false, tool: build.tool, message: parts.join('\n\n') || (err.message || '').toString() };
	}
}

// G4: which spec-scoped output files a `handles` gate is expected to have produced -- provider-
// aware, via the same scan report -> adapter -> provider chain bin/bskel.mjs's handles commands
// use. Falls back to the pre-G4 single migration.sql expectation whenever the scan report is
// missing/unreadable, or names a provider that isn't (or is no longer) loaded -- this is exactly
// the java-spring behavior every existing test/real repo already depends on, unchanged.
const DEFAULT_HANDLES_OUTPUTS = ['handles/migration.sql'];

function handlesOutputsFor(root, featureId) {
	const scanReportPath = specPath(root, featureId, 'brownfield-scan.json');
	if (!fs.existsSync(scanReportPath)) return DEFAULT_HANDLES_OUTPUTS;
	let scanReport;
	try {
		scanReport = JSON.parse(fs.readFileSync(scanReportPath, 'utf8'));
	} catch {
		return DEFAULT_HANDLES_OUTPUTS;
	}
	const provider = providerById(PROVIDERS, scanReport.adapter);
	return provider ? provider.outputs.spec : DEFAULT_HANDLES_OUTPUTS;
}

// S6: `handles/migration.sql` used to only become a check item when the file already existed,
// so a `handles` gate that had passed and then had its migration.sql deleted or moved could
// never fail this check -- the `exists:false` item was never created in the first place. The
// `handles` gate's own token (lib/gate-definitions.mjs) covers head_sha + the contract's hash,
// NOT migration.sql's content, so this artifact check is the ONLY thing that notices that file
// going missing. `gates` (the result of collectGateStatuses) tells us whether the handles gate
// has ever run at all, independent of its current pass/stale status -- a stale or forced handles
// gate still implies every one of its expected outputs should exist. A provider with zero
// spec-scoped outputs simply produces no artifact items here at all, which is correct: there is
// nothing to check (no provider currently declares a non-empty outputs.spec any more --
// D-write-safety-phase0 (item 1) moved java-spring/python-fastapi's migration.sql onto manifest
// tracking, the same mechanism handlesManifestChecks() below already covers, so this loop is now
// live only for the fallback case below or a future provider with a genuinely untracked output).
export function checkArtifacts(root, featureId, gates = []) {
	const checks = [];
	const contractPath = specPath(root, featureId, 'contracts', `${featureId}.schema.json`);
	checks.push({ artifact: 'contract', path: path.relative(root, contractPath), exists: fs.existsSync(contractPath) });

	const handlesRan = gates.find((g) => g.gate === 'handles')?.ran ?? false;
	const manifestChecks = handlesManifestChecks(root, featureId, handlesRan);
	// D-write-safety-phase0 (item 1): a path already covered by the manifest-based check above must
	// not also get the legacy existence-only check below -- migration.sql is now BOTH manifest-
	// tracked (owner: featureId) AND still named in DEFAULT_HANDLES_OUTPUTS's fallback list, so
	// without this guard a scan-report-missing/corrupt repo would report it twice.
	const manifestCheckedPaths = new Set(manifestChecks.map((c) => c.path));
	for (const relOutput of handlesOutputsFor(root, featureId)) {
		const outputPath = specPath(root, featureId, ...relOutput.split('/'));
		const outputRelPath = path.relative(root, outputPath);
		if (manifestCheckedPaths.has(outputRelPath)) continue;
		const outputExists = fs.existsSync(outputPath);
		if (handlesRan || outputExists) {
			const label = path.basename(relOutput, path.extname(relOutput));
			checks.push({ artifact: `handles ${label}`, path: outputRelPath, exists: outputExists });
		}
	}
	checks.push(...manifestChecks);
	return checks;
}

// S2 (c): the `handles` gate's token deliberately does NOT hash the CONTENT of the Java it
// generated -- ResourceResolverStub.java.tmpl's patchField() is MEANT to be hand-finished
// (D-resolver-scope), so hashing generated content into the token would report every intentional
// human edit as `stale`, exactly backwards. What is never legitimate is the file being GONE:
// nothing regenerates it implicitly, and the feature doesn't compile without it. Same mechanism
// and reasoning as the migration.sql check above (S6) -- existence only, at verify time, entirely
// outside the gate token.
// D-write-safety-phase0 (item 1): manifest 'kind' values -> the label bskel verify's report shows.
// Anything not listed falls back to 'handles resolver' (the historical default before 'migration'
// existed) -- see the artifact: line below.
const HANDLES_ARTIFACT_LABELS = { infra: 'handles infra', migration: 'handles migration' };

function handlesManifestChecks(root, featureId, handlesRan) {
	let manifest;
	try {
		manifest = loadManifest(root);
	} catch {
		// A manifest that exists but can't be parsed/recognized is itself a finding -- report it
		// instead of letting `bskel verify` die with a stack trace mid-report.
		return [{ artifact: 'handles manifest (unreadable)', path: path.relative(root, manifestPath(root)), exists: false }];
	}
	const entries = Object.entries(manifest.files ?? {});
	const owned = entries.filter(([, e]) => e.owner === featureId);
	// A feature that never ran `handles emit` must produce NO items -- otherwise another feature's
	// resolvers (and the repo-owned infra, which every feature's entry below would also match)
	// would show up in THIS feature's verify report as if they were its own.
	if (!handlesRan && owned.length === 0) return [];
	// Repo-owned infra (global/handle/*) is included whenever handles ran for this feature at all,
	// because this feature's resolvers do not compile without it -- a deleted HandleCodec.java
	// breaks every feature that ever emitted handles, not just the one that happened to write it.
	const relevant = new Map([...owned, ...entries.filter(([, e]) => e.ownership === 'repo')]);
	return [...relevant.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([relPath, e]) => {
			const abs = resolveWithinRoot(root, relPath);
			return {
				// D-write-safety-phase0 (item 1): was a binary ternary (infra vs. everything else
				// called "resolver") -- widened once migration.sql started manifest-tracking as its
				// own kind: 'migration', which is neither infra (repo-owned) nor a resolver.
				artifact: HANDLES_ARTIFACT_LABELS[e.kind] ?? 'handles resolver',
				path: relPath,
				exists: abs !== null && fs.existsSync(abs),
			};
		});
}

// S6 (D-verify-integrity): O2's real, content-derived conflict detection (classifyFile(), see
// lib/handles-manifest.mjs) already runs on every `handles emit`/`handles plan --diff` -- but
// `bskel verify` never invoked it, so a resolver that has genuinely diverged into a `conflict`
// state (not the sanctioned "hand-finished patchField()" case classifyFile() already
// distinguishes -- see the `handles` gate's own token comment above) passed `verify` silently.
// This reuses the EXACT dry-run call `handles plan`'s own D4 preview makes
// (provider.plan() -> provider.emit({dryRun:true})), never re-implementing classifyFile()'s
// semantics here. Every precondition mirrors handlesManifestChecks()'s own graceful-skip
// philosophy -- verify must never crash or false-block just because handle codegen doesn't apply
// to this feature; that gating is `handles plan`/`handles emit`'s own job to enforce loudly, not
// verify's job to duplicate.
export function checkResolverConflicts(root, featureId, handlesRan) {
	if (!handlesRan) return [];
	const scanReportPath = specPath(root, featureId, 'brownfield-scan.json');
	try {
		const scanReport = JSON.parse(fs.readFileSync(scanReportPath, 'utf8'));
		const adapter = adapterById(ADAPTERS, scanReport.adapter);
		if (!adapter || !adapter.capabilities['codegen.handles']) return [];
		const provider = providerById(PROVIDERS, scanReport.adapter);
		if (!provider) return [];
		for (const capability of provider.requiresCapabilities ?? []) {
			if (!adapter.capabilities[capability]) return [];
		}
		const plan = provider.plan({ repoRoot: root, scanReport, module: null, resourceFilter: null });
		const { conflicts } = provider.emit({
			repoRoot: root, featureId, plan, resourceFilter: null, force: false, reason: '', dryRun: true, computeDiff: false,
		});
		return conflicts ?? [];
	} catch {
		// A provider-internal error here is that command's own concern (handles plan/emit already
		// report it loudly) -- not something verify should crash on, and not something it should
		// silently promote to a false "no conflicts" claim beyond returning no findings this run.
		return [];
	}
}
