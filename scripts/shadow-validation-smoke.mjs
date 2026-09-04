#!/usr/bin/env node
// ROADMAP.md Phase 5a: a repeatable version of the shadow-validation pass that already ran once,
// by hand, and found 4 real defects still in `git log` (`8d5de4b`/`654bcaf`/`5ff1a1a`/`e922f7f`) --
// there was no committed script for it, unlike every other verification discipline in this
// project. Clones one or more real, third-party repos and runs the SAME real, read-only commands
// that pass used (confirmed against `DECISIONS.md`'s own record before writing this, not
// reinvented): an ad-hoc `scan` for the scan-layer signal, then a real (but still read-only --
// no `contract emit`, no `handles emit`) `preflight` -> `feature init` -> `scan --feature` ->
// `handles plan --feature --module` sequence for the handles-layer signal.
//
// A DIAGNOSTIC tool, not a pass/fail gate -- exits non-zero only on a genuine script-level
// failure (a clone failed, `bskel` crashed unexpectedly, or -- manifest mode only, see below -- a
// manifest entry's declared adapter doesn't match reality), never because a repo's own findings
// look bad (a `_unknown` module bucket or a zero-resolver count is DATA this script surfaces, not
// something it judges). Deliberately NOT wired into `test:all-smoke` or any CI job: every other
// smoke script runs against this project's own pinned fixtures; this one clones live third-party
// repos over the network.
//
// Usage:
//   node scripts/shadow-validation-smoke.mjs                      -- the 4 default oracles below
//   node scripts/shadow-validation-smoke.mjs owner/repo[@ref][:subpath][#term1,term2] ...
//   node scripts/shadow-validation-smoke.mjs <git-url-or-local-path>[:subpath][#term1,term2] ...
//   node scripts/shadow-validation-smoke.mjs --out report.json ...  -- JSON array written to a file
//   node scripts/shadow-validation-smoke.mjs --manifest test/fixtures/oracle-manifest.json [--adapter java-spring]
//
// `scan` (confirmed live, not assumed) hard-refuses with BAD_ARGS when given zero search terms --
// there is no "just show me everything" mode, so every repo spec here carries real terms. A
// caller pointing this at an unfamiliar repo must supply their own terms (the `#term1,term2`
// suffix) for the same reason a human running `bskel scan` by hand would need to -- this script
// does not, and cannot, guess what a repo's own domain vocabulary is.
//
// A spec is either `owner/repo[@ref]` (expanded to a real github.com clone URL) or a literal git
// URL/local path (anything containing "://", or starting with "/" or ".") -- the literal form
// exists so `test/shadow-validation-cli.test.mjs` can point this at a local bare repo (same
// scratch-repo-plus-bare-origin convention `db-introspect-smoke.mjs` already uses) and cover the
// real clone -> scan -> plan -> report path without a network dependency, not because a real user
// is expected to reach for it often.
//
// D-oracle-corpus-pinning (ROADMAP.md Phase 5b): `:subpath` scopes every `bskel` invocation to a
// subdirectory of the clone (for monorepos where the real backend lives under e.g.
// `server/polar/`), and `ref` may be a real 40-hex-char commit SHA -- `git clone -b <ref>` only
// works for branch/tag names, so a SHA-shaped ref switches to `git init` + `git remote add` +
// `git fetch --depth 1 origin <sha>` + `git checkout FETCH_HEAD` (GitHub serves exact-SHA fetches
// for public repos). `--manifest <path>` reads a committed, schema-validated corpus manifest
// (`schemas/oracle-manifest.schema.json`) instead of positional specs -- see
// `test/fixtures/oracle-manifest.json` for the real, pinned Phase 5b corpus.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { bskel, makeFail, REPO_ROOT } from './_smoke-lib.mjs';
import { validateAgainstSchema, formatSchemaErrors } from '../lib/schema-validate.mjs';

const fail = makeFail('shadow-validation-smoke');

const DEFAULT_REPOS = [
	{ owner: 'spring-projects', repo: 'spring-petclinic', ref: '818c4136ea971c21674525f9053de0d9c7ad8cfe', path: null, terms: ['owner'], cloneUrl: 'https://github.com/spring-projects/spring-petclinic.git' },
	{ owner: 'fastapi', repo: 'full-stack-fastapi-template', ref: 'cb740b656d7a0a6c5e12c7bf8e50343ec94ee9c7', path: null, terms: ['item'], cloneUrl: 'https://github.com/fastapi/full-stack-fastapi-template.git' },
	{ owner: 'hoangsonww', repo: 'PetSwipe-Match-App', ref: 'b8573eead531c68a4e2a551883c3a17828b30826', path: 'backend', terms: ['pet'], cloneUrl: 'https://github.com/hoangsonww/PetSwipe-Match-App.git' },
	{ owner: 'JeanCaicedo', repo: 'employees-api-mysql', ref: 'e18789656adc0c91f96d0124fbdfefd86f7bf545', path: null, terms: ['employee'], cloneUrl: 'https://github.com/JeanCaicedo/employees-api-mysql.git' },
];

