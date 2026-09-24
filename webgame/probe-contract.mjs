function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function vec3(value, label, errors) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !finite(value.x) || !finite(value.y) || !finite(value.z)) {
    errors.push(`${label} must be a finite vec3`);
    return { x: 0, y: 0, z: 0 };
  }
  return { x: value.x, y: value.y, z: value.z };
}

export class WebgameProbeError extends Error {
  constructor(message, errors = []) {
    super(message);
    this.name = 'WebgameProbeError';
    this.errors = errors;
  }
}

export function parseProbeSample(raw, { index = 0 } = {}) {
  const errors = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new WebgameProbeError(`probe sample ${index} must be an object`);
  if (raw.schema !== 'sbf.webgame-probe/1') errors.push(`sample ${index}.schema must equal sbf.webgame-probe/1`);
  if (!Number.isInteger(raw.seq) || raw.seq < 0) errors.push(`sample ${index}.seq must be a non-negative integer`);
  if (!finite(raw.time_ms) || raw.time_ms < 0) errors.push(`sample ${index}.time_ms must be >= 0`);
  if (!Number.isInteger(raw.frame) || raw.frame < 0) errors.push(`sample ${index}.frame must be a non-negative integer`);
  const playerPosition = vec3(raw.player?.position, `sample ${index}.player.position`, errors);
  const playerVelocity = raw.player?.velocity === undefined ? null : vec3(raw.player.velocity, `sample ${index}.player.velocity`, errors);
  const cameraPosition = vec3(raw.camera?.position, `sample ${index}.camera.position`, errors);
  const active = raw.collisions?.active ?? [];
  if (!Array.isArray(active) || active.some((entry) => typeof entry !== 'string')) errors.push(`sample ${index}.collisions.active must be a string array`);
  const interactionCount = raw.interactions?.count ?? 0;
  if (!Number.isInteger(interactionCount) || interactionCount < 0) errors.push(`sample ${index}.interactions.count must be a non-negative integer`);
  if (errors.length) throw new WebgameProbeError(`invalid webgame probe sample: ${errors.join('; ')}`, errors);
  return {
    schema: raw.schema,
    seq: raw.seq,
    time_ms: raw.time_ms,
    frame: raw.frame,
    player: { position: playerPosition, velocity: playerVelocity },
    camera: { position: cameraPosition },
    collisions: { active: [...active] },
    interactions: { count: interactionCount },
  };
}

export function parseProbeSeries(samples) {
  if (!Array.isArray(samples) || samples.length < 2) throw new WebgameProbeError('probe series must contain at least two samples');
  const parsed = samples.map((sample, index) => parseProbeSample(sample, { index }));
  for (let index = 1; index < parsed.length; index += 1) {
    if (parsed[index].seq <= parsed[index - 1].seq) throw new WebgameProbeError(`probe seq must increase strictly at sample ${index}`);
    if (parsed[index].time_ms < parsed[index - 1].time_ms) throw new WebgameProbeError(`probe time_ms must be monotonic at sample ${index}`);
    if (parsed[index].frame < parsed[index - 1].frame) throw new WebgameProbeError(`probe frame must be monotonic at sample ${index}`);
  }
  return parsed;
}
