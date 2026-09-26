import { resolveValueSymbol } from './resolver.mjs';

function classKey(moduleId, className) {
  return `${moduleId}#${className}`;
}

function kwValue(keywords, name) {
  const item = (keywords || []).find((x) => x.name === name);
  return item ? item.value : null;
}

function constant(value, fallback = undefined) {
  return value?.kind === 'constant' ? value.value : fallback;
}

function booleanKeyword(keywords, name, defaultWhenMissing) {
  const item = (keywords || []).find((x) => x.name === name);
  if (!item) return { status: 'verified', value: defaultWhenMissing };
  if (item.value?.kind === 'constant' && typeof item.value.value === 'boolean') {
    return { status: 'verified', value: item.value.value };
  }
  return { status: 'unknown', value: null };
}

function callCallee(project, moduleId, value) {
  if (value?.kind !== 'call' || value.callee?.kind !== 'symbol') return null;
  return resolveValueSymbol(project, moduleId, value.callee);
}

function fieldMetadata(project, moduleId, field) {
  const defaultValue = field.value;
  const callee = callCallee(project, moduleId, defaultValue);
  const fullCallee = callee?.status === 'resolved' ? [callee.module, callee.name].filter(Boolean).join('.') : null;
  const isFieldCall = ['pydantic.Field', 'sqlmodel.Field'].includes(fullCallee);
  const keywords = isFieldCall ? defaultValue.keywords || [] : [];
  const keyword = (name) => keywords.find((x) => x.name === name)?.value || null;
  return {
    fieldCall: isFieldCall ? fullCallee : null,
    alias: constant(keyword('alias'), null),
    primaryKey: constant(keyword('primary_key'), null),
    nullable: constant(keyword('nullable'), null),
    hasDefaultFactory: Boolean(keyword('default_factory')),
  };
}

function directBaseRefs(project, moduleId, cls) {
  return (cls.bases || []).map((base) => ({ raw: base, resolved: resolveValueSymbol(project, moduleId, base) }));
}

export function projectPythonModels(project) {
  const rawClasses = new Map();
  for (const mod of project.list()) {
    for (const cls of mod.facts.classes || []) {
      rawClasses.set(classKey(mod.moduleId, cls.name), { moduleId: mod.moduleId, cls });
    }
  }

  const memo = new Map();
  const active = new Set();
  const classify = (moduleId, cls) => {
    const key = classKey(moduleId, cls.name);
    if (memo.has(key)) return memo.get(key);
    if (active.has(key)) return { family: 'unknown', localBases: [], externalBases: [], cycle: true };
    active.add(key);
    let family = 'unknown';
    let cycle = false;
    const localBases = [];
    const externalBases = [];
    for (const base of directBaseRefs(project, moduleId, cls)) {
      if (base.resolved.status !== 'resolved') continue;
      const full = [base.resolved.module, base.resolved.name].filter(Boolean).join('.');
      if (base.resolved.locality === 'local' && base.resolved.name) {
        const local = rawClasses.get(classKey(base.resolved.module, base.resolved.name));
        if (local) {
          localBases.push(classKey(local.moduleId, local.cls.name));
          const parent = classify(local.moduleId, local.cls);
          if (parent.cycle) cycle = true;
          if (family === 'unknown' && parent.family !== 'unknown') family = parent.family;
        }
      } else {
        externalBases.push(full);
        if (full === 'pydantic_settings.BaseSettings') family = 'settings';
        else if (full === 'sqlmodel.SQLModel') family = 'sqlmodel';
        else if (full === 'pydantic.BaseModel' && family === 'unknown') family = 'pydantic';
      }
    }
    const tableFact = booleanKeyword(cls.keywords, 'table', false);
    const table = tableFact.status === 'verified' ? tableFact.value === true : null;
    let kind = 'unknown';
    if (family === 'settings') kind = 'config';
    else if (family === 'sqlmodel' && tableFact.status === 'unknown') kind = 'unknown';
    else if (family === 'sqlmodel' && table) kind = 'entity';
    else if (family === 'sqlmodel' || family === 'pydantic') kind = 'dto';
    const result = { family, kind, localBases, externalBases, table, tableStatus: tableFact.status, cycle };
    active.delete(key);
    memo.set(key, result);
    return result;
  };

  const fieldMemo = new Map();
  const fieldActive = new Set();
  const collectFields = (moduleId, cls) => {
    const key = classKey(moduleId, cls.name);
    if (fieldMemo.has(key)) return fieldMemo.get(key);
    if (fieldActive.has(key)) return [];
    fieldActive.add(key);
    const classification = classify(moduleId, cls);
    const byName = new Map();
    if (!classification.cycle) {
      for (const baseKey of classification.localBases) {
        const base = rawClasses.get(baseKey);
        if (!base) continue;
        for (const field of collectFields(base.moduleId, base.cls)) byName.set(field.name, field);
      }
    }
    for (const field of cls.fields || []) {
      const name = Array.isArray(field.targets) && typeof field.targets[0] === 'string' ? field.targets[0] : null;
      if (!name) continue;
      byName.set(name, {
        name,
        annotation: field.annotation,
        default: field.value,
        metadata: fieldMetadata(project, moduleId, field),
        declaredIn: key,
        line: field.line,
      });
    }
    const result = [...byName.values()];
    fieldActive.delete(key);
    fieldMemo.set(key, result);
    return result;
  };

  const models = [];
  for (const { moduleId, cls } of rawClasses.values()) {
    const classification = classify(moduleId, cls);
    if (classification.kind === 'unknown' && classification.family === 'unknown') continue;
    const fields = collectFields(moduleId, cls);
    models.push({
      ref: classKey(moduleId, cls.name),
      module: moduleId,
      className: cls.name,
      family: classification.family,
      kind: classification.kind,
      table: classification.table,
      tableStatus: classification.tableStatus,
      bases: { local: classification.localBases, external: classification.externalBases },
      fields,
      primaryKeyFields: fields.filter((x) => x.metadata.primaryKey === true).map((x) => x.name),
      inheritanceCycle: classification.cycle,
      limitations: [
        'Static declaration facts only; validators, computed fields, runtime config, serializers and ORM behavior are not executed.',
        'Required/optional request semantics are not inferred from annotation/default combinations in this phase.',
        ...(classification.cycle
          ? ['Local inheritance cycle detected; inherited fields across the cycle are intentionally omitted.']
          : []),
        ...(classification.family === 'sqlmodel' && classification.tableStatus === 'unknown'
          ? ['SQLModel table= expression is not a static boolean; entity-vs-DTO classification is intentionally unknown.']
          : []),
      ],
    });
  }
  return models.sort((a, b) => a.ref.localeCompare(b.ref));
}
