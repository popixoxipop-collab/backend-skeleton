// Unreal projects are editor-Python driven rather than Node-build driven. A root-level `.uproject`
// descriptor is the stack signal; G6-A additionally reads only the project's declared game-loop
// contracts. UE artifact emission remains a separate provider capability.
import fs from 'node:fs';
import path from 'node:path';
import { readGameContracts } from '../../gameplay/contracts.mjs';

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
	const allContracts = readGameContracts(repoRoot);
	const gameContracts = allContracts.contracts.filter((contract) => contract.source.adapter === 'unreal-python');
	return {
		modules: [{ module: projectName, controllers: [], entities: [], enums: [], dtos: [] }],
		gameContracts,
		filesRead: [path.relative(repoRoot, projectFile), ...allContracts.files_read].sort((left, right) => left.localeCompare(right)),
		apiSurfaceSource: `Unreal project descriptor (${engineAssociation}); ${gameContracts.length} game-loop contract(s)`,
	};
}

export const adapter = {
	contract: 'sbf.adapter/2',
	id: 'unreal-python',
	title: 'Unreal Engine project driven by editor Python',
	specificity: 70,
	confidence: 'high',
	verificationBasis: 'production-repo',
	capabilities: {
		'api.operations': false,
		'api.request-shape': false,
		'resource.fetch': false,
		'codegen.handles': false,
		'game.events': true,
		'game.population': true,
		'game.objectives': true,
		'codegen.gameplay': true,
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
		return [{ level: 'info', code: 'unreal-project-detected', message: `detected ${path.basename(projects[0])}; manifest-owned gameplay emission is available` }];
	},
};
