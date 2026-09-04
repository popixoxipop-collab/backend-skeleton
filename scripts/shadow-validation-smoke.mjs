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
// failure (a clone failed, `bskel` crashed unexpectedly), never because a repo's own findings
// look bad (a `_unknown` module bucket or a zero-resolver count is DATA this script surfaces, not
// something it judges). Deliberately NOT wired into `test:all-smoke` or any CI job: every other
// smoke script runs against this project's own pinned fixtures; this one clones live, unpinned,
// third-party repos over the network, and ROADMAP Phase 5b (not this item) is the one that pins
// specific repos to specific commit SHAs, the prerequisite for including something like this in a
// CI gate reliably.
//
// Usage:
//   node scripts/shadow-validation-smoke.mjs                      -- the 3 default oracles below
//   node scripts/shadow-validation-smoke.mjs owner/repo[@ref][#term1,term2] ...
//   node scripts/shadow-validation-smoke.mjs <git-url-or-local-path>[#term1,term2] ...
//   node scripts/shadow-validation-smoke.mjs --out report.json ...  -- JSON array written to a file
//
// `scan` (confirmed live, not assumed) hard-refuses with BAD_ARGS when given zero search terms --
// there is no "just show me everything" mode, so every repo spec here carries real terms. The 3
// defaults below are the exact real terms that already found real modules against these exact
// repos (verified live while building this script): "owner" against spring-petclinic's real
// Owner/Pet/PetType/Visit domain, "item" against full-stack-fastapi-template's real `items`
// module, "user" against typeorm-express-typescript's real `users` module. A caller pointing this
// at an unfamiliar repo must supply their own terms (the `#term1,term2` suffix) for the same
// reason a human running `bskel scan` by hand would need to -- this script does not, and cannot,
// guess what a repo's own domain vocabulary is.
//
// A spec is either `owner/repo[@ref]` (expanded to a real github.com clone URL) or a literal git
// URL/local path (anything containing "://", or starting with "/" or ".") -- the literal form
// exists so `test/shadow-validation-cli.test.mjs` can point this at a local bare repo (same
// scratch-repo-plus-bare-origin convention `db-introspect-smoke.mjs` already uses) and cover the
// real clone -> scan -> plan -> report path without a network dependency, not because a real user
// is expected to reach for it often.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { bskel, makeFail, REPO_ROOT } from './_smoke-lib.mjs';

const fail = makeFail('shadow-validation-smoke');

const DEFAULT_REPOS = [
	{ owner: 'spring-projects', repo: 'spring-petclinic', ref: 'main', terms: ['owner'], cloneUrl: 'https://github.com/spring-projects/spring-petclinic.git' },
	{ owner: 'fastapi', repo: 'full-stack-fastapi-template', ref: 'master', terms: ['item'], cloneUrl: 'https://github.com/fastapi/full-stack-fastapi-template.git' },
	{ owner: 'mkosir', repo: 'typeorm-express-typescript', ref: 'main', terms: ['user'], cloneUrl: 'https://github.com/mkosir/typeorm-express-typescript.git' },
];

// "owner/repo[@ref][#term1,term2]" -> real github.com clone URL, OR a literal git URL/local path
// (contains "://", or starts with "/"/".") used as-is -- see this file's header for why the
// literal form exists. `ref` (owner/repo shorthand only) defaults to null (git's own default
// branch, no `-b` passed to clone); `terms` is REQUIRED -- see this file's own header for why
// guessing terms is not something this script does.
function parseRepoSpec(spec) {
	const [beforeTerms, termsPart] = spec.split('#');
	const terms = termsPart ? termsPart.split(',').map((s) => s.trim()).filter(Boolean) : [];
	if (terms.length === 0) fail(`repo spec "${spec}" has no search terms -- \`bskel scan\` refuses to run with zero terms (confirmed live), so a custom repo spec must carry its own, e.g. "${beforeTerms}#owner,pet"`);

	const isLiteral = beforeTerms.includes('://') || beforeTerms.startsWith('/') || beforeTerms.startsWith('.');
	if (isLiteral) {
		return { owner: null, repo: beforeTerms, ref: null, terms, cloneUrl: beforeTerms };
	}

	const [ownerRepo, ref] = beforeTerms.split('@');
	const [owner, repo] = ownerRepo.split('/');
	if (!owner || !repo) fail(`invalid repo spec "${spec}" -- expected owner/repo[@ref][#term1,term2] or a literal git URL/local path[#term1,term2]`);
	return { owner, repo, ref: ref ?? null, terms, cloneUrl: `https://github.com/${owner}/${repo}.git` };
}

