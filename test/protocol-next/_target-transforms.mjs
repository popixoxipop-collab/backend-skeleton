import YAML from 'yaml';

function mapObjects(value, mapObject) {
  if (Array.isArray(value)) return value.map((item) => mapObjects(item, mapObject));
  if (value !== null && typeof value === 'object') {
    return mapObject(Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, mapObjects(inner, mapObject)])));
  }
  return value;
}

function mapArrays(value, mapArray) {
  if (Array.isArray(value)) return mapArray(value.map((item) => mapArrays(item, mapArray)));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, mapArrays(inner, mapArray)]));
  }
  return value;
}

const toJsonText = (value) => JSON.stringify(value, null, 2) + '\n';

// Serialization-only changes of a fixture input. The contract planes must not depend on any of them.
export const TRANSFORMS = Object.freeze({
  crlf: (text) => text.replace(/\r?\n/g, '\r\n'),
  'no-final-newline': (text) => text.replace(/(?:\r?\n)+$/, ''),
  'reverse-json-keys': (text) => toJsonText(mapObjects(JSON.parse(text), (object) => Object.fromEntries(Object.entries(object).reverse()))),
  'reverse-arrays': (text) => toJsonText(mapArrays(JSON.parse(text), (array) => [...array].reverse())),
  'yaml-to-json': (text) => toJsonText(YAML.parse(text)),
});

// A transform spec is one name or several joined with '+', applied left to right.
export function applyTransforms(text, spec) {
  return spec.split('+').reduce((current, name) => {
    const transform = TRANSFORMS[name];
    if (!transform) throw new Error('unknown input transform ' + name);
    return transform(current);
  }, text);
}
