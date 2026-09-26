import { resolveValueSymbol } from './resolver.mjs';

const BUILTINS = new Set(['str', 'int', 'float', 'bool', 'bytes', 'list', 'dict', 'tuple', 'set', 'frozenset', 'object']);
const TYPING_COLLECTIONS = new Set(['List', 'Dict', 'Tuple', 'Set', 'FrozenSet', 'Sequence', 'Mapping', 'Iterable']);

function rawSymbol(value) {
  return value?.kind === 'symbol' ? value.name : null;
}

function typeReference(project, moduleId, value) {
  const raw = rawSymbol(value);
  if (!raw) return null;
  if (BUILTINS.has(raw)) return { kind: 'builtin', name: raw };
  const resolved = resolveValueSymbol(project, moduleId, value);
  if (resolved.status === 'resolved') {
    return {
      kind: 'reference',
      locality: resolved.locality,
      module: resolved.module,
      name: resolved.name,
      raw,
    };
  }
  return { kind: 'unresolved-reference', raw, reason: resolved.reason || 'unresolved' };
}

function subscriptArgs(slice) {
  if (slice?.kind === 'sequence' && slice.container === 'tuple') return slice.items || [];
  return slice ? [slice] : [];
}

function resolvedFull(project, moduleId, value) {
  const ref = typeReference(project, moduleId, value);
  if (ref?.kind === 'reference') return [ref.module, ref.name].filter(Boolean).join('.');
  if (ref?.kind === 'builtin') return ref.name;
  return null;
}

function flattenUnion(options) {
  const out = [];
  for (const option of options) {
    if (option?.kind === 'union') out.push(...option.options);
    else out.push(option);
  }
  return out;
}

export function normalizePythonType(project, moduleId, annotation) {
  if (!annotation || annotation.kind === 'missing') return { kind: 'unknown', reason: 'missing-annotation' };

  if (annotation.kind === 'constant') {
    if (annotation.value === null) return { kind: 'none' };
    if (typeof annotation.value === 'string') return { kind: 'forward-reference', text: annotation.value };
    return { kind: 'unknown', reason: 'non-type-constant', raw: annotation };
  }

  if (annotation.kind === 'symbol') {
    return typeReference(project, moduleId, annotation);
  }

  if (annotation.kind === 'binary' && annotation.operator === 'BitOr') {
    return {
      kind: 'union',
      syntax: 'pep604',
      options: flattenUnion([
        normalizePythonType(project, moduleId, annotation.left),
        normalizePythonType(project, moduleId, annotation.right),
      ]),
    };
  }

  if (annotation.kind !== 'subscript') {
    return { kind: 'unknown', reason: 'unsupported-annotation-expression', raw: annotation };
  }

  const baseFull = resolvedFull(project, moduleId, annotation.base);
  const rawBase = rawSymbol(annotation.base);
  const args = subscriptArgs(annotation.slice);

  if (baseFull === 'typing.Optional') {
    return {
      kind: 'union',
      syntax: 'typing.Optional',
      options: [normalizePythonType(project, moduleId, args[0]), { kind: 'none' }],
    };
  }
  if (baseFull === 'typing.Union') {
    return {
      kind: 'union',
      syntax: 'typing.Union',
      options: flattenUnion(args.map((arg) => normalizePythonType(project, moduleId, arg))),
    };
  }
  if (baseFull === 'typing.Annotated') {
    return {
      kind: 'annotated',
      base: normalizePythonType(project, moduleId, args[0]),
      metadata: args.slice(1),
      note: 'metadata is preserved as static syntax facts; validator behavior is not executed',
    };
  }
  if (baseFull === 'typing.Literal') {
    return {
      kind: 'literal',
      values: args,
      note: 'literal syntax values only; no runtime coercion is implied',
    };
  }

  const collectionName = baseFull || rawBase;
  if (BUILTINS.has(collectionName) || (baseFull?.startsWith('typing.') && TYPING_COLLECTIONS.has(baseFull.slice('typing.'.length)))) {
    return {
      kind: 'generic',
      base: baseFull?.startsWith('typing.')
        ? { kind: 'reference', locality: 'external', module: 'typing', name: baseFull.slice('typing.'.length), raw: rawBase }
        : { kind: 'builtin', name: collectionName },
      args: args.map((arg) => normalizePythonType(project, moduleId, arg)),
    };
  }

  const base = typeReference(project, moduleId, annotation.base);
  return {
    kind: 'generic',
    base: base || { kind: 'unknown', reason: 'unresolved-generic-base', raw: annotation.base },
    args: args.map((arg) => normalizePythonType(project, moduleId, arg)),
  };
}

export function annotatePythonModelTypes(project, models) {
  return models.map((model) => ({
    ...model,
    fields: model.fields.map((field) => ({
      ...field,
      typeFact: normalizePythonType(project, model.module, field.annotation),
    })),
  }));
}
