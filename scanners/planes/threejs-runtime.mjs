import { makeEvidence, isActiveEvidence, domainRecord } from './_evidence.mjs';

const RENDERER_RE = /(?:^|\.)(WebGLRenderer|WebGPURenderer)$/;
const SCENE_RE = /(?:^|\.)Scene$/;
const MATERIAL_RE = /(?:^|\.)(?:ShaderMaterial|RawShaderMaterial|Mesh[A-Za-z0-9_$]*Material|PointsMaterial|LineBasicMaterial|LineDashedMaterial|SpriteMaterial|NodeMaterial|Mesh[A-Za-z0-9_$]*NodeMaterial)$/;
const LOADER_RE = /(?:^|\.)(?:GLTFLoader|DRACOLoader|KTX2Loader|TextureLoader|CubeTextureLoader|RGBELoader|EXRLoader|FBXLoader|OBJLoader|FileLoader|ImageLoader|AudioLoader)$/;

function fromNode(project, unit, collector, kind, value, node, details) {
  return makeEvidence({ projectId: project.project_id, role: unit.role, collector, kind, value, node, details });
}

export function collectThreeJsRuntime(project, units) {
  const evidence = [];
  const unresolved = [];
  const deps = project.dependencies ?? {};
  const hasThreeDependency = Object.hasOwn(deps, 'three') || Object.keys(deps).some((d) => d.startsWith('@react-three/'));

  if (hasThreeDependency) {
    evidence.push({
      project_id: project.project_id,
      kind: 'dependency', value: Object.hasOwn(deps, 'three') ? 'three' : '@react-three/*', role: 'active',
      provenance: { source_path: project.package_json, line: null, column: null, collector: 'threejs-runtime', confidence: 'direct' },
    });
  }

  for (const unit of units) {
    for (const imp of unit.imports) {
      if (imp.specifier === 'three' || imp.specifier.startsWith('three/') || imp.specifier.startsWith('@react-three/')) {
        evidence.push(fromNode(project, unit, 'threejs-runtime', 'three-import', imp.specifier, imp));
      }
      if (imp.specifier === 'three/tsl' || imp.specifier.includes('/tsl')) {
        evidence.push(fromNode(project, unit, 'threejs-runtime', 'tsl-import', imp.specifier, imp));
      }
    }
    for (const c of unit.constructions) {
      if (RENDERER_RE.test(c.name)) evidence.push(fromNode(project, unit, 'threejs-runtime', 'renderer', c.name, c));
      if (SCENE_RE.test(c.name)) evidence.push(fromNode(project, unit, 'threejs-runtime', 'scene', c.name, c));
      if (MATERIAL_RE.test(c.name)) evidence.push(fromNode(project, unit, 'threejs-runtime', 'material', c.name, c));
      if (LOADER_RE.test(c.name)) evidence.push(fromNode(project, unit, 'threejs-runtime', 'loader', c.name, c));
    }
    for (const call of unit.calls) {
      if (/(?:^|\.)render$/.test(call.name)) evidence.push(fromNode(project, unit, 'threejs-runtime', 'render-call', call.name, call));
      if (call.name === 'requestAnimationFrame') evidence.push(fromNode(project, unit, 'threejs-runtime', 'frame-loop', call.name, call));
    }
    for (const item of unit.unresolved) unresolved.push({ ...item, project_id: project.project_id, role: unit.role });
  }

  const active = evidence.filter(isActiveEvidence);
  const activeRenderer = active.some((e) => e.kind === 'renderer');
  const activeScene = active.some((e) => e.kind === 'scene');
  const activeRenderCall = active.some((e) => e.kind === 'render-call');
  const activeThreeImport = active.some((e) => e.kind === 'three-import');
  const activeTsl = active.some((e) => e.kind === 'tsl-import');
  const webgpu = active.some((e) => e.kind === 'renderer' && /WebGPURenderer$/.test(e.value));

  if (evidence.length === 0) return null;

  let status = 'partial';
  const notes = [];
  if (activeRenderer && activeScene && activeRenderCall && (activeThreeImport || hasThreeDependency)) status = 'complete';
  else if (active.length === 0) notes.push('Three.js evidence exists only in reference/generated/vendor/template files; no active runtime is claimed.');
  else if (hasThreeDependency && !activeRenderer && !activeScene) notes.push('Three.js is declared but no active renderer/scene runtime entry was proven.');

  return domainRecord({
    projectId: project.project_id,
    kind: 'game-runtime',
    status,
    evidence,
    unresolved,
    capabilities: {
      three_dependency: hasThreeDependency,
      active_three_import: activeThreeImport,
      renderer: activeRenderer,
      scene: activeScene,
      render_call: activeRenderCall,
      webgpu,
      tsl: activeTsl,
      playable_runtime_claimed: status === 'complete',
    },
    notes,
  });
}
