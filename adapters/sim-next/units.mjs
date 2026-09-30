export const SIMULATION_UNIT_DIMENSIONS = Object.freeze({
  m: 'length',
  rad: 'angle',
  N: 'force',
  'N*m': 'torque',
  s: 'time',
  dimensionless: 'dimensionless',
});

const UP_AXES = new Set(['X','Y','Z']);
const HANDEDNESS = new Set(['left','right']);
const QUATERNION_ORDERS = new Set(['wxyz','xyzw']);

function finitePositive(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new TypeError(`${label} must be a positive finite number`);
  return value;
}

export function assertSimulationUnit(unit, { dimension } = {}) {
  const actual = SIMULATION_UNIT_DIMENSIONS[unit];
  if (!actual) throw new TypeError(`unsupported simulation unit: ${String(unit)}`);
  if (dimension && actual !== dimension) throw new TypeError(`unit ${unit} has dimension ${actual}, expected ${dimension}`);
  return unit;
}

export function assertCoordinateSystem(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('coordinates must be an object');
  if (typeof value.world_frame !== 'string' || !value.world_frame) throw new TypeError('coordinates.world_frame is required');
  if (!UP_AXES.has(value.up_axis)) throw new TypeError('coordinates.up_axis is invalid');
  if (!HANDEDNESS.has(value.handedness)) throw new TypeError('coordinates.handedness is invalid');
  if (!QUATERNION_ORDERS.has(value.quaternion_order)) throw new TypeError('coordinates.quaternion_order is invalid');
  return Object.freeze({ ...value });
}

export function assertSimulationTiming(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('timing must be an object');
  const physics_dt = finitePositive(value.physics_dt, 'timing.physics_dt');
  const control_dt = finitePositive(value.control_dt, 'timing.control_dt');
  if (!Number.isSafeInteger(value.decimation) || value.decimation <= 0) throw new TypeError('timing.decimation must be a positive safe integer');
  const render_dt = value.render_dt == null ? null : finitePositive(value.render_dt, 'timing.render_dt');
  return Object.freeze({ physics_dt, control_dt, decimation: value.decimation, render_dt });
}

export function assertQuantity(value, { dimension, frameRequired = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('quantity must be an object');
  if (typeof value.value !== 'number' || !Number.isFinite(value.value)) throw new TypeError('quantity.value must be finite');
  assertSimulationUnit(value.unit, { dimension });
  if (frameRequired && (typeof value.frame !== 'string' || !value.frame)) throw new TypeError('quantity.frame is required');
  if (value.frame !== undefined && value.frame !== null && (typeof value.frame !== 'string' || !value.frame)) throw new TypeError('quantity.frame is invalid');
  return Object.freeze({ value: value.value, unit: value.unit, frame: value.frame ?? null });
}
