import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  DEFAULT_MAX_SOURCE_BYTES,
  assertRepoRelativeXmlPath,
  decodeMujocoUtf8,
  discoverMujocoSource,
  mujocoSourceBytes,
} from './discover.mjs';

export const MUJOCO_SOURCE_SCHEMA = 'sbf.sim-mujoco-source/draft-1';
const NAME = /^[A-Za-z_][A-Za-z0-9_.:-]*$/;
const NUM = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const ACTUATORS = new Set(['motor', 'position', 'velocity', 'general', 'cylinder', 'muscle', 'adhesion', 'intvelocity', 'damper']);
const SECTIONS = new Set(['actuator', 'sensor', 'contact', 'equality', 'tendon', 'asset', 'keyframe']);
const HIGH_RISK_UNMODELED = new Set(['extension', 'plugin', 'frame', 'replicate', 'composite', 'flexcomp', 'attach']);

function posInt(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${label} must be a positive safe integer`);
  return value;
}

function finite(value, label) {
  if (typeof value !== 'string' || !NUM.test(value)) throw new TypeError(`${label} must be a finite numeric literal`);
  const number = Number(value);
  if (!Number.isFinite(number)) throw new TypeError(`${label} must be finite`);
  return number;
}

function vector(value, label, min = 1, max = Infinity) {
  if (value === undefined) return null;
  const parts = value.trim().split(/\s+/).filter(Boolean);
  if (parts.length < min || parts.length > max) throw new TypeError(`${label} has invalid vector length`);
  return parts.map((part, index) => finite(part, `${label}[${index}]`));
}

function decodeEntities(value) {
  return value.replace(/&([^;]+);/g, (_match, entity) => {
    const fixed = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[entity];
    if (fixed) return fixed;
    let codepoint = null;
    if (/^#\d+$/.test(entity)) codepoint = Number(entity.slice(1));
    if (/^#x[0-9a-f]+$/i.test(entity)) codepoint = Number.parseInt(entity.slice(2), 16);
    if (codepoint !== null && Number.isInteger(codepoint) && codepoint >= 0 && codepoint <= 0x10ffff) {
      return String.fromCodePoint(codepoint);
    }
    throw new Error(`unsupported XML entity &${entity};`);
  });
}

function parseAttributes(rest, label) {
  const out = {};
  let index = 0;
  while (index < rest.length) {
    while (/\s/.test(rest[index] ?? '')) index += 1;
    if (index >= rest.length) break;
    const name = rest.slice(index).match(/^([A-Za-z_][A-Za-z0-9_.:-]*)/);
    if (!name) throw new Error(`${label} has malformed attribute syntax`);
    const key = name[1];
    index += key.length;
    if (Object.hasOwn(out, key)) throw new Error(`${label} repeats attribute ${key}`);
    while (/\s/.test(rest[index] ?? '')) index += 1;
    if (rest[index++] !== '=') throw new Error(`${label} attribute ${key} must use =`);
    while (/\s/.test(rest[index] ?? '')) index += 1;
    const quote = rest[index++];
    if (quote !== '"' && quote !== "'") throw new Error(`${label} attribute ${key} must be quoted`);
    const end = rest.indexOf(quote, index);
    if (end < 0) throw new Error(`${label} attribute ${key} is unterminated`);
    const raw = rest.slice(index, end);
    if (raw.includes('<')) throw new Error(`${label} attribute ${key} contains illegal <`);
    out[key] = decodeEntities(raw);
    index = end + 1;
  }
  return out;
}

function tagEnd(text, start) {
  let quote = null;
  for (let index = start + 1; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '>') return index;
  }
  return -1;
}

function xmlTree(text, { maxDepth, maxElements }) {
  if (/<!DOCTYPE\b/i.test(text) || /<!ENTITY\b/i.test(text)) throw new Error('MuJoCo XML must not declare DOCTYPE or ENTITY');
  const doc = { tag: '#doc', attrs: {}, children: [], locator: '#doc' };
  const stack = [doc];
  let count = 0;
  let index = 0;

  while (index < text.length) {
    const left = text.indexOf('<', index);
    if (left < 0) {
      if (text.slice(index).trim()) throw new Error('unexpected XML text');
      break;
    }
    if (text.slice(index, left).trim()) throw new Error('unsupported XML text node');

    if (text.startsWith('<!--', left)) {
      const end = text.indexOf('-->', left + 4);
      if (end < 0) throw new Error('unterminated XML comment');
      index = end + 3;
      continue;
    }
    if (text.startsWith('<?', left)) {
      const end = text.indexOf('?>', left + 2);
      if (end < 0) throw new Error('unterminated XML processing instruction');
      index = end + 2;
      continue;
    }
    if (text.startsWith('<!', left)) throw new Error('unsupported XML declaration');

    const right = tagEnd(text, left);
    if (right < 0) throw new Error('unterminated XML tag');
    let body = text.slice(left + 1, right);

    if (body.startsWith('/')) {
      const name = body.slice(1).trim();
      if (!NAME.test(name)) throw new Error('invalid closing element');
      const current = stack.at(-1);
      if (stack.length === 1 || current.tag !== name) throw new Error(`mismatched closing element </${name}>`);
      stack.pop();
      index = right + 1;
      continue;
    }

    const selfClosing = /\/\s*$/.test(body);
    if (selfClosing) body = body.replace(/\/\s*$/, '');
    const match = body.trim().match(/^([A-Za-z_][A-Za-z0-9_.:-]*)/);
    if (!match) throw new Error('invalid XML element');
    const name = match[1];
    const attributes = parseAttributes(body.trim().slice(name.length), `element <${name}>`);
    if (++count > maxElements) throw new RangeError('MuJoCo XML exceeds element budget');
    if (stack.length > maxDepth) throw new RangeError('MuJoCo XML exceeds depth budget');

    const parent = stack.at(-1);
    const ordinal = parent.children.filter((child) => child.tag === name).length + 1;
    const node = {
      tag: name,
      attrs: attributes,
      children: [],
      locator: parent.locator === '#doc' ? `${name}[${ordinal}]` : `${parent.locator}/${name}[${ordinal}]`,
    };
    parent.children.push(node);
    if (!selfClosing) stack.push(node);
    index = right + 1;
  }

  if (stack.length !== 1) throw new Error(`MuJoCo XML has unclosed element <${stack.at(-1).tag}>`);
  if (doc.children.length !== 1) throw new Error('MuJoCo XML must contain exactly one root element');
  return doc.children[0];
}

function id(kind, sourcePath, node) {
  const digest = createHash('sha256')
    .update(`${sourcePath}\0${node.locator}\0${node.attrs.name ?? ''}`)
    .digest('hex')
    .slice(0, 20);
  return `${kind}:${digest}`;
}

function copyAttributes(attributes, omit = []) {
  return Object.fromEntries(
    Object.keys(attributes)
      .sort()
      .filter((key) => !omit.includes(key))
      .map((key) => [key, attributes[key]]),
  );
}

function walk(root) {
  const out = [];
  const visit = (node, ancestors) => {
    out.push({ node, ancestors });
    for (const child of node.children) visit(child, [...ancestors, node]);
  };
  visit(root, []);
  return out;
}

function section(ancestors) {
  for (let index = ancestors.length - 1; index >= 0; index -= 1) {
    if (SECTIONS.has(ancestors[index].tag)) return ancestors[index].tag;
  }
  return null;
}

function localDependency(value, label) {
  if (typeof value !== 'string' || !value) throw new TypeError(`${label} must be a non-empty path`);
  if (value.includes('\0') || value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:\//.test(value)) {
    throw new TypeError(`${label} must be repo-relative POSIX`);
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) throw new TypeError(`${label} must not use URI scheme`);
  if (value.split('/').some((part) => !part || part === '..')) {
    throw new TypeError(`${label} must not contain parent or empty segments`);
  }
  return value;
}

function resolveIncludeFromMain(rootPath, ref) {
  const root = assertRepoRelativeXmlPath(rootPath, 'main MJCF source');
  const local = localDependency(ref, 'include reference');
  const directory = path.posix.dirname(root);
  const resolved = directory === '.' ? local : path.posix.join(directory, local);
  if (resolved.startsWith('../') || resolved === '..' || path.posix.isAbsolute(resolved)) {
    throw new TypeError('include reference escapes repository root');
  }
  return resolved;
}

function uniqueNames(items, kind) {
  const seen = new Set();
  for (const item of items) {
    if (!item.name) continue;
    if (seen.has(item.name)) throw new Error(`duplicate ${kind} name: ${item.name}`);
    seen.add(item.name);
  }
}

export function parseMjcfSource(sourceBytes, {
  path: sourceFile,
  maxBytes = DEFAULT_MAX_SOURCE_BYTES,
  maxDepth = 64,
  maxElements = 20000,
  maxDependencies = 2000,
} = {}) {
  posInt(maxDepth, 'maxDepth');
  posInt(maxElements, 'maxElements');
  posInt(maxDependencies, 'maxDependencies');

  const raw = mujocoSourceBytes(sourceBytes);
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new TypeError('maxBytes must be positive');
  if (raw.byteLength > maxBytes) throw new RangeError('MuJoCo source exceeds byte budget');
  const sourcePath = assertRepoRelativeXmlPath(sourceFile);
  const text = decodeMujocoUtf8(raw);

  if (!discoverMujocoSource(raw, { path: sourcePath, maxBytes }).detected) {
    throw new Error('MuJoCo source root must be <mujoco>');
  }

  const root = xmlTree(text, { maxDepth, maxElements });
  if (root.tag !== 'mujoco') throw new Error('MuJoCo source root must be <mujoco>');

  const flat = walk(root);
  const bodyIds = new Map();
  const declarations = {
    compiler: [],
    option: [],
    defaults: [],
    bodies: [],
    joints: [],
    geoms: [],
    sites: [],
    actuators: [],
    sensors: [],
    contacts: [],
    equalities: [],
    tendons: [],
    keyframes: [],
  };
  const dependencies = [];
  const diagnostics = [];

  const parentBody = (ancestors) => {
    for (let index = ancestors.length - 1; index >= 0; index -= 1) {
      const bodyId = bodyIds.get(ancestors[index].locator);
      if (bodyId) return bodyId;
    }
    return null;
  };
  const inWorldbody = (ancestors) => ancestors.some((ancestor) => ancestor.tag === 'worldbody');

  for (const { node, ancestors } of flat) {
    if (node.tag !== 'body') continue;
    const body = {
      id: id('body', sourcePath, node),
      source_locator: node.locator,
      source_order: declarations.bodies.length,
      name: node.attrs.name ?? null,
      parent_body_id: parentBody(ancestors),
      pos: vector(node.attrs.pos, 'body.pos', 3, 3),
      declared_attributes: copyAttributes(node.attrs, ['name', 'pos']),
    };
    bodyIds.set(node.locator, body.id);
    declarations.bodies.push(body);
  }

  for (const { node, ancestors } of flat) {
    const activeSection = section(ancestors);
    const bodyId = parentBody(ancestors);
    const base = (kind, order) => ({
      id: id(kind, sourcePath, node),
      source_locator: node.locator,
      source_order: order,
    });

    if ((node.tag === 'joint' || node.tag === 'freejoint') && bodyId) {
      declarations.joints.push({
        ...base('joint', declarations.joints.length),
        name: node.attrs.name ?? null,
        parent_body_id: bodyId,
        joint_type: node.tag === 'freejoint' ? 'free' : (node.attrs.type ?? 'hinge'),
        axis: node.tag === 'freejoint' ? null : vector(node.attrs.axis, 'joint.axis', 3, 3),
        range: node.tag === 'freejoint' ? null : vector(node.attrs.range, 'joint.range', 2, 2),
        source_syntax: node.tag,
        declared_attributes: copyAttributes(node.attrs, ['name', 'type', 'axis', 'range']),
      });
      continue;
    }

    if (node.tag === 'geom' && (bodyId || inWorldbody(ancestors))) {
      declarations.geoms.push({
        ...base('geom', declarations.geoms.length),
        name: node.attrs.name ?? null,
        parent_body_id: bodyId,
        parent_scope: bodyId ? 'body' : 'world',
        geom_type: node.attrs.type ?? 'sphere',
        size: vector(node.attrs.size, 'geom.size', 1, 3),
        declared_attributes: copyAttributes(node.attrs, ['name', 'type', 'size']),
      });
      continue;
    }

    if (node.tag === 'site' && (bodyId || inWorldbody(ancestors))) {
      declarations.sites.push({
        ...base('site', declarations.sites.length),
        name: node.attrs.name ?? null,
        parent_body_id: bodyId,
        parent_scope: bodyId ? 'body' : 'world',
        pos: vector(node.attrs.pos, 'site.pos', 3, 3),
        declared_attributes: copyAttributes(node.attrs, ['name', 'pos']),
      });
      continue;
    }

    if (activeSection === 'actuator' && ACTUATORS.has(node.tag)) {
      declarations.actuators.push({
        ...base('actuator', declarations.actuators.length),
        actuator_type: node.tag,
        name: node.attrs.name ?? null,
        joint: node.attrs.joint ?? null,
        tendon: node.attrs.tendon ?? null,
        site: node.attrs.site ?? null,
        ctrlrange: vector(node.attrs.ctrlrange, 'actuator.ctrlrange', 2, 2),
        gear: vector(node.attrs.gear, 'actuator.gear', 1, 6),
        declared_attributes: copyAttributes(node.attrs, ['name', 'joint', 'tendon', 'site', 'ctrlrange', 'gear']),
      });
      continue;
    }

    if (ancestors.at(-1)?.tag === 'actuator' && node.tag !== 'actuator') {
      diagnostics.push({
        code: 'MUJOCO_UNMODELED_ACTUATOR_TYPE',
        actuator_type: node.tag,
        source_locator: node.locator,
      });
      continue;
    }

    if (activeSection === 'sensor' && node.tag !== 'sensor') {
      declarations.sensors.push({
        ...base('sensor', declarations.sensors.length),
        sensor_type: node.tag,
        name: node.attrs.name ?? null,
        declared_attributes: copyAttributes(node.attrs, ['name']),
      });
      continue;
    }

    if (activeSection === 'contact' && (node.tag === 'pair' || node.tag === 'exclude')) {
      declarations.contacts.push({
        ...base('contact', declarations.contacts.length),
        contact_type: node.tag,
        name: node.attrs.name ?? null,
        declared_attributes: copyAttributes(node.attrs, ['name']),
      });
      continue;
    }

    if (ancestors.at(-1)?.tag === 'contact' && node.tag !== 'contact') {
      diagnostics.push({ code: 'MUJOCO_UNMODELED_CONTACT_TYPE', contact_type: node.tag, source_locator: node.locator });
      continue;
    }

    if (activeSection === 'equality' && node.tag !== 'equality') {
      declarations.equalities.push({
        ...base('equality', declarations.equalities.length),
        equality_type: node.tag,
        name: node.attrs.name ?? null,
        declared_attributes: copyAttributes(node.attrs, ['name']),
      });
      continue;
    }

    if (activeSection === 'tendon' && (node.tag === 'spatial' || node.tag === 'fixed')) {
      declarations.tendons.push({
        ...base('tendon', declarations.tendons.length),
        tendon_type: node.tag,
        name: node.attrs.name ?? null,
        declared_attributes: copyAttributes(node.attrs, ['name']),
        elements: node.children.map((child) => ({
          tag: child.tag,
          source_locator: child.locator,
          attributes: copyAttributes(child.attrs),
        })),
      });
      continue;
    }

    if (node.tag === 'default') {
      declarations.defaults.push({
        ...base('default', declarations.defaults.length),
        class_name: node.attrs.class ?? null,
        declared_attributes: copyAttributes(node.attrs, ['class']),
        templates: node.children
          .filter((child) => child.tag !== 'default')
          .map((child) => ({
            tag: child.tag,
            source_locator: child.locator,
            attributes: copyAttributes(child.attrs),
          })),
      });
      continue;
    }

    if (activeSection === 'keyframe' && node.tag === 'key') {
      declarations.keyframes.push({
        ...base('keyframe', declarations.keyframes.length),
        name: node.attrs.name ?? null,
        time: node.attrs.time === undefined ? null : finite(node.attrs.time, 'key.time'),
        qpos: vector(node.attrs.qpos, 'key.qpos'),
        qvel: vector(node.attrs.qvel, 'key.qvel'),
        act: vector(node.attrs.act, 'key.act'),
        ctrl: vector(node.attrs.ctrl, 'key.ctrl'),
      });
      continue;
    }

    if (node.tag === 'include') {
      const ref = localDependency(node.attrs.file, 'include file');
      const resolvedPath = resolveIncludeFromMain(sourcePath, ref);
      dependencies.push({
        kind: 'include',
        path: ref,
        resolved_path: resolvedPath,
        source_locator: node.locator,
        status: resolvedPath === sourcePath ? 'cycle-self' : 'unresolved',
      });
      continue;
    }

    if (activeSection === 'asset' && node.attrs.file !== undefined) {
      const ref = localDependency(node.attrs.file, 'asset file');
      dependencies.push({
        kind: 'asset',
        asset_type: node.tag,
        path: ref,
        resolution_basis: 'compiler-dependent',
        source_locator: node.locator,
        status: 'unresolved',
      });
    }
  }

  for (const { node } of flat) {
    if (!HIGH_RISK_UNMODELED.has(node.tag)) continue;
    diagnostics.push({
      code: 'MUJOCO_UNMODELED_HIGH_RISK_ELEMENT',
      element: node.tag,
      source_locator: node.locator,
      reason: 'source slice does not execute or resolve procedural/plugin semantics',
    });
  }

  if (dependencies.length > maxDependencies) throw new RangeError('MuJoCo source exceeds dependency budget');
  if (dependencies.some((dependency) => dependency.status === 'cycle-self')) {
    throw new Error('MuJoCo source directly includes itself');
  }

  for (const dependency of dependencies) {
    diagnostics.push({
      code: 'MUJOCO_DEPENDENCY_UNRESOLVED',
      kind: dependency.kind,
      path: dependency.path,
      ...(dependency.resolved_path ? { resolved_path: dependency.resolved_path } : {}),
      ...(dependency.resolution_basis ? { resolution_basis: dependency.resolution_basis } : {}),
      source_locator: dependency.source_locator,
    });
  }

  for (const [key, kind] of [
    ['bodies', 'body'],
    ['joints', 'joint'],
    ['geoms', 'geom'],
    ['sites', 'site'],
    ['actuators', 'actuator'],
    ['sensors', 'sensor'],
    ['contacts', 'contact'],
    ['equalities', 'equality'],
    ['tendons', 'tendon'],
    ['keyframes', 'keyframe'],
  ]) {
    uniqueNames(declarations[key], kind);
  }

  declarations.compiler = root.children
    .filter((node) => node.tag === 'compiler')
    .map((node) => ({ source_locator: node.locator, attributes: copyAttributes(node.attrs) }));

  declarations.option = root.children
    .filter((node) => node.tag === 'option')
    .map((node) => ({
      source_locator: node.locator,
      attributes: copyAttributes(node.attrs),
      timestep: node.attrs.timestep === undefined ? null : finite(node.attrs.timestep, 'option.timestep'),
      gravity: vector(node.attrs.gravity, 'option.gravity', 3, 3),
    }));

  return {
    schema: MUJOCO_SOURCE_SCHEMA,
    target: 'SIM-mujoco',
    source: {
      path: sourcePath,
      media_type: 'application/xml',
      byte_sha256: createHash('sha256').update(raw).digest('hex'),
      size_bytes: raw.byteLength,
    },
    model: {
      name: root.attrs.model ?? null,
      source_locator: root.locator,
    },
    declarations,
    dependencies,
    diagnostics,
    claims: {
      declared_structure_only: true,
      effective_model_verified: false,
      runtime_behavior_verified: false,
      causal_edges_verified: false,
    },
  };
}

export function validateMujocoDependencyGraph({ rootPath, edges, maxNodes = 10000 } = {}) {
  const root = assertRepoRelativeXmlPath(rootPath, 'dependency root');
  posInt(maxNodes, 'maxNodes');
  if (!Array.isArray(edges)) throw new TypeError('edges must be an array');

  const adjacency = new Map();
  const nodes = new Set([root]);
  const includedTargets = new Set();

  for (const edge of edges) {
    if (!edge || typeof edge !== 'object') throw new TypeError('dependency edge must be object');
    const from = assertRepoRelativeXmlPath(edge.from, 'edge.from');
    const to = resolveIncludeFromMain(root, edge.to);
    if (includedTargets.has(to)) {
      throw new Error(`MuJoCo dependency graph includes the same XML more than once: ${to}`);
    }
    includedTargets.add(to);
    nodes.add(from);
    nodes.add(to);
    if (nodes.size > maxNodes) throw new RangeError('dependency graph exceeds node budget');
    adjacency.set(from, [...(adjacency.get(from) ?? []), to]);
  }

  const visiting = new Set();
  const done = new Set();

  const dfs = (node, trail) => {
    if (visiting.has(node)) throw new Error(`MuJoCo dependency cycle detected: ${[...trail, node].join(' -> ')}`);
    if (done.has(node)) return;
    visiting.add(node);
    for (const next of adjacency.get(node) ?? []) dfs(next, [...trail, node]);
    visiting.delete(node);
    done.add(node);
  };

  dfs(root, []);
  if (done.size !== nodes.size) {
    const unreachable = [...nodes].filter((node) => !done.has(node)).sort();
    throw new Error(`MuJoCo dependency graph contains nodes not reachable from root: ${unreachable.join(', ')}`);
  }
  return {
    valid: true,
    root,
    nodes: [...nodes].sort(),
    edge_count: edges.length,
  };
}