// Finds the index of the first ":" that is NOT immediately followed by "//" -- i.e. a real
// `:subpath` separator, skipping over URL schemes like "https://". Returns -1 if none found.
function findSubpathSplitIndex(s) {
	let i = 0;
	while (i < s.length) {
		const colon = s.indexOf(':', i);
		if (colon === -1) return -1;
		if (s.slice(colon + 1, colon + 3) === '//') { i = colon + 3; continue; }
		return colon;
	}
	return -1;
}

// "owner/repo[@ref][:subpath][#term1,term2]" -> real github.com clone URL, OR a literal git
// URL/local path (contains "://", or starts with "/"/".") used as-is -- see this file's header
// for why the literal form and the `:subpath` form exist. `ref` (owner/repo shorthand only)
// defaults to null (git's own default branch, no `-b` passed to clone) or may be a real commit
// SHA (see `shadowValidateOne`'s own SHA-vs-branch clone-path selection); `terms` is REQUIRED --
// see this file's own header for why guessing terms is not something this script does.
function parseRepoSpec(spec) {
	const [beforeTerms, termsPart] = spec.split('#');
	const terms = termsPart ? termsPart.split(',').map((s) => s.trim()).filter(Boolean) : [];
	if (terms.length === 0) fail(`repo spec "${spec}" has no search terms -- \`bskel scan\` refuses to run with zero terms (confirmed live), so a custom repo spec must carry its own, e.g. "${beforeTerms}#owner,pet"`);

	const splitIdx = findSubpathSplitIndex(beforeTerms);
	const target = splitIdx === -1 ? beforeTerms : beforeTerms.slice(0, splitIdx);
	const subpath = splitIdx === -1 ? null : (beforeTerms.slice(splitIdx + 1) || null);

	const isLiteral = target.includes('://') || target.startsWith('/') || target.startsWith('.');
	if (isLiteral) {
		return { owner: null, repo: target, ref: null, path: subpath, terms, cloneUrl: target };
	}

	const [ownerRepo, ref] = target.split('@');
	const [owner, repo] = ownerRepo.split('/');
	if (!owner || !repo) fail(`invalid repo spec "${spec}" -- expected owner/repo[@ref][:subpath][#term1,term2] or a literal git URL/local path[:subpath][#term1,term2]`);
	return { owner, repo, ref: ref ?? null, path: subpath, terms, cloneUrl: `https://github.com/${owner}/${repo}.git` };
}

// Reads and schema-validates a committed oracle-corpus manifest, flattening every adapter's
// entries (optionally filtered to one adapter) into the same shape `parseRepoSpec` produces, plus
// `manifestId`/`expectedAdapter` for this file's own manifest-mode adapter cross-check (see the
// main flow below).
function parseManifest(manifestPath, adapterFilter) {
	let data;
	try {
		data = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
	} catch (err) {
		fail(`could not read/parse manifest "${manifestPath}": ${err.message}`);
	}
	const { ok, errors } = validateAgainstSchema('oracle-manifest.schema.json', data);
	if (!ok) fail(`manifest "${manifestPath}" failed schema validation:\n${formatSchemaErrors(errors).join('\n')}`);

	if (adapterFilter && !Object.hasOwn(data.adapters, adapterFilter)) {
		fail(`--adapter "${adapterFilter}" has no entries in manifest "${manifestPath}" (known: ${Object.keys(data.adapters).join(', ')})`);
	}

	const entries = [];
	for (const [adapterId, list] of Object.entries(data.adapters)) {
		if (adapterFilter && adapterId !== adapterFilter) continue;
		for (const e of list) {
			// `owner: null` is the local-test literal form (schemas/oracle-manifest.schema.json's
			// own description) -- `repo` is used as-is as the clone URL/path, matching
			// `parseRepoSpec`'s own literal form. Every real corpus entry names a real owner.
			entries.push({
				owner: e.owner ?? null,
				repo: e.repo,
				ref: e.ref ?? null,
				path: e.path ?? null,
				terms: e.terms,
				cloneUrl: e.owner ? `https://github.com/${e.owner}/${e.repo}.git` : e.repo,
				manifestId: e.id,
				expectedAdapter: adapterId,
			});
		}
	}
	return entries;
}

