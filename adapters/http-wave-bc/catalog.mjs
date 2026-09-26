export const HTTP_WAVE_BC_TARGETS = Object.freeze([
  { id: 'node-hono', wave: 'B', languageTrack: 'T04', runtime: 'node', scope: 'Hono literal routes, basePath and explicit route mounts' },
  { id: 'node-koa', wave: 'B', languageTrack: 'T04', runtime: 'node', scope: 'Koa + explicit router profile' },
  { id: 'typescript-nextjs', wave: 'B', languageTrack: 'T04', runtime: 'node', scope: 'Next.js server/API route handlers only' },
  { id: 'python-starlette', wave: 'B', languageTrack: 'T06', runtime: 'python', scope: 'Starlette Route/Mount declarations' },
  { id: 'python-litestar', wave: 'B', languageTrack: 'T06', runtime: 'python', scope: 'Litestar decorated routes/controllers' },
  { id: 'go-echo', wave: 'B', languageTrack: 'T08', runtime: 'go', scope: 'Echo route/group registration' },
  { id: 'go-fiber', wave: 'B', languageTrack: 'T08', runtime: 'go', scope: 'Fiber app/group route registration' },
  { id: 'rust-axum', wave: 'B', languageTrack: 'T08', runtime: 'rust', scope: 'Axum Router/route/nest graph' },
  { id: 'rust-actix-web', wave: 'B', languageTrack: 'T08', runtime: 'rust', scope: 'Actix service/scope/resource declarations' },
  { id: 'java-quarkus', wave: 'C', languageTrack: 'T05', runtime: 'jvm', scope: 'JAX-RS endpoints; classic/reactive profiles separated later' },
  { id: 'java-micronaut', wave: 'C', languageTrack: 'T05', runtime: 'jvm', scope: 'Micronaut controller annotations' },
  { id: 'kotlin-ktor', wave: 'C', languageTrack: 'T05', runtime: 'jvm', scope: 'Ktor routing DSL' },
  { id: 'php-symfony', wave: 'C', languageTrack: 'T07', runtime: 'php', scope: 'Symfony route attributes/YAML/XML profiles' },
  { id: 'elixir-phoenix', wave: 'C', languageTrack: 'T08', runtime: 'beam', scope: 'Phoenix router scopes/pipelines/resources' },
  { id: 'scala-play', wave: 'C', languageTrack: 'T08', runtime: 'jvm', scope: 'Play routes file + controllers' },
  { id: 'swift-vapor', wave: 'C', languageTrack: 'T08', runtime: 'swift', scope: 'Vapor route groups/collections' },
]);

export function validateWaveBcCatalog(targets = HTTP_WAVE_BC_TARGETS) {
  const errors = [];
  const seen = new Set();
  for (const target of targets) {
    if (!target || typeof target !== 'object') { errors.push('target must be an object'); continue; }
    if (!/^[a-z][a-z0-9-]*$/.test(target.id ?? '')) errors.push(`invalid id: ${String(target.id)}`);
    if (seen.has(target.id)) errors.push(`duplicate id: ${target.id}`);
    seen.add(target.id);
    if (!['B', 'C'].includes(target.wave)) errors.push(`${target.id}: wave must be B or C`);
    if (!/^T(?:04|05|06|07|08)$/.test(target.languageTrack ?? '')) errors.push(`${target.id}: invalid languageTrack`);
    for (const key of ['runtime', 'scope']) if (typeof target[key] !== 'string' || target[key].trim() === '') errors.push(`${target.id}: missing ${key}`);
  }
  const waveB = targets.filter((x) => x.wave === 'B').length;
  const waveC = targets.filter((x) => x.wave === 'C').length;
  if (waveB !== 9) errors.push(`Wave B must contain 9 targets, got ${waveB}`);
  if (waveC !== 7) errors.push(`Wave C must contain 7 targets, got ${waveC}`);
  return errors;
}
