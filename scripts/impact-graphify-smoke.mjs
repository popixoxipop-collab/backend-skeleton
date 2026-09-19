#!/usr/bin/env node
// D-cross-feature-impact-graph (S1, IG8): the first automated proof that `bskel impact export
// --format graphify`'s output is not just schema-shaped but genuinely CONSUMABLE by the real,
// installed graphify skill -- a hand-built fixture in test/impact-export-graphify.test.mjs can
// only confirm the exporter's OWN output shape; it cannot prove graphify's real
// build_from_json()/cluster()/to_obsidian() actually accept it and produce a real vault. Manually
// verified once while writing this item (real 6-node/3-edge extraction -> 3 Leiden communities ->
// a real Obsidian vault with one note per node); this script makes that proof repeatable and
// CI-checkable rather than a one-off transcript.
//
// Skipped (visibly counted, not silently) when the graphify venv is absent -- matching this
// project's own D-repo-gated-skip-visibility posture (a skip must be countable, never silent).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const CLI = path.join(REPO_ROOT, 'bin', 'bskel.mjs');
const GRAPHIFY_PYTHON = path.join(os.homedir(), '.claude', 'skills', 'graphify', '.venv', 'bin', 'python3');

function fail(message) {
	console.error(`impact-graphify-smoke: FAIL -- ${message}`);
	process.exit(1);
}

if (!fs.existsSync(GRAPHIFY_PYTHON)) {
	console.log(`impact-graphify-smoke: SKIP (1) -- graphify venv not found at ${GRAPHIFY_PYTHON}`);
	process.exit(0);
}

function bskel(args, cwd) {
	try {
		const stdout = execFileSync('node', [CLI, ...args], { cwd, encoding: 'utf8', env: { ...process.env } });
		return { code: 0, stdout };
	} catch (err) {
		return { code: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
	}
}

// A minimal, self-contained two-feature fixture (mirrors test/_contract-fixture.mjs's own
// buildTwoFeatureFixtureRepo()/initBothFeatures(), reimplemented standalone so this script has no
// dependency on the test/ tree -- scripts/ has never imported from test/ anywhere in this repo).
function buildFixture() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-impact-graphify-smoke-'));
	execFileSync('git', ['init', '--quiet', '--initial-branch=develop'], { cwd: root });
	execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
	execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
	fs.writeFileSync(path.join(root, 'build.gradle'), '// fixture\n');

	const widgetDir = path.join(root, 'src/main/java/com/example/domain/widget/presentation/dto');
	fs.mkdirSync(widgetDir, { recursive: true });
	fs.writeFileSync(path.join(widgetDir, 'WidgetDto.java'), 'package com.example.domain.widget.presentation.dto;\npublic record WidgetDto(String name) {}\n');

	const orgDir = path.join(root, 'src/main/java/com/example/domain/organization/presentation/dto');
	fs.mkdirSync(orgDir, { recursive: true });
	fs.writeFileSync(path.join(orgDir, 'OrganizationDto.java'), 'package com.example.domain.organization.presentation.dto;\npublic record OrganizationDto(String taxRate) {}\n');

	fs.writeFileSync(path.join(root, '.gitignore'), 'specs/\n.sbf/\n');
	execFileSync('git', ['add', '-A'], { cwd: root });
	execFileSync('git', ['commit', '--quiet', '-m', 'chore: impact-graphify-smoke fixture'], { cwd: root });
	const bareOrigin = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-impact-graphify-smoke-origin-'));
	execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=develop'], { cwd: bareOrigin });
	execFileSync('git', ['remote', 'add', 'origin', bareOrigin], { cwd: root });
	execFileSync('git', ['push', '--quiet', 'origin', 'develop'], { cwd: root });

	bskel(['preflight'], root);
	bskel(['feature', 'init', '--slug', 'widget-management'], root);
	bskel(['scan', '--feature', '001-widget-management', '--terms', 'widget'], root);
	bskel(['scan', 'disposition', '--feature', '001-widget-management', '--mode', 'reuse', '--note', 'x'], root);
	bskel(['feature', 'init', '--slug', 'organization-management'], root);
	bskel(['scan', '--feature', '002-organization-management', '--terms', 'organization'], root);
	bskel(['scan', 'disposition', '--feature', '002-organization-management', '--mode', 'reuse', '--note', 'x'], root);
	const declare = bskel([
		'dependency', 'declare', '--feature', '001-widget-management', '--resource', 'WidgetDto', '--field', 'name',
		'--source-feature', '002-organization-management', '--source-resource', 'OrganizationDto', '--source-field', 'taxRate',
		'--reason', 'impact-graphify-smoke fixture edge',
	], root);
	if (declare.code !== 0) fail(`fixture setup: dependency declare failed -- ${declare.stderr}`);
	return root;
}