function parseArgs(argv) {
	const out = { out: null, manifest: null, adapter: null, repos: [] };
	const rest = [];
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === '--out') { out.out = argv[++i]; continue; }
		if (argv[i] === '--manifest') { out.manifest = argv[++i]; continue; }
		if (argv[i] === '--adapter') { out.adapter = argv[++i]; continue; }
		rest.push(argv[i]);
	}
	if (out.manifest) {
		if (rest.length > 0) fail(`--manifest cannot be combined with positional repo specs (got: ${rest.join(', ')})`);
		out.repos = parseManifest(out.manifest, out.adapter);
	} else {
		if (out.adapter) fail('--adapter only applies together with --manifest');
		out.repos = rest.length > 0 ? rest.map(parseRepoSpec) : DEFAULT_REPOS;
	}
	return out;
}

function sh(cmd, args, cwd) {
	return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: 'pipe' });
}

function bskelJson(args, cwd, label) {
	const r = bskel([...args, '--json'], cwd);
	if (![0, 3].includes(r.code)) fail(`${label}: exit ${r.code}: ${r.stderr || r.stdout}`);
	try {
		return JSON.parse(r.stdout);
	} catch (err) {
		fail(`${label}: could not parse JSON output: ${err.message}\n${r.stdout}`);
	}
}

const SHA_RE = /^[0-9a-f]{40}$/i;

