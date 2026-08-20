// D5: `bskel doctor`'s check computation, separated from CLI glue (bin/bskel.mjs) the same way
// D1's lib/workflow.mjs separates `computeWorkflowState()` from its cmdStatus/cmdNext callers --
// this stays pure enough to unit test without spawning the CLI, and bin/bskel.mjs just renders
// whatever this returns.
import { execFileSync } from 'node:child_process';
import { detectBuildCommand } from './verify.mjs';
import { listCatalogChoices, loadCatalogEntry } from '../stack/apply.mjs';

// D5: the three workflows that have tool requirements beyond "git + a supported Node runtime"
// (every workflow needs those two -- preflight/contract don't need anything ELSE, so they're
// deliberately not `--workflow` choices; see D-doctor-workflow in DECISIONS.md).
export const WORKFLOWS = Object.freeze(['scan', 'handles', 'stack']);

// contracts/validate.mjs's `import.meta.dirname` needs Node >=20.11.0 (backported) / >=21.2.0 --
// it does not exist on any 18.x/19.x/20.0-20.10 runtime. package.json's declared ">=18" engines
// floor is inaccurate (tracked separately as CATALOG.md's P1 -- fixing the declared floor itself
// is P1's job, not this one); doctor checks against the REAL requirement, not the wrong one.
// P3 (D-fixture-corpus): exported so test/ci-workflow.test.mjs can assert the CI Node matrix
// never drifts below this floor -- the single source of truth for "what Node version does this
// tool actually need", not a second hand-copied number in the workflow file.
export const MIN_NODE = { major: 20, minor: 11 };

function nodeVersionOk(versionString) {
	const [major, minor] = versionString.split('.').map(Number);
	return major > MIN_NODE.major || (major === MIN_NODE.major && minor >= MIN_NODE.minor);
}

function binaryCheck(name, { required, remediation }) {
	let ok = true;
	let detail = '';
	try {
		execFileSync(name, ['--version'], { stdio: 'pipe' });
	} catch {
		ok = false;
		detail = 'not found on PATH';
	}
	return { name: `binary: ${name}`, required, ok, detail, remediation: ok ? null : remediation };
}

function nodeVersionCheck() {
	const version = process.versions.node;
	const ok = nodeVersionOk(version);
	return {
		name: 'Node version',
		required: true,
		ok,
		detail: `running v${version}`,
		remediation: ok ? null : (
			`this Node runtime (v${version}) is older than what backend-skeleton actually needs ` +
			`(>=${MIN_NODE.major}.${MIN_NODE.minor}.0, for import.meta.dirname in contracts/validate.mjs) -- ` +
			'package.json\'s declared ">=18" engines floor is inaccurate, see P1 in CATALOG.md. Upgrade Node.'
		),
	};
}

// D5: not a PATH-binary check -- `bskel` itself never invokes `java`/`gradle`/`mvn` directly.
// `handles emit`/`handles plan` only WRITE .java files, never compile them; the only place this
// project runs a build at all is `bskel verify --build`, which needs a recognized WRAPPER SCRIPT
// present in the target repo (see lib/verify.mjs's detectBuildCommand -- reused here, not
// reimplemented, so this check and `verify --build` can never disagree about what "found" means).
function buildWrapperCheck(root) {
	const build = detectBuildCommand(root);
	return {
		name: 'build wrapper',
		required: false,
		ok: Boolean(build),
		detail: build ? `${build.tool} (${build.cmd})` : 'no gradlew, pom.xml, or package.json found at repo root',
		remediation: build ? null : (
			'no recognized build wrapper found -- `bskel verify --build` will have nothing to run. ' +
			'Not required for `handles emit` itself, which only writes .java files and never compiles them.'
		),
	};
}

