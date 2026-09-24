import { parseProbeSeries } from './probe-contract.mjs';

function distance(left, right) {
  return Math.hypot(right.x - left.x, right.y - left.y, right.z - left.z);
}

function signedPlaneDistance(point, plane) {
  return point.x * plane.normal.x + point.y * plane.normal.y + point.z * plane.normal.z + plane.constant;
}

function result(type, passed, observed, expected) {
  return { type, passed, observed, expected };
}

function evaluate(assertion, samples) {
  const first = samples[0];
  const last = samples[samples.length - 1];
  const playerDisplacement = distance(first.player.position, last.player.position);
  const cameraDisplacement = distance(first.camera.position, last.camera.position);
  switch (assertion.type) {
    case 'render_frames': {
      const delta = last.frame - first.frame;
      return result(assertion.type, delta >= assertion.min_delta, delta, { min_delta: assertion.min_delta });
    }
    case 'player_displacement': {
      const underMax = assertion.max === undefined || playerDisplacement <= assertion.max;
      return result(assertion.type, playerDisplacement >= assertion.min && underMax, playerDisplacement, { min: assertion.min, max: assertion.max ?? null });
    }
    case 'camera_only_reject':
      return result(assertion.type, playerDisplacement >= assertion.min_player, { player: playerDisplacement, camera: cameraDisplacement }, { min_player: assertion.min_player });
    case 'max_step': {
      let max = 0;
      for (let index = 1; index < samples.length; index += 1) max = Math.max(max, distance(samples[index - 1].player.position, samples[index].player.position));
      return result(assertion.type, max <= assertion.max, max, { max: assertion.max });
    }
    case 'vertical_bounds': {
      let minY = first.player.position.y;
      let maxY = first.player.position.y;
      for (const sample of samples) {
        minY = Math.min(minY, sample.player.position.y);
        maxY = Math.max(maxY, sample.player.position.y);
      }
      const drop = first.player.position.y - minY;
      const rise = maxY - first.player.position.y;
      return result(assertion.type, drop <= assertion.max_drop && rise <= assertion.max_rise, { drop, rise }, { max_drop: assertion.max_drop, max_rise: assertion.max_rise });
    }
    case 'wall_crossing_reject': {
      const tolerance = assertion.tolerance ?? 0;
      const distances = samples.map((sample) => signedPlaneDistance(sample.player.position, assertion.plane));
      const passed = assertion.allowed_sign === 'positive'
        ? distances.every((value) => value >= -tolerance)
        : distances.every((value) => value <= tolerance);
      return result(assertion.type, passed, { min: Math.min(...distances), max: Math.max(...distances) }, { allowed_sign: assertion.allowed_sign, tolerance });
    }
    case 'interaction_count': {
      const delta = last.interactions.count - first.interactions.count;
      const exact = assertion.exact === undefined || delta === assertion.exact;
      const min = assertion.min === undefined || delta >= assertion.min;
      const max = assertion.max === undefined || delta <= assertion.max;
      return result(assertion.type, exact && min && max, delta, { exact: assertion.exact ?? null, min: assertion.min ?? null, max: assertion.max ?? null });
    }
    default:
      throw new Error(`unsupported assertion type: ${assertion.type}`);
  }
}

export function evaluateScenarioEvidence(scenario, rawSamples) {
  const samples = parseProbeSeries(rawSamples);
  const assertions = scenario.assertions.map((assertion) => evaluate(assertion, samples));
  return {
    schema: 'sbf.webgame-scenario-result/1',
    scenario_id: scenario.id,
    verdict: assertions.every((entry) => entry.passed) ? 'passed' : 'failed',
    sample_count: samples.length,
    assertions,
  };
}