const root = buildFixture();
const extractFile = path.join(root, '.graphify_extract.json');
const exportResult = bskel(['impact', 'export', '--format', 'graphify', '--out', extractFile], root);
if (exportResult.code !== 0) fail(`bskel impact export --format graphify exited ${exportResult.code}: ${exportResult.stderr}`);
if (!fs.existsSync(extractFile)) fail('impact export claimed success but wrote no file');

const extraction = JSON.parse(fs.readFileSync(extractFile, 'utf8'));
if (extraction.nodes.length === 0) fail('extraction has zero nodes');
if (!extraction.edges.some((e) => e.relation === 'derives_from')) fail('extraction is missing the expected derives_from edge');
for (const e of extraction.edges) {
	if (!['EXTRACTED', 'INFERRED'].includes(e.confidence)) fail(`edge confidence "${e.confidence}" is neither EXTRACTED nor INFERRED -- AMBIGUOUS must never be emitted`);
}

const vaultDir = path.join(root, 'vault');
const pyScript = `
import json, sys
from graphify.build import build_from_json
from graphify.cluster import cluster
from graphify.export import to_obsidian

extraction = json.loads(open(${JSON.stringify(extractFile)}).read())
G = build_from_json(extraction, directed=True)
if G.number_of_nodes() != len(extraction["nodes"]):
    print(f"FAIL: graph has {G.number_of_nodes()} nodes, extraction had {len(extraction['nodes'])}", file=sys.stderr)
    sys.exit(1)
if G.number_of_edges() != len(extraction["edges"]):
    print(f"FAIL: graph has {G.number_of_edges()} edges, extraction had {len(extraction['edges'])}", file=sys.stderr)
    sys.exit(1)
communities = cluster(G)
to_obsidian(G, communities, ${JSON.stringify(vaultDir)})
print("OK", G.number_of_nodes(), G.number_of_edges(), len(communities))
`;
let pyOut;
try {
	pyOut = execFileSync(GRAPHIFY_PYTHON, ['-c', pyScript], { encoding: 'utf8' });
} catch (err) {
	fail(`real graphify build_from_json/cluster/to_obsidian round-trip failed: ${err.stderr || err.message}`);
}
if (!pyOut.startsWith('OK')) fail(`unexpected graphify output: ${pyOut}`);

if (!fs.existsSync(vaultDir)) fail('to_obsidian claimed success but wrote no vault directory');
const vaultFiles = fs.readdirSync(vaultDir);
if (!vaultFiles.some((f) => f.endsWith('.md'))) fail('obsidian vault has no .md notes');
if (!vaultFiles.some((f) => f.startsWith('_COMMUNITY_'))) fail('obsidian vault has no community note -- cluster() may not have run');

console.log(`impact-graphify-smoke: PASS -- real extraction (${extraction.nodes.length} nodes, ${extraction.edges.length} edges) round-tripped through the real graphify skill: ${pyOut.trim()}, vault has ${vaultFiles.length} files`);
