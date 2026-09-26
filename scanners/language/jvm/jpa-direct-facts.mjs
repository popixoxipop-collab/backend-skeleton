import { analyzeJavaMemberFacts } from './member-facts.mjs';
import { buildJvmProjectIndex, resolveJvmAnnotationName } from './annotation-graph.mjs';

const DIRECT_KEY_ANNOTATIONS = new Set([
	'jakarta.persistence.Id',
	'jakarta.persistence.EmbeddedId',
	'javax.persistence.Id',
	'javax.persistence.EmbeddedId',
]);

function isPersistenceAnnotation(fqn) {
	return typeof fqn === 'string'
		&& (fqn.startsWith('jakarta.persistence.') || fqn.startsWith('javax.persistence.'));
}

function resolveAnnotations(index, syntaxFacts, annotations) {
	return annotations.map((annotation) => {
		const resolution = resolveJvmAnnotationName(index, syntaxFacts, annotation.name);
		return {
			writtenName: annotation.name,
			argsText: annotation.argsText ?? null,
			byteSpan: annotation.byteSpan ?? null,
			resolution,
			persistenceFqn: resolution.status === 'resolved' && isPersistenceAnnotation(resolution.fqn)
				? resolution.fqn
				: null,
		};
	});
}

function requireFile(file, index) {
	if (file === null || typeof file !== 'object' || Array.isArray(file)) {
		throw new TypeError('files[' + index + '] must be an object');
	}
	if (typeof file.path !== 'string' || file.path.length === 0) {
		throw new TypeError('files[' + index + '].path must be non-empty');
	}
	if (typeof file.source !== 'string') {
		throw new TypeError('files[' + index + '].source must be a string');
	}
}

// Conservative JPA facts from annotations written directly on the current type/member.
// It deliberately does not walk extends/implements to synthesize inherited identifiers, does not
// infer JPA access strategy, does not execute annotation processors/build plugins, and does not
// treat unresolved wildcard imports as proven persistence annotations.
export function analyzeJvmJpaDirectFacts(files) {
	if (!Array.isArray(files) || files.length === 0) {
		throw new TypeError('files must be a non-empty array');
	}
	for (let i = 0; i < files.length; i++) requireFile(files[i], i);

	const index = buildJvmProjectIndex(files);
	const syntaxByPath = new Map(index.fileFacts.map((facts) => [facts.path, facts]));
	const sourceByPath = new Map(files.map((file) => [file.path, file.source]));
	const types = [];
	const diagnostics = [...index.diagnostics];

	for (const facts of index.fileFacts) {
		const source = sourceByPath.get(facts.path);
		const members = analyzeJavaMemberFacts(source, { path: facts.path });
		diagnostics.push(...members.diagnostics);
		const memberByFqn = new Map(members.types.map((type) => [type.fqn, type]));

		for (const syntaxType of facts.topLevelTypes) {
			const fqn = facts.packageName ? facts.packageName + '.' + syntaxType.name : syntaxType.name;
			const memberType = memberByFqn.get(fqn) ?? { fields: [], recordComponents: [] };
			const typeAnnotations = resolveAnnotations(index, syntaxByPath.get(facts.path), syntaxType.annotations);

			const projectMember = (member) => {
				const annotations = resolveAnnotations(index, facts, member.annotations);
				const directKeyAnnotations = annotations
					.map((item) => item.persistenceFqn)
					.filter((fqnValue) => DIRECT_KEY_ANNOTATIONS.has(fqnValue));
				return {
					name: member.name,
					rawType: member.rawType,
					modifiers: member.modifiers,
					generic: member.generic,
					arrayDepth: member.arrayDepth,
					annotations,
					directKeyAnnotations,
				};
			};

			const fields = memberType.fields.map(projectMember);
			const recordComponents = memberType.recordComponents.map(projectMember);
			const directPrimaryKeyFields = [...fields, ...recordComponents]
				.filter((member) => member.directKeyAnnotations.length > 0)
				.map((member) => member.name);

			types.push({
				fqn,
				kind: syntaxType.kind,
				path: facts.path,
				typeAnnotations,
				fields,
				recordComponents,
				directPrimaryKeyFields,
				inheritedPrimaryKey: 'not-evaluated',
			});
		}
	}

	return {
		schema: 'sbf.jvm.jpa-direct-facts/0-draft',
		language: 'java',
		types,
		diagnostics,
	};
}