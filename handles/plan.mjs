import fs from 'node:fs';
import path from 'node:path';

// The "canonical fetch" for an entity: a GET endpoint whose path is exactly
// `${controller.basePath}/{id}` (one trailing path param, nothing after it) on a controller
// whose CLASS NAME contains the entity's name -- e.g. `GET /organizations/{organizationId}` on
// `OrganizationController` for entity `Organization`, not `OperatorController`'s endpoints
// (`OperatorController` doesn't contain "Organization", so it's never considered even though
// it lives in the same module and its base path also starts with `/organizations/...`).
//
// Bug this fixes (found while testing against the real module, which has BOTH
// OrganizationController and OperatorController): using controllers[0]'s basePath for every
// entity, instead of each candidate controller's own basePath + a name-affinity check, matched
// Organization's fetch operation against OperatorController's basePath and silently found
// nothing (or worse, could have matched the wrong controller's endpoint in a module shaped
// differently).
function findFetchOperation(controllers, entityClassName) {
	const needle = entityClassName.toLowerCase();
	for (const controller of controllers) {
		if (!controller.className.toLowerCase().includes(needle)) continue;
		for (const ep of controller.endpoints) {
			if (ep.verb !== 'GET' || !ep.operationId) continue;
			const suffix = ep.path.slice(controller.basePath.length);
			if (/^\/\{[^/]+\}$/.test(suffix)) {
				return { operationId: ep.operationId, method: ep.method, path: ep.path, controllerFile: controller.file, controllerClassName: controller.className };
			}
		}
	}
	return null;
}

function findRequiredAuthority(controllerFilePath) {
	if (!controllerFilePath || !fs.existsSync(controllerFilePath)) return null;
	const text = fs.readFileSync(controllerFilePath, 'utf8');
	const match = text.match(/@PreAuthorize\("hasRole\('([^']+)'\)"\)/);
	return match ? match[1] : null;
}

// Heuristic (this codebase's convention, verified for Organization -> OrganizationService, not
// guaranteed for every entity): <Entity>Service under domain/<module>/application/. Only
// trusted if the file actually exists -- see D-resolver-scope in DECISIONS.md for why a
// resolver is only generated when this resolves to a real file, not a guessed import.
function findServiceFile(javaSrcRoot, module, entityClassName) {
	const guessedType = `${entityClassName}Service`;
	const guessedPath = path.join(javaSrcRoot, 'domain', module, 'application', `${guessedType}.java`);
	return fs.existsSync(guessedPath) ? { serviceType: guessedType, file: guessedPath } : null;
}

export function planHandles({ javaSrcRoot, scanReport, module: moduleName, resourceFilter }) {
	const targetModule = moduleName
		? scanReport.related_modules.find((m) => m.module === moduleName)
		: scanReport.related_modules[0];

	if (!targetModule) {
		return { module: null, resources: [], notes: ['no related module in the scan report -- run `bskel scan` first, or pass --module explicitly'] };
	}

	const resources = [];
	const notes = [];

	for (const entity of targetModule.entities) {
		if (resourceFilter && !resourceFilter.includes(entity.className)) continue;
		const fetchOp = findFetchOperation(targetModule.controllers, entity.className);
		const requiredAuthority = findRequiredAuthority(fetchOp?.controllerFile ?? null);
		const service = findServiceFile(javaSrcRoot, targetModule.module, entity.className);

		if (!fetchOp) {
			notes.push(`${entity.className}: no single-resource GET endpoint found on a controller whose name contains "${entity.className}" -- fetch() will need to be hand-written`);
		} else if (!requiredAuthority) {
			notes.push(`${entity.className}: no class-level @PreAuthorize(hasRole(...)) found on ${fetchOp.controllerClassName} -- requiredAuthority() defaults to "TODO_ROLE", fix before relying on it`);
		}
		if (!service) {
			notes.push(`${entity.className}: no ${entity.className}Service found under domain/${targetModule.module}/application/ -- resolver NOT generated for this entity (would produce a broken import). Emit it by hand once the right service is identified.`);
		}

		resources.push({
			type: entity.className,
			table: entity.table,
			idField: entity.idField,
			fetchOperation: fetchOp,
			requiredAuthority: requiredAuthority ?? 'TODO_ROLE',
			service,
			willGenerateResolver: Boolean(fetchOp && service),
		});
	}

	if (resources.length === 0) {
		notes.push(`no entities found for module "${targetModule.module}" ${resourceFilter ? `matching --resource filter [${resourceFilter.join(', ')}]` : ''} -- nothing to plan.`);
	}

	return { module: targetModule.module, resources, notes };
}
