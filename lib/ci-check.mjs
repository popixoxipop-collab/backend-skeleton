// PR-native, read-only verification.  This is intentionally a composition layer over the
// existing verify/workflow primitives: it chooses features from a git diff, then reports their
// normal gate/artifact/build verdicts and the normal `bskel next` remediation.  It never passes,
// refreshes, or otherwise changes a gate.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { localDefaultBranch, headSha } from './repo.mjs';
import { listFeatures } from './featurelifecycle.mjs';
import { evaluateFeatureVerification } from './verify.mjs';
import { computeWorkflowState } from './workflow.mjs';
import { requireValidFeatureId } from './featureid.mjs';

function git(root, args) {
	return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function tryGit(root, args) {
	try { return git(root, args); } catch { return null; }
}

export function defaultCiBase(root, env = process.env) {
	// GitHub gives the immutable PR base SHA when available; it wins over a movable branch name.
	// `GITHUB_BASE_REF` is useful on minimally configured CI and local `origin/HEAD` is the
	// deterministic non-CI fallback.  We deliberately never assume `main`.
	let eventBaseSha = null;
	if (env.GITHUB_EVENT_PATH) {
		try { eventBaseSha = JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, 'utf8'))?.pull_request?.base?.sha ?? null; } catch { /* the env variable is advisory */ }
	}
	return env.GITHUB_EVENT_PULL_REQUEST_BASE_SHA
		|| eventBaseSha
		|| env.GITHUB_BASE_REF
		|| localDefaultBranch(root)
		|| null;
}

export function resolveCiBase(root, requestedBase, env = process.env) {
	const requested = requestedBase || defaultCiBase(root, env);
	if (!requested) {
		return { ok: false, message: 'could not determine a base ref: pass --base <ref>, set GITHUB_EVENT_PULL_REQUEST_BASE_SHA/GITHUB_BASE_REF, or configure origin/HEAD (bskel never guesses main)' };
	}
	const sha = tryGit(root, ['rev-parse', '--verify', '--quiet', `${requested}^{commit}`])
		|| (!String(requested).startsWith('origin/') ? tryGit(root, ['rev-parse', '--verify', '--quiet', `origin/${requested}^{commit}`]) : null);
	if (!sha) return { ok: false, message: `cannot resolve base ref "${requested}" locally -- fetch it first or pass an existing commit/ref with --base` };
	return { ok: true, requested, sha };
}

function changedFiles(root, mergeBase) {
	try {
		const raw = execFileSync('git', ['diff', '--name-only', '-z', `${mergeBase}...HEAD`], { cwd: root, encoding: 'utf8' });
		return raw.split('\0').filter(Boolean).sort((a, b) => a.localeCompare(b));
	} catch (err) {
		throw new Error(`could not list changed files from ${mergeBase}...HEAD: ${err.message}`);
	}
}

function isDocumentationPath(file) {
	return file === 'README.md'
		|| file === 'SKILL.md'
		|| file === 'DECISIONS.md'
		|| file === 'ROADMAP.md'
		|| file === 'CATALOG.md'
		|| file === 'LICENSE'
		|| file === 'COMMERCIAL-LICENSE.md'
		|| file === 'COMMERCIAL-LICENSE-AGREEMENT.md'
		|| file.startsWith('docs/');
}

function featureIdForPath(file, activeIds) {
	const match = /^specs\/([^/]+)\//.exec(file);
	return match && activeIds.has(match[1]) ? match[1] : null;
}

export function selectCiFeatures({ activeFeatures, changed, requestedFeatures = null }) {
	const activeIds = activeFeatures.map((f) => f.feature_id).sort((a, b) => a.localeCompare(b));
	const activeSet = new Set(activeIds);
	if (requestedFeatures !== null) {
		const requested = [...new Set(requestedFeatures)].sort((a, b) => a.localeCompare(b));
		const unknown = requested.filter((id) => !activeSet.has(id));
		if (unknown.length) throw new Error(`--feature names no active feature: ${unknown.join(', ')} (active: ${activeIds.join(', ') || '(none)'})`);
		return { selectedFeatures: requested, selectionReason: 'explicit_feature' };
	}

	const scoped = new Set();
	let sharedProductChange = false;
	for (const file of changed) {
		const featureId = featureIdForPath(file, activeSet);
		if (featureId) scoped.add(featureId);
		else if (!isDocumentationPath(file)) sharedProductChange = true;
	}
	if (sharedProductChange) return { selectedFeatures: activeIds, selectionReason: 'shared_product_change_all_active' };
	if (scoped.size > 0) return { selectedFeatures: [...scoped].sort((a, b) => a.localeCompare(b)), selectionReason: 'feature_scoped_changes' };
	return { selectedFeatures: [], selectionReason: changed.length === 0 ? 'no_changes' : 'documentation_only_or_no_active_feature_change' };
}

function parseFeatureList(value) {
	if (value == null) return null;
	const values = value.split(',').map((v) => v.trim()).filter(Boolean);
	if (values.length === 0) throw new Error('--feature must name at least one comma-separated feature id');
	for (const id of values) requireValidFeatureId(id);
	return values;
}