function shadowValidateOne({ owner, repo, ref, path: subpath, terms, cloneUrl, manifestId, expectedAdapter }) {
	const repoSlug = owner ? `${owner}/${repo}` : repo;
	console.error(`shadow-validation-smoke: ${repoSlug}${ref ? `@${ref}` : ''}${subpath ? `:${subpath}` : ''} (terms: ${terms.join(',')})...`);

	let clonePath = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-shadow-validation-'));
	let bareOriginPath = null;
	try {
		try {
			if (ref && SHA_RE.test(ref)) {
				// D-oracle-corpus-pinning: `git clone -b <ref>` only accepts branch/tag names --
				// this is the fetch-by-exact-commit path a real 40-hex-char SHA needs instead.
				// A bare `git fetch origin <sha>` + `checkout FETCH_HEAD` leaves a detached HEAD
				// with no `refs/remotes/origin/<branch>` -- confirmed live that `bskel preflight`
				// (even with `--offline`) still resolves the repo's real default branch and fails
				// `WRONG_DEFAULT` when that ref doesn't exist locally. Discovering the real default
				// branch name (`git ls-remote --symref`, the same technique already used to pin
				// every manifest entry's own `ref`) and fetching the SHA straight into
				// `refs/remotes/origin/<branch>` (confirmed live this works against a real
				// fetched-by-exact-SHA request) gives `preflight` exactly the ref shape it expects.
				sh('git', ['init', '--quiet'], clonePath);
				sh('git', ['remote', 'add', 'origin', cloneUrl], clonePath);
				const symref = sh('git', ['ls-remote', '--symref', cloneUrl, 'HEAD'], clonePath);
				const defaultBranch = symref.match(/^ref:\s+refs\/heads\/(\S+)\s+HEAD/m)?.[1] ?? 'main';
				sh('git', ['fetch', '--quiet', '--depth', '1', 'origin', `${ref}:refs/remotes/origin/${defaultBranch}`], clonePath);
				sh('git', ['symbolic-ref', 'refs/remotes/origin/HEAD', `refs/remotes/origin/${defaultBranch}`], clonePath);
				sh('git', ['checkout', '--quiet', '-b', defaultBranch, `refs/remotes/origin/${defaultBranch}`], clonePath);
			} else {
				const cloneArgs = ['clone', '--quiet', '--depth', '1'];
				if (ref) cloneArgs.push('-b', ref);
				cloneArgs.push(cloneUrl, clonePath);
				sh('git', cloneArgs, REPO_ROOT);
			}
		} catch (err) {
			return { repo: repoSlug, ref, terms, manifestId, expectedAdapter, error: `clone failed: ${err.message}` };
		}

		if (subpath) {
			// D-oracle-corpus-pinning: `lib/repo.mjs`'s `repoRoot()` always resolves to the TRUE
			// git top-level (`git rev-parse --show-toplevel`) regardless of cwd -- confirmed live,
			// not assumed -- so simply running `bskel` with cwd inside a subdirectory of a
			// monorepo clone does NOT scope the scan to that subdirectory; it silently re-roots
			// back to the whole clone (real risk for a repo like polarsource/polar, which also
			// carries a TypeScript frontend at the same repo root -- a wrong-adapter
			// mismatch waiting to happen). The only way to make `repoRoot()` agree with the
			// intended scope is a PHYSICALLY separate repo containing only the subpath's files --
			// same scratch-repo-plus-bare-origin convention `db-introspect-smoke.mjs` already
			// established (`preflight`'s own default-branch/freshness check needs a real `origin`
			// remote to compare against).
			const sourceDir = path.join(clonePath, subpath);
			if (!fs.existsSync(sourceDir)) {
				return { repo: repoSlug, ref, path: subpath, terms, manifestId, expectedAdapter, error: `path "${subpath}" does not exist in the clone` };
			}
			const scopedPath = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-shadow-validation-scoped-'));
			fs.cpSync(sourceDir, scopedPath, { recursive: true });
			fs.rmSync(clonePath, { recursive: true, force: true });
			clonePath = scopedPath;

			sh('git', ['init', '--quiet', '--initial-branch=develop'], clonePath);
			sh('git', ['config', 'user.email', 'shadow-validation-smoke@bskel.local'], clonePath);
			sh('git', ['config', 'user.name', 'shadow-validation-smoke'], clonePath);
			sh('git', ['add', '-A'], clonePath);
			sh('git', ['commit', '--quiet', '-m', `scoped snapshot of ${repoSlug}:${subpath}@${ref ?? 'HEAD'}`], clonePath);
			bareOriginPath = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-shadow-validation-scoped-origin-'));
			sh('git', ['init', '--quiet', '--bare', '--initial-branch=develop'], bareOriginPath);
			sh('git', ['remote', 'add', 'origin', bareOriginPath], clonePath);
			sh('git', ['push', '--quiet', 'origin', 'develop'], clonePath);
		}

		// Scan-layer pass -- ad-hoc, no --feature, matching the original manual pass's own
		// read-only-est mode. `unknowns`/`related_modules` are this project's own real,
		// already-established "here is what I could not confidently resolve" signal (every
		// adapter already populates it; this script surfaces it, it invents nothing new).
		const adHocScan = bskelJson(['scan', '--terms', terms.join(',')], clonePath, 'scan (ad-hoc)');
		const unknownModuleEntry = (adHocScan.related_modules ?? []).find((m) => m.module === '_unknown');

		// Handles-layer pass -- a real feature, still read-only (no contract emit, no handles
		// emit): confirmed live (building this script) that `handles plan` needs neither.
		// `SLUG_RE` (lib/featureid.mjs) rejects consecutive/leading/trailing dashes -- `repo` can be
		// a literal filesystem path full of slashes (the local-fixture test form), so every run of
		// non-alnum chars (not just non-dash ones) collapses to exactly one dash before trimming.
		const featureSlug = `shadow-${repo}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/g, '');
		// D-oracle-corpus-pinning: `--offline` -- a pinned commit SHA is a deliberately FIXED
		// analysis target, not a feature branch that should stay near the real default branch's
		// current tip. Without this, `preflight`'s own freshness gate (real, correct behavior for
		// its normal use case) fails every pinned entry against an actively-developed repo almost
		// immediately -- confirmed live against `mealie-recipes/mealie` (multiple commits/day):
		// `FAIL (STALE_BASE): HEAD is 1 commits behind origin/mealie-next` within minutes of
		// pinning the SHA.
		const preflight = bskel(['preflight', '--offline'], clonePath);
		if (preflight.code !== 0) return { repo: repoSlug, ref, path: subpath, terms, manifestId, expectedAdapter, error: `preflight: ${preflight.stderr || preflight.stdout}` };

		const featureInit = bskelJson(['feature', 'init', '--slug', featureSlug], clonePath, 'feature init');
		const featureId = featureInit.feature_id;

		const featureScan = bskelJson(['scan', '--feature', featureId, '--terms', terms.join(',')], clonePath, 'scan (feature)');
		const relatedModules = featureScan.related_modules ?? [];

		const perModule = [];
		// D-oracle-corpus-pinning: `javascript-express` (confirmed live, not assumed) has no
		// `codegen.handles` provider at all -- by design, see its own descriptor -- and `handles
		// plan` hard-BLOCKs (exit 17) the moment it's asked to plan against such an adapter. This
		// is real, honest, EXPECTED behavior for that adapter, not a script-level failure: the
		// first such refusal is enough to know every remaining module in this repo will refuse
		// identically, so this stops calling `handles plan` at all for the rest of this repo's
		// modules rather than re-discovering the same refusal N times.
		let handlesNotApplicable = null;
		for (const mod of relatedModules) {
			if (mod.module === '_unknown') continue; // nothing to plan handles for -- the module itself IS the finding
			if (handlesNotApplicable) break;
			const r = bskel(['handles', 'plan', '--feature', featureId, '--module', mod.module, '--json'], clonePath);
			if (/requires the `codegen\.handles` capability/.test(r.stderr ?? '')) {
				handlesNotApplicable = `adapter "${adHocScan.adapter}" has no codegen.handles provider`;
				break;
			}
			if (![0, 3].includes(r.code)) fail(`handles plan --module ${mod.module}: exit ${r.code}: ${r.stderr || r.stdout}`);
			let plan;
			try {
				plan = JSON.parse(r.stdout);
			} catch (err) {
				fail(`handles plan --module ${mod.module}: could not parse JSON output: ${err.message}\n${r.stdout}`);
			}
			const resources = plan.resources ?? [];
			perModule.push({
				module: mod.module,
				resources_planned: resources.length,
				zero_resolver_count: resources.filter((r) => r.willGenerateResolver === false).length,
				notes: plan.notes ?? [],
			});
		}

		return {
			repo: repoSlug,
			ref,
			path: subpath,
			terms,
			manifestId,
			expectedAdapter,
			adapter: adHocScan.adapter,
			verdict: adHocScan.verdict,
			related_modules_count: (adHocScan.related_modules ?? []).length,
			unknown_module_entities: unknownModuleEntry ? (unknownModuleEntry.entities ?? []).length + (unknownModuleEntry.controllers ?? []).length : 0,
			scan_unknowns: adHocScan.unknowns ?? [],
			handles: perModule,
			handles_not_applicable: handlesNotApplicable,
		};
	} finally {
		fs.rmSync(clonePath, { recursive: true, force: true });
		if (bareOriginPath) fs.rmSync(bareOriginPath, { recursive: true, force: true });
	}
}

