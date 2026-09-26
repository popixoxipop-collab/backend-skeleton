import { resolveValueSymbol } from './resolver.mjs';

function resolvedFull(project, moduleId, value) {
  if (!value || value.kind !== 'symbol') return null;
  const ref = resolveValueSymbol(project, moduleId, value);
  if (ref.status !== 'resolved') return null;
  return { ...ref, full: [ref.module, ref.name].filter(Boolean).join('.') };
}

function literalString(value) {
  return value?.kind === 'constant' && typeof value.value === 'string' ? value.value : null;
}

function optionalLiteralString(value) {
  if (value === null || value === undefined) return { status: 'verified', value: null };
  if (value?.kind === 'constant' && (typeof value.value === 'string' || value.value === null)) {
    return { status: 'verified', value: value.value };
  }
  return { status: 'unknown', value: null };
}

function keyword(call, name) {
  return (call?.keywords || []).find((item) => item.name === name)?.value || null;
}

const URLPATTERNS_MUTATORS = new Set([
  'append',
  'extend',
  'insert',
  'remove',
  'pop',
  'clear',
  'sort',
  'reverse',
]);

function isUrlPatternsMutationCall(entry) {
  const callee = entry?.value?.callee;
  if (callee?.kind !== 'symbol') return false;
  const [receiver, member, ...rest] = callee.name.split('.');
  return receiver === 'urlpatterns' && rest.length === 0 && URLPATTERNS_MUTATORS.has(member);
}

function urlPatternsValue(mod) {
  const matches = (mod.facts.assignments || []).filter((entry) => entry.targets?.[0] === 'urlpatterns');
  const augmented = (mod.facts.augmentedAssignments || []).filter((entry) => entry.target === 'urlpatterns');
  const directMutations = (mod.facts.calls || []).filter(isUrlPatternsMutationCall);
  const controlFlowMutations = (mod.facts.controlFlowMutations || []).filter((entry) => {
    if (entry.kind === 'assignment') return (entry.targets || []).includes('urlpatterns');
    if (entry.kind === 'augmented-assignment') return entry.target === 'urlpatterns';
    if (entry.kind === 'call') return isUrlPatternsMutationCall(entry);
    return false;
  });
  if (augmented.length > 0 || directMutations.length > 0 || controlFlowMutations.length > 0) {
    return { status: 'mutated', assignment: matches[0] || null, augmented, directMutations, controlFlowMutations };
  }
  if (matches.length !== 1) return { status: matches.length === 0 ? 'absent' : 'ambiguous', matches };

  const value = matches[0].value;
  if (value?.kind !== 'sequence' || !['list', 'tuple'].includes(value.container)) {
    return { status: 'dynamic', assignment: matches[0] };
  }
  return { status: 'verified', assignment: matches[0], items: value.items || [] };
}

function targetDescriptor(project, moduleId, value) {
  if (value?.kind === 'symbol') {
    const ref = resolveValueSymbol(project, moduleId, value);
    if (ref.status !== 'resolved') return { status: 'unknown', reason: ref.reason || 'view-symbol-unresolved', raw: value };
    return { status: 'verified', target: { kind: 'symbol', locality: ref.locality, module: ref.module, name: ref.name, raw: value.name } };
  }
  if (value?.kind === 'call' && value.callee?.kind === 'symbol') {
    const ref = resolveValueSymbol(project, moduleId, value.callee);
    if (ref.status === 'resolved' && typeof ref.name === 'string' && ref.name.endsWith('.as_view')) {
      return {
        status: 'verified',
        target: {
          kind: 'class-view',
          locality: ref.locality,
          module: ref.module,
          name: ref.name.slice(0, -'.as_view'.length),
          factory: 'as_view',
          raw: value.callee.name,
        },
      };
    }
    return { status: 'unknown', reason: 'view-call-not-statically-classifiable', raw: value };
  }
  return { status: 'unknown', reason: 'view-expression-not-static', raw: value };
}

function registrationKey(item) {
  return `${item.module}:${item.line || 0}:${item.kind}:${item.patternSegments.map((x) => x.value).join('|')}:${item.name || ''}`;
}

