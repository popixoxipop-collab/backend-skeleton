import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { GATE_NAMES, GATE_DEFINITIONS, VERIFY_POLICY, gateScopeId } from './gate-definitions.mjs';
import { EXIT } from './gates.mjs';
import { specPath } from './paths.mjs';
import { loadManifest, manifestPath } from './handles-manifest.mjs';
import { resolveWithinRoot } from './fsutil.mjs';

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

function detectBuildCommand(repoRoot) {
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
		return { ran: true, ok: false, tool: build.tool, message: (err.stdout || err.message || '').toString().split('\n').slice(-30).join('\n') };
	}
}

// S6: `handles/migration.sql` used to only become a check item when the file already existed,
// so a `handles` gate that had passed and then had its migration.sql deleted or moved could
// never fail this check -- the `exists:false` item was never created in the first place. The
// `handles` gate's own token (lib/gate-definitions.mjs) covers head_sha + the contract's hash,
// NOT migration.sql's content, so this artifact check is the ONLY thing that notices that file
// going missing. `gates` (the result of collectGateStatuses) tells us whether the handles gate
// has ever run at all, independent of its current pass/stale status -- a stale or forced handles
// gate still implies the file should exist.
export function checkArtifacts(root, featureId, gates = []) {
	const checks = [];
	const contractPath = specPath(root, featureId, 'contracts', `${featureId}.schema.json`);
	checks.push({ artifact: 'contract', path: path.relative(root, contractPath), exists: fs.existsSync(contractPath) });

	const migrationPath = specPath(root, featureId, 'handles', 'migration.sql');
	const migrationExists = fs.existsSync(migrationPath);
	const handlesRan = gates.find((g) => g.gate === 'handles')?.ran ?? false;
	if (handlesRan || migrationExists) {
		checks.push({ artifact: 'handles migration', path: path.relative(root, migrationPath), exists: migrationExists });
	}
	checks.push(...handlesManifestChecks(root, featureId, handlesRan));
	return checks;
}

// S2 (c): the `handles` gate's token deliberately does NOT hash the CONTENT of the Java it
// generated -- ResourceResolverStub.java.tmpl's patchField() is MEANT to be hand-finished
// (D-resolver-scope), so hashing generated content into the token would report every intentional
// human edit as `stale`, exactly backwards. What is never legitimate is the file being GONE:
// nothing regenerates it implicitly, and the feature doesn't compile without it. Same mechanism
// and reasoning as the migration.sql check above (S6) -- existence only, at verify time, entirely
// outside the gate token.
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
				artifact: e.kind === 'infra' ? 'handles infra' : 'handles resolver',
				path: relPath,
				exists: abs !== null && fs.existsSync(abs),
			};
		});
}
