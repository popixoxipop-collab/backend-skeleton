import {
	findClassLevelMappingArgs,
	findClassOrRecordDeclaration,
	findInterfaceExtendsDeclaration,
	findMappingAnnotations,
	maskNonCode,
} from '../../adapters/_java-spring-analyzer.mjs';
import { analyzeJavaSyntax } from './java-syntax-facts.mjs';
import { analyzeJavaMethodFacts } from './method-facts.mjs';

const REQUEST_METHOD_RE = /\bmethod\s*=\s*(?:RequestMethod\.)?(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS|TRACE)\b/u;
const SHORTHANDS = new Map([
	['GetMapping', 'GET'],
	['PostMapping', 'POST'],
	['PutMapping', 'PUT'],
	['PatchMapping', 'PATCH'],
	['DeleteMapping', 'DELETE'],
]);

function simpleName(name) {
	return name.split('.').at(-1);
}

function canonical(value) {
	return JSON.stringify(value);
}

function comparison(name, legacy, next) {
	if (legacy === null && next === null) return { name, status: 'not-applicable', legacy, next };
	return { name, status: canonical(legacy) === canonical(next) ? 'match' : 'mismatch', legacy, next };
}

function mappingFromAnnotation(method, annotation) {
	const simple = simpleName(annotation.name);
	if (SHORTHANDS.has(simple)) {
		return { methodName: method.name, verb: SHORTHANDS.get(simple), argsText: annotation.argsText ?? '' };
	}
	if (simple !== 'RequestMapping') return null;
	const match = (annotation.argsText ?? '').match(REQUEST_METHOD_RE);
	if (!match) return null;
	return { methodName: method.name, verb: match[1], argsText: annotation.argsText ?? '' };
}

function nextMappings(source, path) {
	const methodFacts = analyzeJavaMethodFacts(source, { path });
	const mappings = [];
	for (const type of methodFacts.types) {
		for (const method of type.methods) {
			for (const annotation of method.annotations) {
				const mapping = mappingFromAnnotation(method, annotation);
				if (mapping) mappings.push(mapping);
			}
		}
	}
	return mappings;
}

function nextClassMapping(syntax) {
	for (const type of syntax.topLevelTypes) {
		if (type.kind !== 'class' && type.kind !== 'record') continue;
		const annotation = type.annotations.find((a) => simpleName(a.name) === 'RequestMapping');
		if (annotation) return annotation.argsText ?? '';
	}
	return null;
}

function nextDeclaration(syntax) {
	const type = syntax.topLevelTypes.find((item) => item.kind === 'class' || item.kind === 'record');
	return type ? { keyword: type.kind, name: type.name } : null;
}

function nextRepository(syntax) {
	for (const type of syntax.topLevelTypes) {
		if (type.kind !== 'interface') continue;
		const annotation = type.annotations.find((a) => simpleName(a.name) === 'RepositoryRestResource');
		if (!annotation || type.extendsTypes.length === 0) continue;
		return { name: type.name, superType: type.extendsTypes[0] };
	}
	return null;
}

function legacyRepository(source) {
	const decl = findInterfaceExtendsDeclaration(maskNonCode(source));
	if (!decl) return null;
	let superType = decl.superName;
	if (decl.typeArgsStart !== null && decl.typeArgsEnd !== null) {
		superType += '<' + source.slice(decl.typeArgsStart, decl.typeArgsEnd).trim() + '>';
	}
	return { name: decl.name, superType };
}

// Read-only source shadow. It does not alter java-spring scan output and it deliberately compares
// only facts both paths can currently express. A mismatch is evidence for migration work, never
// an instruction to silently rewrite the legacy production result.
export function compareJavaSpringSourceShadow(source, { path = 'Unknown.java' } = {}) {
	const syntax = analyzeJavaSyntax(source, { path });
	const legacyDecl = findClassOrRecordDeclaration(maskNonCode(source));
	const checks = [
		comparison(
			'declaration',
			legacyDecl ? { keyword: legacyDecl.keyword, name: legacyDecl.name } : null,
			nextDeclaration(syntax),
		),
		comparison('class-request-mapping', findClassLevelMappingArgs(source), nextClassMapping(syntax)),
		comparison(
			'method-mappings',
			findMappingAnnotations(source).map(({ methodName, verb, argsText }) => ({ methodName, verb, argsText })),
			nextMappings(source, path),
		),
		comparison('repository-interface', legacyRepository(source), nextRepository(syntax)),
	];
	return {
		schema: 'sbf.jvm.spring-shadow/0-draft',
		path,
		ok: checks.every((check) => check.status !== 'mismatch'),
		checks,
		mismatches: checks.filter((check) => check.status === 'mismatch'),
	};
}