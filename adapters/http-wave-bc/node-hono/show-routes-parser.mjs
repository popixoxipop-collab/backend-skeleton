const ANSI_RE = /\u001b\[[0-?]*[ -/]*[@-~]/g;

export function parseHonoShowRoutes(output) {
  const routes = [];
  const unknownLines = [];
  const lines = String(output ?? '').replace(/\r\n?/g, '\n').split('\n');
  let currentRoute = null;

  for (let i = 0; i < lines.length; i++) {
    const original = lines[i];
    const clean = original.replace(ANSI_RE, '');
    const line = clean.trim();
    if (!line) continue;

    const match = line.match(/^([A-Z][A-Z0-9_-]*)\s+(\/\S*)(?:\s+.*)?$/);
    if (match) {
      currentRoute = {
        method: match[1],
        path: match[2],
        line: i + 1,
        handlers: [],
      };
      routes.push(currentRoute);
      continue;
    }

    if (currentRoute && /^\s+/.test(clean)) {
      currentRoute.handlers.push({ name: line, line: i + 1 });
      continue;
    }

    currentRoute = null;
    unknownLines.push({ line: i + 1, text: line });
  }

  return {
    schema: 'bskel.hono-show-routes-snapshot/1',
    routes,
    unknownLines,
  };
}