export function buildDjangoUrlShadow(project) {
  const registrations = [];
  const includes = [];
  const unknowns = [];

  function walk(moduleId, prefixSegments = [], stack = []) {
    const mod = project.get(moduleId);
    if (!mod) {
      unknowns.push({ kind: 'django-urlconf', module: moduleId, reason: 'included-module-not-in-project' });
      return;
    }
    if (stack.includes(moduleId)) {
      unknowns.push({ kind: 'django-urlconf', module: moduleId, reason: 'include-cycle', stack: [...stack, moduleId] });
      return;
    }
    const patterns = urlPatternsValue(mod);
    if (patterns.status === 'absent') return;
    if (patterns.status !== 'verified') {
      unknowns.push({ kind: 'django-urlconf', module: moduleId, reason: `urlpatterns-${patterns.status}` });
      return;
    }

    for (const item of patterns.items) {
      if (item?.kind !== 'call' || item.callee?.kind !== 'symbol') {
        unknowns.push({ kind: 'django-urlpattern', module: moduleId, reason: 'pattern-entry-not-static-call' });
        continue;
      }
      const callee = resolvedFull(project, moduleId, item.callee);
      if (!callee || !['django.urls.path', 'django.urls.re_path'].includes(callee.full)) {
        unknowns.push({ kind: 'django-urlpattern', module: moduleId, reason: 'unsupported-url-registration-callee', callee: item.callee.name });
        continue;
      }
      const pattern = literalString(item.args?.[0]);
      if (pattern === null) {
        unknowns.push({ kind: 'django-urlpattern', module: moduleId, reason: 'route-pattern-not-literal', callee: callee.full });
        continue;
      }
      const segment = { kind: callee.full.endsWith('.re_path') ? 'regex' : 'path', value: pattern };
      const view = item.args?.[1] || keyword(item, 'view');
      if (!view) {
        unknowns.push({ kind: 'django-urlpattern', module: moduleId, reason: 'view-missing', pattern });
        continue;
      }

      if (view.kind === 'call' && view.callee?.kind === 'symbol') {
        const includeCallee = resolvedFull(project, moduleId, view.callee);
        if (includeCallee?.full === 'django.urls.include') {
          const child = literalString(view.args?.[0]);
          const edge = { from: moduleId, line: item.line || patterns.assignment.line, prefix: segment, childModule: child };
          includes.push(edge);
          if (!child) {
            unknowns.push({ kind: 'django-urlconf', module: moduleId, reason: 'include-target-not-literal-module', pattern });
          } else if (segment.kind !== 'path') {
            unknowns.push({ kind: 'django-urlconf', module: moduleId, reason: 'regex-include-prefix-not-composed', pattern, childModule: child });
          } else {
            walk(child, [...prefixSegments, segment], [...stack, moduleId]);
          }
          continue;
        }
      }

      const target = targetDescriptor(project, moduleId, view);
      if (target.status !== 'verified') {
        unknowns.push({ kind: 'django-urlpattern', module: moduleId, reason: target.reason, pattern, rawTarget: target.raw || null });
        continue;
      }
      const nameValue = keyword(item, 'name') ?? item.args?.[3] ?? null;
      const nameFact = optionalLiteralString(nameValue);
      registrations.push({
        module: moduleId,
        source: mod.source.path,
        line: item.line || patterns.assignment.line,
        kind: segment.kind,
        patternSegments: [...prefixSegments, segment],
        name: nameFact.value,
        nameStatus: nameFact.status,
        target: target.target,
        methodSemantics: 'not-declared-by-urlconf',
      });
    }
  }

  const urlModules = [];
  const includedModules = new Set();
  for (const mod of project.list()) {
    const patterns = urlPatternsValue(mod);
    if (patterns.status === 'absent') continue;
    urlModules.push(mod.moduleId);
    if (patterns.status !== 'verified') continue;
    for (const item of patterns.items) {
      if (item?.kind !== 'call' || item.callee?.kind !== 'symbol') continue;
      const callee = resolvedFull(project, mod.moduleId, item.callee);
      if (!callee || !['django.urls.path', 'django.urls.re_path'].includes(callee.full)) continue;
      const view = item.args?.[1] || keyword(item, 'view');
      if (view?.kind !== 'call' || view.callee?.kind !== 'symbol') continue;
      const includeCallee = resolvedFull(project, mod.moduleId, view.callee);
      if (includeCallee?.full !== 'django.urls.include') continue;
      const child = literalString(view.args?.[0]);
      if (child) includedModules.add(child);
    }
  }
  const roots = urlModules.filter((moduleId) => !includedModules.has(moduleId));
  for (const moduleId of (roots.length > 0 ? roots : urlModules)) walk(moduleId);

  registrations.sort((a, b) => registrationKey(a).localeCompare(registrationKey(b)));
  includes.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  unknowns.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return { registrations, includes, unknowns };
}
