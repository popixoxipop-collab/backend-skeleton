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
  // Python level=1 means current package, level=2 means one parent, etc.
  const parent = parentPackage(moduleEntry.packageId, fact.level - 1);
  if (parent === null) return null;
  return [parent, fact.module].filter(Boolean).join('.');
}

export function buildPythonProjectFacts(entries) {
  const modules = new Map();
  const candidates = new Map();
  for (const entry of entries) {
    if (!entry?.ok || !entry.source?.path || !entry.facts) continue;
    const identity = moduleIdentity(entry.source.path);
    const candidate = {
      ...identity,
      source: entry.source,
      facts: entry.facts,
      aliases: new Map(),
      importResolutions: [],
    };
    if (!candidates.has(identity.moduleId)) candidates.set(identity.moduleId, []);
    candidates.get(identity.moduleId).push(candidate);
  }
  const collisions = [];
  for (const [moduleId, found] of candidates) {
    if (found.length === 1) modules.set(moduleId, found[0]);
    else collisions.push({ moduleId, sources: found.map((x) => x.source.path).sort() });
  }
  const moduleLocality = (moduleId) => {
    const found = candidates.get(moduleId) || [];
    if (found.length === 1) return 'local';
    if (found.length > 1) return 'ambiguous';
    return 'external';
  };

  for (const mod of modules.values()) {
    for (const fact of mod.facts.imports || []) {
      if (fact.kind === 'import') {
        for (const item of fact.names || []) {
          const alias = item.alias || item.name.split('.')[0];
          // Python binds `import pkg.sub` to `pkg`, while `import pkg.sub as ps` binds the full module.
          const targetModule = item.alias ? item.name : item.name.split('.')[0];
          const locality = moduleLocality(targetModule);
          const record = { alias, kind: 'module', module: targetModule, locality, source: fact };
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
        const asModuleLocality = moduleLocality(asModule);
        if (asModuleLocality === 'local' || asModuleLocality === 'ambiguous') {
          const record = { alias, kind: 'module', module: asModule, locality: asModuleLocality, source: fact };
          mod.aliases.set(alias, record);
          mod.importResolutions.push(record);
        } else {
          const record = {
            alias,
            kind: 'symbol',
            module: base,
            name: item.name,
            locality: base && moduleLocality(base) === 'local' ? 'local' : (base && moduleLocality(base) === 'ambiguous' ? 'ambiguous' : (fact.level > 0 ? 'unresolved-local' : 'external')),
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
    collisions: collisions.sort((a, b) => a.moduleId.localeCompare(b.moduleId)),
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
    if (alias.locality === 'ambiguous') return { status: 'unknown', reason: 'ambiguous-module', module: alias.module, symbol };
    return { status: 'resolved', locality: alias.locality, module: alias.module, name: rest.join('.') || null };
  }
  if (alias.kind === 'symbol') {
    return { status: ['unresolved-local', 'ambiguous'].includes(alias.locality) ? 'unknown' : 'resolved', locality: alias.locality, module: alias.module, name: [alias.name, ...rest].join('.') };
  }
  return { status: 'unknown', symbol };
}

export function resolveValueSymbol(project, moduleId, value) {
  if (!value || value.kind !== 'symbol') return { status: 'unknown', value };
  return resolvePythonSymbol(project, moduleId, value.name);
}