// D5: sourced from stack/catalog/*.yml's own `runtime.requires` field (schemas/stack-choice.
// schema.json) rather than a hardcoded ["curl", "ngrok"] list here -- a future catalog entry
// declares its own runtime binaries and doctor picks them up with zero code changes, the same
// "fill a schema field, it applies globally" pattern D7/G1 already established for this project.
function stackToolChecks(root) {
	const neededBy = new Map(); // binary -> [choiceId, ...]
	for (const id of listCatalogChoices()) {
		let entry;
		try {
			entry = loadCatalogEntry(id);
		} catch {
			continue; // a malformed catalog entry is `stack apply`'s problem to report, not doctor's
		}
		for (const bin of entry.runtime?.requires ?? []) {
			if (!neededBy.has(bin)) neededBy.set(bin, []);
			neededBy.get(bin).push(id);
		}
	}
	return [...neededBy.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([bin, ids]) => (
		binaryCheck(bin, {
			required: false,
			remediation: `needed by the bootstrap script \`bskel stack apply --apply\` writes for: ${ids.join(', ')} ` +
				'-- not by `bskel stack apply` itself. Install before running the generated script.',
		})
	));
}

export function computeDoctorChecks(root, { workflow = null } = {}) {
	if (workflow !== null && !WORKFLOWS.includes(workflow)) {
		throw new Error(`unknown workflow "${workflow}" -- known workflows: ${WORKFLOWS.join(', ')}`);
	}

	const checks = [
		{
			name: 'inside a git repo',
			required: true,
			ok: Boolean(root),
			detail: root ?? 'not a git repo',
			remediation: root ? null : 'run this from inside a git repository',
		},
		binaryCheck('git', { required: true, remediation: 'install git (https://git-scm.com) and ensure it is on PATH' }),
		nodeVersionCheck(),
	];

	// gh: only ever consulted by preflight's 3-way default-branch cross-check, and that script
	// already `command -v gh`-guards it -- preflight does not hard-fail without it, so this is
	// never workflow-scoped (there's no `--workflow preflight`) and never required. Shown only in
	// the unscoped "everything" view.
	if (workflow === null) {
		checks.push(binaryCheck('gh', {
			required: false,
			remediation: 'optional -- only used for the 3-way default-branch cross-check in `bskel preflight` (already soft-guarded there); install with `gh` CLI (https://cli.github.com) if you want that extra check.',
		}));
	}

	// rg: both scanner adapters use it directly for scan, and the java-spring handles provider's
	// detectBasePackage() (handles/providers/java-spring/plan.mjs) shells out to it independently
	// during `handles plan`/`handles emit` -- required for both, even though only java-spring.mjs's
	// own call site lacks a try/catch (a separate, known, out-of-scope issue surfaced via that
	// adapter's own diagnostics()).
	if (workflow === null || workflow === 'scan' || workflow === 'handles') {
		checks.push(binaryCheck('rg', { required: true, remediation: 'install ripgrep (`brew install ripgrep`) -- required for `bskel scan` and `bskel handles emit`.' }));
	}

	// G4: not required for bskel itself (the python-fastapi provider only ever WRITES .py files,
	// never executes them) -- this is purely for a human/CI wanting to run this project's own
	// test/handles-python-codec.test.mjs, which DOES require it to round-trip-verify the generated
	// codec.py against the JS reference implementation.
	if (workflow === null || workflow === 'handles') {
		checks.push(binaryCheck('python3', {
			required: false,
			remediation: 'only needed for this project\'s own cross-language codec test (test/handles-python-codec.test.mjs) -- `bskel handles emit` itself never invokes python3.',
		}));
	}

	if (root && (workflow === null || workflow === 'handles')) {
		checks.push(buildWrapperCheck(root));
	}
	if (root && (workflow === null || workflow === 'stack')) {
		checks.push(...stackToolChecks(root));
	}

	// The G1 adapter-diagnostics block (specificity/capabilities/detect result/diagnostics) is
	// scan's own readiness story, and handles' codegen readiness depends on exactly the same
	// adapter capabilities (resource.fetch/codegen.handles) -- not relevant to stack.
	const showAdapters = workflow === null || workflow === 'scan' || workflow === 'handles';

	return { checks, showAdapters };
}
