export const SIM_CANONICAL_UNITS = Object.freeze({
  length: 'm',
  angle: 'rad',
  force: 'N',
  torque: 'N*m',
  time: 's',
  dimensionless: '1',
});

export const SIM_HANDEDNESS = Object.freeze(['left', 'right']);
export const SIM_QUATERNION_ORDERS = Object.freeze(['wxyz', 'xyzw']);

export function assertFiniteNumber(value, label = 'value') {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${label} must be a finite number`);
  }
  return value;
}

export function assertFiniteVector(value, {
  label = 'vector',
  length,
  minLength = 1,
  maxLength = Infinity,
} = {}) {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  if (length !== undefined && value.length !== length) {
    throw new TypeError(`${label} must have length ${length}`);
  }
  if (value.length < minLength || value.length > maxLength) {
    throw new TypeError(`${label} has invalid length`);
  }
  return Object.freeze(value.map((item, index) => assertFiniteNumber(item, `${label}[${index}]`)));
}

export function assertSimulationUnits(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('units must be an object');
  const allowed = Object.keys(SIM_CANONICAL_UNITS);
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key)).sort();
  if (unexpected.length) throw new TypeError(`units contains unsupported fields: ${unexpected.join(', ')}`);
  for (const [dimension, unit] of Object.entries(SIM_CANONICAL_UNITS)) {
    if (value[dimension] !== undefined && value[dimension] !== unit) {
      throw new TypeError(`units.${dimension} must be ${unit}`);
    }
  }
  return Object.freeze({ ...value });
}

export function assertCoordinateSystem(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('coordinates must be an object');
  }
  const allowed = ['world_frame', 'up_axis', 'handedness', 'quaternion_order'];
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key)).sort();
  if (unexpected.length) throw new TypeError(`coordinates contains unsupported fields: ${unexpected.join(', ')}`);
  if (typeof value.world_frame !== 'string' || !value.world_frame) throw new TypeError('coordinates.world_frame is required');
  if (!['X', 'Y', 'Z'].includes(value.up_axis)) throw new TypeError('coordinates.up_axis must be X, Y, or Z');
  if (!SIM_HANDEDNESS.includes(value.handedness)) throw new TypeError('coordinates.handedness is invalid');
  if (!SIM_QUATERNION_ORDERS.includes(value.quaternion_order)) throw new TypeError('coordinates.quaternion_order is invalid');
  return Object.freeze({ ...value });
}

export function assertTiming(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('timing must be an object');
  const allowed = ['physics_dt', 'control_dt', 'decimation', 'render_dt'];
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key)).sort();
  if (unexpected.length) throw new TypeError(`timing contains unsupported fields: ${unexpected.join(', ')}`);

  const physicsDt = assertFiniteNumber(value.physics_dt, 'timing.physics_dt');
  const controlDt = assertFiniteNumber(value.control_dt, 'timing.control_dt');
  if (physicsDt <= 0 || controlDt <= 0) throw new TypeError('timing dt values must be positive');
  if (!Number.isSafeInteger(value.decimation) || value.decimation <= 0) {
    throw new TypeError('timing.decimation must be a positive safe integer');
  }
  if (value.render_dt !== null && value.render_dt !== undefined) {
    const renderDt = assertFiniteNumber(value.render_dt, 'timing.render_dt');
    if (renderDt <= 0) throw new TypeError('timing.render_dt must be positive');
  }

  const expectedControl = physicsDt * value.decimation;
  const tolerance = Math.max(1e-12, Math.abs(expectedControl) * 1e-9);
  if (Math.abs(controlDt - expectedControl) > tolerance) {
    throw new TypeError('timing.control_dt must equal physics_dt * decimation in draft-1');
  }
  return Object.freeze({ ...value });
}
