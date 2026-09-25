// T11 compatibility baseline for the five first-party HTTP scanner adapters.
//
// This is deliberately NOT a new public scanner contract. It freezes the descriptor + committed
// fixture invariants that the T11 bridge must preserve while T01/T02/T03 define the eventual
// next-generation project/capability IR.
//
// The leading "_" follows scanners/registry.mjs's helper convention, so this file is never
// auto-registered as an adapter and cannot affect arbitration.
const freeze = (value) => {
	if (value && typeof value === 'object' && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const nested of Object.values(value)) freeze(nested);
	}
	return value;
};

export const LEGACY_HTTP_ADAPTER_IDS = freeze([
	'java-spring',
	'ruby-rails',
	'python-fastapi',
	'typescript-express',
	'javascript-express',
]);

export const LEGACY_HTTP_BASELINES = freeze({
	'java-spring': {
		fixture: 'test/fixtures/java-spring',
		descriptor: {
			contract: 'sbf.adapter/2',
			title: 'Java / Spring Boot',
			specificity: 100,
			confidence: 'high',
			verificationBasis: 'production-repo',
			capabilities: {
				'api.operations': true,
				'api.request-shape': true,
				'resource.fetch': true,
				'codegen.handles': true,
			},
		},
		inventory: {
			modules: ['annotationstyles', 'codeanalysis', 'curriculum', 'organization', 'security'],
			moduleCount: 5, controllerCount: 17, entityCount: 8, enumCount: 1, dtoCount: 1,
			endpointCount: 37, filesReadCount: 35,
		},
	},
	'ruby-rails': {
		fixture: 'test/fixtures/ruby-rails/backend',
		descriptor: {
			contract: 'sbf.adapter/2', title: 'Ruby / Rails', specificity: 95, confidence: 'high',
			verificationBasis: 'production-repo',
			capabilities: {
				'api.operations': true, 'api.request-shape': false, 'resource.fetch': false, 'codegen.handles': false,
			},
		},
		inventory: {
			modules: ['articles', 'health', 'profiles'],
			moduleCount: 3, controllerCount: 3, entityCount: 2, enumCount: 0, dtoCount: 0,
			endpointCount: 12, filesReadCount: 9,
		},
	},
	'python-fastapi': {
		fixture: 'test/fixtures/python-fastapi/backend',
		descriptor: {
			contract: 'sbf.adapter/2', title: 'Python / FastAPI', specificity: 90, confidence: 'high',
			verificationBasis: 'official-reference',
			capabilities: {
				'api.operations': false, 'api.request-shape': false, 'resource.fetch': true, 'codegen.handles': true,
			},
		},
		inventory: {
			modules: ['items'],
			moduleCount: 1, controllerCount: 1, entityCount: 1, enumCount: 0, dtoCount: 1,
			endpointCount: 1, filesReadCount: 7,
		},
	},
	'typescript-express': {
		fixture: 'test/fixtures/typescript-express/backend',
		descriptor: {
			contract: 'sbf.adapter/2', title: 'TypeScript / Express / TypeORM', specificity: 85, confidence: 'high',
			verificationBasis: 'community-sample',
			capabilities: {
				'api.operations': false, 'api.request-shape': false, 'resource.fetch': true, 'codegen.handles': true,
			},
		},
		inventory: {
			modules: ['users'],
			moduleCount: 1, controllerCount: 1, entityCount: 1, enumCount: 0, dtoCount: 0,
			endpointCount: 1, filesReadCount: 9,
		},
	},
	'javascript-express': {
		fixture: 'test/fixtures/javascript-express/backend',
		descriptor: {
			contract: 'sbf.adapter/2', title: 'JavaScript / Express (ESM/CommonJS, no ORM)', specificity: 80, confidence: 'high',
			verificationBasis: 'community-sample',
			capabilities: {
				'api.operations': false, 'api.request-shape': false, 'resource.fetch': false, 'codegen.handles': false,
			},
		},
		inventory: {
			modules: ['order', 'user'],
			moduleCount: 2, controllerCount: 2, entityCount: 0, enumCount: 0, dtoCount: 0,
			endpointCount: 5, filesReadCount: 10,
		},
	},
});

export function legacyHttpBaseline(adapterId) {
	return LEGACY_HTTP_BASELINES[adapterId] ?? null;
}
