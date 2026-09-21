// P7: Unreal projects are editor-Python driven rather than Node-build driven. A root-level
// `.uproject` descriptor is a strong, stack-specific signal and is intentionally enough for this
// registration milestone. G6 adds the separate gameplay contract/parser/provider surface; this
// adapter must not claim those capabilities before that work exists.
import fs from 'node:fs';
import path from 'node:path';

function projectFiles(repoRoot) {
	try {
		return fs.readdirSync(repoRoot, { withFileTypes: true })
			.filter((entry) => entry.isFile() && entry.name.endsWith('.uproject'))
			.map((entry) => path.join(repoRoot, entry.name))
			.sort();
	} catch {
		return [];
	}
}

export function detectUnrealPythonRoot(repoRoot) {
	const projects = projectFiles(repoRoot);
	return projects.length === 1 ? { projectFile: projects[0] } : null;
}

function scanUnrealPython(repoRoot, { projectFile }) {
	// Parsing, instead of merely testing a filename, makes this adapter's one read-set entry a
	// real consumed input and rejects a malformed descriptor as an unsupported project rather than
	// inventing a module from an arbitrary extension match.
	let descriptor;
	try {
		descriptor = JSON.parse(fs.readFileSync(projectFile, 'utf8'));
	} catch {
		descriptor = null;
	}
	const projectName = path.basename(projectFile, '.uproject');
	const engineAssociation = typeof descriptor?.EngineAssociation === 'string' ? descriptor.EngineAssociation : 'unknown-engine';
	return {
		modules: [{ module: projectName, controllers: [], entities: [], enums: [], dtos: [] }],
		filesRead: [path.relative(repoRoot, projectFile)],
		apiSurfaceSource: `Unreal project descriptor (${engineAssociation})`,
	};
}

export const adapter = {
	contract: 'sbf.adapter/2',
	id: 'unreal-python',
	title: 'Unreal Engine project driven by editor Python',
	specificity: 70,
	confidence: 'high',
	verificationBasis: 'synthetic-only',
	capabilities: {
		'api.operations': false,
		'api.request-shape': false,
		'resource.fetch': false,
		'codegen.handles': false,
		'game.events': false,
		'game.population': false,
		'game.objectives': false,
		'codegen.gameplay': false,
	},
	detect: detectUnrealPythonRoot,
	scan(repoRoot, detection) {
		return scanUnrealPython(repoRoot, detection);
	},
	listReadSet(repoRoot) {
		const detection = detectUnrealPythonRoot(repoRoot);
		return detection ? [path.relative(repoRoot, detection.projectFile)] : [];
	},
	diagnostics(repoRoot) {
		const projects = projectFiles(repoRoot);
		if (projects.length === 0) {
			return [{ level: 'info', code: 'no-uproject', message: 'no root-level .uproject descriptor found' }];
		}
		if (projects.length > 1) {
			return [{ level: 'warn', code: 'multiple-uprojects', message: `found ${projects.length} root-level .uproject files; choose a project root before scanning` }];
		}
		return [{ level: 'info', code: 'unreal-project-detected', message: `detected ${path.basename(projects[0])}; G6 gameplay parsing/provider support is not registered yet` }];
	},
};
