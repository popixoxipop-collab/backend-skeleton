import { projectPythonModels } from './model-shape.mjs';
import { resolveValueSymbol } from './resolver.mjs';

const HTTP_VERBS = new Set(['get', 'post', 'put', 'patch', 'delete']);

function fullResolved(ref) {
  if (!ref || ref.status !== 'resolved') return null;
  return [ref.module, ref.name].filter(Boolean).join('.');
}

function keyword(call, name) {
  return (call?.keywords || []).find((item) => item.name === name)?.value || null;
}

function literalString(value) {
  return value?.kind === 'constant' && typeof value.value === 'string' ? value.value : null;
}

function joinPath(base, segment) {
  const b = (base || '').replace(/\/$/, '');
  const s = (segment || '').replace(/^\//, '');
  return s ? `${b}/${s}` : (b || '/');
}

function endpointKey(endpoint) {
  return `${endpoint.verb} ${endpoint.path}#${endpoint.method}`;
}

function entityKey(entity) {
  const ids = entity.primaryKeyFields || [];
  return `${entity.className}#${ids.join(',')}`;
}

export function buildFastApiShadow(project) {
  const endpoints = [];
  const mounts = [];
  const unknowns = [];
  const routersByModule = new Map();

  for (const mod of project.list()) {
    const routers = new Map();
    const mountContainers = new Map();
    for (const assignment of mod.facts.assignments || []) {
      const target = assignment.targets?.[0];
      const call = assignment.value;
      if (typeof target !== 'string' || call?.kind !== 'call') continue;
      const callee = fullResolved(resolveValueSymbol(project, mod.moduleId, call.callee));
      if (!['fastapi.APIRouter', 'fastapi.FastAPI'].includes(callee)) continue;
      if (callee === 'fastapi.FastAPI') {
        mountContainers.set(target, { variable: target, kind: 'app', line: assignment.line });
        continue;
      }
      const prefixValue = keyword(call, 'prefix');
      const prefix = prefixValue ? literalString(prefixValue) : '';
      const router = {
        variable: target,
        kind: 'router',
        prefix,
        prefixStatus: prefixValue && prefix === null ? 'unknown' : 'verified',
        line: assignment.line,
      };
      routers.set(target, router);
      mountContainers.set(target, router);
    }
    routersByModule.set(mod.moduleId, routers);

    for (const callEntry of mod.facts.calls || []) {
      const call = callEntry?.value;
      if (call?.kind !== 'call' || call.callee?.kind !== 'symbol') continue;
      const parts = call.callee.name.split('.');
      if (parts.length !== 2 || parts[1] !== 'include_router') continue;
      const receiver = mountContainers.get(parts[0]);
      if (!receiver) continue;

      const childValue = call.args?.[0] || keyword(call, 'router');
      const child = childValue?.kind === 'symbol'
        ? resolveValueSymbol(project, mod.moduleId, childValue)
        : { status: 'unknown' };
      const prefixValue = keyword(call, 'prefix');
      const prefix = prefixValue ? literalString(prefixValue) : '';
      const mount = {
        module: mod.moduleId,
        source: mod.source.path,
        line: callEntry.line || call.line || receiver.line,
        receiver: receiver.variable,
        receiverKind: receiver.kind,
        child: child.status === 'resolved'
          ? { locality: child.locality, module: child.module, name: child.name, raw: childValue.name }
          : { status: 'unknown', raw: childValue?.kind === 'symbol' ? childValue.name : null, reason: child.reason || 'router-argument-not-static-symbol' },
        prefix,
        prefixStatus: prefixValue && prefix === null ? 'unknown' : 'verified',
      };
      mounts.push(mount);
      unknowns.push({
        kind: 'fastapi-mount',
        module: mod.moduleId,
        line: mount.line,
        reason: 'include-router-mount-not-composed',
        receiver: mount.receiver,
        child: mount.child,
        prefix: mount.prefix,
        prefixStatus: mount.prefixStatus,
      });
    }

    for (const fn of mod.facts.functions || []) {
      for (const decorator of fn.decorators || []) {
        if (decorator?.kind !== 'call' || decorator.callee?.kind !== 'symbol') continue;
        const parts = decorator.callee.name.split('.');
        if (parts.length !== 2 || !HTTP_VERBS.has(parts[1])) continue;
        const [routerVar, methodName] = parts;
        const router = routers.get(routerVar);
        if (!router) {
          unknowns.push({
            kind: 'fastapi-endpoint',
            module: mod.moduleId,
            method: fn.name,
            line: decorator.line || fn.line,
            reason: 'router-variable-not-locally-declared',
            routerVar,
          });
          continue;
        }
        const pathValue = decorator.args?.[0] || keyword(decorator, 'path');
        const localPath = literalString(pathValue);
        if (localPath === null) {
          unknowns.push({
            kind: 'fastapi-endpoint',
            module: mod.moduleId,
            method: fn.name,
            line: decorator.line || fn.line,
            reason: 'route-path-not-literal',
            routerVar,
          });
          continue;
        }
        if (router.prefixStatus !== 'verified') {
          unknowns.push({
            kind: 'fastapi-endpoint',
            module: mod.moduleId,
            method: fn.name,
            line: decorator.line || fn.line,
            reason: 'router-prefix-not-literal',
            routerVar,
            localPath,
          });
          continue;
        }
        endpoints.push({
          module: mod.moduleId,
          source: mod.source.path,
          routerVar,
          verb: methodName.toUpperCase(),
          path: joinPath(router.prefix, localPath),
          method: fn.name,
          line: decorator.line || fn.line,
        });
      }
    }
  }

  const models = projectPythonModels(project);
  const entities = models.filter((model) => model.kind === 'entity').map((model) => ({
    module: model.module,
    className: model.className,
    primaryKeyFields: model.primaryKeyFields,
  }));
  const dtos = models.filter((model) => model.kind === 'dto').map((model) => ({
    module: model.module,
    className: model.className,
  }));

  endpoints.sort((a, b) => endpointKey(a).localeCompare(endpointKey(b)) || a.source.localeCompare(b.source));
  mounts.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  entities.sort((a, b) => entityKey(a).localeCompare(entityKey(b)));
  dtos.sort((a, b) => a.className.localeCompare(b.className) || a.module.localeCompare(b.module));
  unknowns.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

  return { endpoints, mounts, entities, dtos, unknowns };
}

export function summarizeLegacyFastApi(legacyScan) {
  const endpoints = [];
  const entities = [];
  const dtos = [];
  for (const mod of legacyScan?.modules || []) {
    for (const controller of mod.controllers || []) {
      for (const endpoint of controller.endpoints || []) {
        endpoints.push({
          module: mod.module,
          verb: endpoint.verb,
          path: endpoint.path,
          method: endpoint.method,
          line: endpoint.line,
        });
      }
    }
    for (const entity of mod.entities || []) {
      entities.push({ module: mod.module, className: entity.className, idField: entity.idField });
    }
    for (const dto of mod.dtos || []) {
      dtos.push({ module: mod.module, className: dto.className });
    }
  }
  endpoints.sort((a, b) => endpointKey(a).localeCompare(endpointKey(b)));
  entities.sort((a, b) => `${a.className}#${a.idField || ''}`.localeCompare(`${b.className}#${b.idField || ''}`));
  dtos.sort((a, b) => a.className.localeCompare(b.className) || a.module.localeCompare(b.module));
  return { endpoints, entities, dtos };
}

function setDiff(left, right) {
  const r = new Set(right);
  return [...new Set(left)].filter((item) => !r.has(item)).sort();
}

export function diffFastApiShadow(legacyScan, shadow) {
  const legacy = summarizeLegacyFastApi(legacyScan);
  const legacyEndpointKeys = legacy.endpoints.map(endpointKey);
  const shadowEndpointKeys = shadow.endpoints.map(endpointKey);
  const legacyEntityKeys = legacy.entities.map((entity) => `${entity.className}#${entity.idField || ''}`);
  const shadowEntityKeys = shadow.entities.map(entityKey);
  const legacyDtoKeys = legacy.dtos.map((dto) => dto.className);
  const shadowDtoKeys = shadow.dtos.map((dto) => dto.className);

  const differences = {
    endpoints: {
      missingInShadow: setDiff(legacyEndpointKeys, shadowEndpointKeys),
      additionalInShadow: setDiff(shadowEndpointKeys, legacyEndpointKeys),
    },
    entities: {
      missingInShadow: setDiff(legacyEntityKeys, shadowEntityKeys),
      additionalInShadow: setDiff(shadowEntityKeys, legacyEntityKeys),
    },
    dtos: {
      missingInShadow: setDiff(legacyDtoKeys, shadowDtoKeys),
      additionalInShadow: setDiff(shadowDtoKeys, legacyDtoKeys),
    },
  };
  const differenceCount = Object.values(differences).reduce(
    (sum, group) => sum + group.missingInShadow.length + group.additionalInShadow.length,
    0,
  );
  return {
    parity: differenceCount === 0 && shadow.unknowns.length === 0,
    differenceCount,
    differences,
    unknowns: shadow.unknowns,
    counts: {
      legacy: { endpoints: legacy.endpoints.length, entities: legacy.entities.length, dtos: legacy.dtos.length },
      shadow: { endpoints: shadow.endpoints.length, entities: shadow.entities.length, dtos: shadow.dtos.length },
    },
  };
}
