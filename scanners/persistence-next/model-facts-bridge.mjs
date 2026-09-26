import { createPersistenceIr, makeSourceRef } from './ir.mjs';

export const MODEL_FACTS_CONTRACT = 'sbf.model-facts/1';

function providerForFramework(framework) {
	if (framework === 'rails') return 'active-record';
	if (framework === 'laravel') return 'eloquent';
	throw new TypeError(`unsupported model-facts framework for persistence bridge: ${framework}`);
}

function explicitValue(fact) {
	return fact && fact.explicit === true && typeof fact.value === 'string' && fact.value ? fact.value : null;
}

function uniqueByName(models) {
	const out = new Map();
	for (const model of models) {
		if (!out.has(model.className)) out.set(model.className, []);
		out.get(model.className).push(model);
	}
	return out;
}

function relationTargetClass(framework, relation) {
	if (framework === 'rails') return relation.className ?? null;
	if (framework === 'laravel') return relation.targetClass ?? null;
	return null;
}

function relationOwnsForeignKey(framework, relation) {
	if (framework === 'rails') return relation.kind === 'belongs_to';
	if (framework === 'laravel') return relation.kind === 'belongsTo';
	return false;
}

export function fromRubyPhpModelFacts(report) {
	if (!report || report.contract !== MODEL_FACTS_CONTRACT) throw new TypeError(`expected ${MODEL_FACTS_CONTRACT}`);
	if (!Array.isArray(report.models) || !Array.isArray(report.unknowns)) throw new TypeError('model facts require models[] and unknowns[]');
	const provider = providerForFramework(report.framework);
	const byName = uniqueByName(report.models);
	const diagnostics = (report.unknowns ?? []).map((unknown) => ({
		code: 'model-facts-unknown',
		level: 'info',
		provider,
		model: unknown.model ?? null,
		relation: unknown.relation ?? null,
		source_code: unknown.code ?? null,
		message: unknown.reason ?? 'source model fact remains unknown',
	}));
	const entities = [];

	for (const model of report.models) {
		const tableName = explicitValue(model.table);
		const pkName = explicitValue(model.primaryKey);
		const fieldNames = new Set();
		const fields = [];
		const addField = (name, source = 'source') => {
			if (!name || fieldNames.has(name)) return;
			fieldNames.add(name);
			fields.push({ name, type: null, nullable: null, source });
		};
		addField(pkName);
		const relations = [];

		for (const relation of model.relations ?? []) {
			if (relation.polymorphic === true) {
				diagnostics.push({
					code: 'persistence-polymorphic-relation-unresolved', level: 'info', provider,
					model: model.className, relation: relation.name ?? null,
					message: 'polymorphic relation has no single physical target table',
				});
				continue;
			}
			if (!relationOwnsForeignKey(report.framework, relation)) continue;
			if (!relation.foreignKey) {
				diagnostics.push({
					code: 'persistence-relation-foreign-key-unknown', level: 'info', provider,
					model: model.className, relation: relation.name ?? null,
					message: 'relation foreign key is not explicit in model facts',
				});
				continue;
			}
			addField(relation.foreignKey);
			const targetClass = relationTargetClass(report.framework, relation);
			const targets = targetClass ? (byName.get(targetClass) ?? []) : [];
			if (targets.length !== 1) {
				diagnostics.push({
					code: 'persistence-relation-target-ambiguous', level: 'info', provider,
					model: model.className, relation: relation.name ?? null, target: targetClass,
					message: targetClass ? 'relation target model is absent or ambiguous in the supplied fact set' : 'relation target class is not explicit',
				});
				continue;
			}
			const target = targets[0];
			const targetTable = explicitValue(target.table);
			if (!targetTable) {
				diagnostics.push({
					code: 'persistence-relation-target-table-unknown', level: 'info', provider,
					model: model.className, relation: relation.name ?? null, target: target.className,
					message: 'target model table is implicit; persistence bridge does not apply framework naming conventions',
				});
				continue;
			}
			const targetPk = explicitValue(target.primaryKey);
			relations.push({
				columns: [relation.foreignKey],
				references_table: targetTable,
				references_schema: null,
				references_columns: targetPk ? [targetPk] : [],
				pairing: targetPk ? 'resolved' : 'unknown',
				source: 'source',
			});
			if (!targetPk) diagnostics.push({
				code: 'persistence-relation-target-key-unknown', level: 'info', provider,
				model: model.className, relation: relation.name ?? null, target: target.className,
				message: 'target primary key is implicit; relation target column remains unknown',
			});
		}

		if (!tableName) diagnostics.push({
			code: 'persistence-table-unknown', level: 'info', provider, model: model.className,
			message: 'physical table is implicit in model facts',
		});
		if (!pkName) diagnostics.push({
			code: 'persistence-primary-key-unknown', level: 'info', provider, model: model.className,
			message: 'primary key is implicit in model facts',
		});

		entities.push({
			provider,
			name: model.className,
			module: null,
			file: model.source?.file ?? report.source?.file ?? null,
			table: { name: tableName, schema: null, source: tableName ? 'explicit' : 'unknown' },
			primary_key: {
				columns: pkName ? [pkName] : [],
				type: provider === 'eloquent' && typeof model.keyType === 'string' ? model.keyType : 'unknown',
				source: pkName ? 'source' : 'unknown',
			},
			fields,
			relations,
			source_refs: [makeSourceRef({
				kind: 'source', provider,
				file: model.source?.file ?? report.source?.file ?? null,
				line: model.source?.line ?? null,
				detail: `${report.framework} model-facts ${model.className}`,
			})],
		});
	}

	return createPersistenceIr({
		provider,
		source_kind: 'source',
		entities,
		diagnostics,
		metadata: {
			upstream_contract: MODEL_FACTS_CONTRACT,
			framework: report.framework,
			language: report.language ?? null,
			source_sha256: report.source?.sha256 ?? null,
		},
	});
}