export function runCiCheck(root, { base = null, feature = null, build = false, allowSkipBuild = false, env = process.env } = {}) {
	const baseResult = resolveCiBase(root, base, env);
	if (!baseResult.ok) return { ok: false, badBase: true, message: baseResult.message };
	const mergeBase = tryGit(root, ['merge-base', baseResult.sha, 'HEAD']);
	if (!mergeBase) return { ok: false, badBase: true, message: `cannot compute a merge-base between ${baseResult.requested} (${baseResult.sha}) and HEAD -- pass a related --base ref` };
	const changed = changedFiles(root, mergeBase);
	const activeFeatures = listFeatures(root);
	let selection;
	try {
		selection = selectCiFeatures({ activeFeatures, changed, requestedFeatures: parseFeatureList(feature) });
	} catch (err) {
		return { ok: false, badArgs: true, message: err.message };
	}
	const common = {
		schema: 'sbf.ci-check/1',
		base: { requested: baseResult.requested, sha: baseResult.sha },
		merge_base: mergeBase,
		head: headSha(root),
		changed_files: changed,
		changed_file_count: changed.length,
		selection_reason: selection.selectionReason,
		selected_features: selection.selectedFeatures,
	};
	if (selection.selectedFeatures.length === 0) {
		return { ...common, ok: true, outcome: 'noop', features: [], issues: [] };
	}
	const features = selection.selectedFeatures.map((featureId) => {
		const verification = evaluateFeatureVerification(root, featureId, { build, allowSkipBuild });
		const workflow = computeWorkflowState(root, featureId);
		return { ...verification, remediation: workflow.next_actions[0] ?? null };
	});
	const issues = collectIssues(features);
	return { ...common, ok: issues.length === 0, outcome: issues.length === 0 ? 'pass' : 'fail', features, issues };
}

function featureLocation(featureId) {
	return `specs/${featureId}/feature.json`;
}

export function collectIssues(features) {
	const issues = [];
	for (const report of features) {
		for (const gate of report.gates.filter((g) => g.blocking)) {
			issues.push({ kind: 'gate', feature: report.feature, name: gate.gate, path: featureLocation(report.feature), message: `${report.feature}: ${gate.gate} gate is ${gate.status}` });
		}
		for (const artifact of report.artifacts.filter((a) => !a.exists)) {
			issues.push({ kind: 'artifact', feature: report.feature, name: artifact.artifact, path: artifact.path, message: `${report.feature}: missing ${artifact.artifact} (${artifact.path})` });
		}
		if (report.build_blocking) {
			issues.push({ kind: 'build', feature: report.feature, name: report.build.tool ?? 'build', path: 'package.json', message: `${report.feature}: ${report.build.message ?? `${report.build.tool} build failed`}` });
		}
	}
	return issues.sort((a, b) => [a.feature, a.kind, a.name, a.path].join('\0').localeCompare([b.feature, b.kind, b.name, b.path].join('\0')));
}

export function renderCiSummary(report) {
	const lines = ['# backend-skeleton PR check', '', `- Outcome: **${report.outcome ?? 'error'}**`];
	if (report.base) lines.push(`- Base: \`${report.base.requested}\` (${report.base.sha})`, `- Merge base: \`${report.merge_base}\``, `- Head: \`${report.head}\``);
	if (report.changed_file_count != null) lines.push(`- Changed files: ${report.changed_file_count}`, `- Selection: \`${report.selection_reason}\``);
	if (report.selected_features) lines.push(`- Selected features: ${report.selected_features.length ? report.selected_features.map((id) => `\`${id}\``).join(', ') : '(none)'}`);
	if (report.outcome === 'noop') return `${lines.concat(['', 'No active feature requires verification for this diff.']).join('\n')}\n`;
	lines.push('', '## Features');
	for (const feature of report.features ?? []) {
		lines.push(`- [${feature.pass ? 'PASS' : 'FAIL'}] \`${feature.feature}\`${feature.remediation ? ` — next: \`${feature.remediation.command}\`` : ''}`);
	}
	if (report.issues?.length) {
		lines.push('', '## Blocking issues');
		for (const issue of report.issues) lines.push(`- \`${issue.feature}\`: ${issue.message}`);
	}
	return `${lines.join('\n')}\n`;
}

export function toSarif(report) {
	const results = (report.issues ?? []).map((issue) => ({
		ruleId: `bskel/${issue.kind}`,
		level: 'error',
		message: { text: issue.message },
		locations: issue.path ? [{ physicalLocation: { artifactLocation: { uri: issue.path.replaceAll(path.sep, '/') } } }] : [],
	}));
	return {
		$schema: 'https://json.schemastore.org/sarif-2.1.0.json',
		version: '2.1.0',
		runs: [{
			tool: { driver: { name: 'backend-skeleton', informationUri: 'https://github.com/popixoxipop-collab/backend-skeleton', rules: [
				{ id: 'bskel/gate', shortDescription: { text: 'A required bskel gate is not passing' } },
				{ id: 'bskel/artifact', shortDescription: { text: 'A required bskel artifact is missing' } },
				{ id: 'bskel/build', shortDescription: { text: 'The requested build check did not pass' } },
			] } },
			results,
		}],
	};
}
