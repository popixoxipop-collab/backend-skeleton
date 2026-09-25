import path from 'node:path';

function moduleIdentity(sourcePath) {
  const normalized = sourcePath.split('/').join(path.sep);
  const parsed = path.parse(normalized);
  const parts = parsed.dir ? parsed.dir.split(path.sep).filter(Boolean) : [];
  const isPackage = parsed.name === '__init__';
  if (!isPackage) parts.push(parsed.name);
  return {
    moduleId: parts.join('.'),
    packageId: (isPackage ? parts : parts.slice(0, -1)).join('.'),
    isPackage,
  };
}

function parentPackage(packageId, ups) {
  const parts = packageId ? packageId.split('.') : [];
  if (ups > parts.length) return null;
  return parts.slice(0, parts.length - ups).join('.');
}

function importBase(moduleEntry, fact) {
  if (fact.kind !== 'from') return null;
  if (fact.level === 0) return fact.module || '';
  const parent = parentPackage(moduleEntry.packageId, fact.level - 1);
  if (parent === null) return null;
  return [parent, fact.module].filter(Boolean).join('.');
}

export function buildPythonProjectFacts(entries) {
  const modules = new Map();
  for (const entry of entries) {
    if (!entry?.ok || !entry.source?.path || !entry.facts) continue;
    const identity = moduleIdentity(entry.source.path);
    modules.set(identity.moduleId, {
      ...identity,
      source: entry.source,
      facts: entry.facts,
      aliases: new Map(),
      importResolutions: [],
    });
  }

  for (const mod of modules.values()) {
    for (const fact of mod.facts.imports || []) {
      if (fact.kind === 'import') {
        for (const item of fact.names || []) {
          const alias = item.alias || item.name.split('.')[0];
          const targetModule = item.name;
          const local = modules.has(targetModule);
          const record = { alias, kind: 'module', module: targetModule, locality: local ? 'local' : 'external', source: fact };
          mod.aliases.set(alias, record);
          mod.importResolutions.push(record);
        }
        continue;
      }
      const base = importBase(mod, fact);
      for (const item of fact.names || []) {
        if (item.name === '*') {
          mod.importResolutions.push({ alias: '*', kind: 'star', module: base, locality: base && modules.has(base) ? 'local' : 'external-or-unresolved', source: fact });
          continue;
        }
        const alias = item.alias || item.name;
        const asModule = [base, item.name].filter(Boolean).join('.');
        if (modules.has(asModule)) {
          const record = { alias, kind: 'module', module: asModule, locality: 'local', source: fact };
          mod.aliases.set(alias, record);
          mod.importResolutions.push(record);
        } else {
          const record = {
            alias,
            kind: 'symbol',
            module: base,
            name: item.name,
            locality: base && modules.has(base) ? 'local' : (fact.level > 0 ? 'unresolved-local' : 'external'),
            source: fact,
          };
          mod.aliases.set(alias, record);
          mod.importResolutions.push(record);
        }
      }
    }
  }

  return {
    modules,
    get(moduleId) { return modules.get(moduleId) || null; },
    list() { return [...modules.values()].sort((a, b) => a.moduleId.localeCompare(b.moduleId)); },
  };
}

export function resolvePythonSymbol(project, moduleId, symbol) {
  const mod = project.get(moduleId);
  if (!mod || typeof symbol !== 'string' || !symbol) return { status: 'unknown', symbol };
  const [head, ...rest] = symbol.split('.');
  const alias = mod.aliases.get(head);
  if (!alias) {
    const localNames = new Set([
      ...(mod.facts.classes || []).map((x) => x.name),
      ...(mod.facts.functions || []).map((x) => x.name),
      ...(mod.facts.assignments || []).flatMap((x) => x.targets || []).filter((x) => typeof x === 'string'),
    ]);
    if (localNames.has(head)) {
      return { status: 'resolved', locality: 'local', module: moduleId, name: [head, ...rest].join('.') };
    }
    return { status: 'unknown', symbol };
  }
  if (alias.kind === 'module') {
    return { status: 'resolved', locality: alias.locality, module: alias.module, name: rest.join('.') || null };
  }
  if (alias.kind === 'symbol') {
    return { status: alias.locality === 'unresolved-local' ? 'unknown' : 'resolved', locality: alias.locality, module: alias.module, name: [alias.name, ...rest].join('.') };
  }
  return { status: 'unknown', symbol };
}

export function resolveValueSymbol(project, moduleId, value) {
  if (!value || value.kind !== 'symbol') return { status: 'unknown', value };
  return resolvePythonSymbol(project, moduleId, value.name);
}