const { out, repos } = parseArgs(process.argv.slice(2));
const report = repos.map(shadowValidateOne);

for (const r of report) {
	if (r.error) {
		console.error(`shadow-validation-smoke: ${r.repo}: FAILED -- ${r.error}`);
		continue;
	}
	const zeroResolverTotal = r.handles.reduce((sum, m) => sum + m.zero_resolver_count, 0);
	const resourcesTotal = r.handles.reduce((sum, m) => sum + m.resources_planned, 0);
	const handlesSummary = r.handles_not_applicable ? `handles=n/a (${r.handles_not_applicable})` : `resources_planned=${resourcesTotal} zero_resolver=${zeroResolverTotal}`;
	console.error(`shadow-validation-smoke: ${r.repo}: adapter=${r.adapter} verdict=${r.verdict} related_modules=${r.related_modules_count} unknown_module_entities=${r.unknown_module_entities} scan_unknowns=${r.scan_unknowns.length} ${handlesSummary}`);
	if (r.expectedAdapter && r.adapter !== r.expectedAdapter) {
		console.error(`shadow-validation-smoke: ${r.repo}: MANIFEST MISMATCH -- declared adapter "${r.expectedAdapter}" but scan detected "${r.adapter}"`);
	}
}

const anyScriptFailure = report.some((r) => r.error);
// D-oracle-corpus-pinning: unlike every other check in this script, a manifest entry's declared
// adapter not matching what `scan` actually detects is a genuine manifest/reality mismatch, not
// diagnostic data -- it means the manifest itself is wrong (e.g. a repo drifted, or an entry was
// filed under the wrong adapter), so this hard-fails alongside real script-level failures.
const anyAdapterMismatch = report.some((r) => !r.error && r.expectedAdapter && r.adapter !== r.expectedAdapter);
const reportJson = JSON.stringify(report, null, 2);
if (out) {
	fs.writeFileSync(out, reportJson);
	console.error(`shadow-validation-smoke: wrote ${out}`);
} else {
	console.log(reportJson);
}

if (anyScriptFailure || anyAdapterMismatch) {
	console.error(`shadow-validation-smoke: FAIL -- ${anyScriptFailure ? 'at least one repo could not be cloned/scanned/planned' : ''}${anyScriptFailure && anyAdapterMismatch ? '; ' : ''}${anyAdapterMismatch ? 'at least one manifest entry declared the wrong adapter' : ''} (see above)`);
	process.exit(1);
}
console.error(`shadow-validation-smoke: PASS -- ${report.length} repo(s) shadow-validated (findings are data, not a failure -- see the report above/${out ?? 'stdout'})`);
