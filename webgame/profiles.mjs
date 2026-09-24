export const WEBGAME_PROFILES = Object.freeze({
  'owned-chromium': Object.freeze({
    id: 'owned-chromium',
    browser: 'chromium',
    required_capabilities: ['loopback-server', 'isolated-browser', 'webgame-probe'],
  }),
});

export function webgameProfileById(id) {
  return WEBGAME_PROFILES[id] ?? null;
}