function parseArgs(argv) {
	const out = { out: null, repos: [] };
	const rest = [];
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === '--out') { out.out = argv[++i]; continue; }
		rest.push(argv[i]);
	}
	out.repos = rest.length > 0 ? rest.map(parseRepoSpec) : DEFAULT_REPOS;
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

function shadowValidateOne({ owner, repo, ref, terms, cloneUrl }) {
	const repoSlug = owner ? `${owner}/${repo}` : repo;
	console.error(`shadow-validation-smoke: ${repoSlug}${ref ? `@${ref}` : ''} (terms: ${terms.join(',')})...`);

	const clonePath = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-shadow-validation-'));
	try {
		const cloneArgs = ['clone', '--quiet', '--depth', '1'];
		if (ref) cloneArgs.push('-b', ref);
		cloneArgs.push(cloneUrl, clonePath);
		try {
			sh('git', cloneArgs, REPO_ROOT);
		} catch (err) {
			return { repo: repoSlug, ref, terms, error: `clone failed: ${err.message}` };
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
		const preflight = bskel(['preflight'], clonePath);
		if (preflight.code !== 0) return { repo: repoSlug, ref, terms, error: `preflight: ${preflight.stderr || preflight.stdout}` };

		const featureInit = bskelJson(['feature', 'init', '--slug', featureSlug], clonePath, 'feature init');
		const featureId = featureInit.feature_id;

		const featureScan = bskelJson(['scan', '--feature', featureId, '--terms', terms.join(',')], clonePath, 'scan (feature)');
		const relatedModules = featureScan.related_modules ?? [];

		const perModule = [];
		for (const mod of relatedModules) {
			if (mod.module === '_unknown') continue; // nothing to plan handles for -- the module itself IS the finding
			const plan = bskelJson(['handles', 'plan', '--feature', featureId, '--module', mod.module], clonePath, `handles plan --module ${mod.module}`);
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
			terms,
			adapter: adHocScan.adapter,
			verdict: adHocScan.verdict,
			related_modules_count: (adHocScan.related_modules ?? []).length,
			unknown_module_entities: unknownModuleEntry ? (unknownModuleEntry.entities ?? []).length + (unknownModuleEntry.controllers ?? []).length : 0,
			scan_unknowns: adHocScan.unknowns ?? [],
			handles: perModule,
		};
	} finally {
		fs.rmSync(clonePath, { recursive: true, force: true });
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
	console.error(`shadow-validation-smoke: ${r.repo}: adapter=${r.adapter} verdict=${r.verdict} related_modules=${r.related_modules_count} unknown_module_entities=${r.unknown_module_entities} scan_unknowns=${r.scan_unknowns.length} resources_planned=${resourcesTotal} zero_resolver=${zeroResolverTotal}`);
}

const anyScriptFailure = report.some((r) => r.error);
const reportJson = JSON.stringify(report, null, 2);
if (out) {
	fs.writeFileSync(out, reportJson);
	console.error(`shadow-validation-smoke: wrote ${out}`);
} else {
	console.log(reportJson);
}

if (anyScriptFailure) {
	console.error('shadow-validation-smoke: FAIL -- at least one repo could not be cloned/scanned/planned (see above)');
	process.exit(1);
}
console.error(`shadow-validation-smoke: PASS -- ${report.length} repo(s) shadow-validated (findings are data, not a failure -- see the report above/${out ?? 'stdout'})`);
