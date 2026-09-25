const ANSI_RE = /\u001b\[[0-?]*[ -/]*[@-~]/g;

export function parseHonoShowRoutes(output) {
  const routes = [];
  const unknownLines = [];
  const lines = String(output ?? '').replace(/\r\n?/g, '\n').split('\n');

  for (let i = 0; i < lines.length; i++) {
    const original = lines[i];
    const line = original.replace(ANSI_RE, '').trim();
    if (!line) continue;

    const match = line.match(/^([A-Z][A-Z0-9_-]*)\s+(\/\S*)(?:\s+.*)?$/);
    if (!match) {
      unknownLines.push({ line: i + 1, text: line });
      continue;
    }

    routes.push({
      method: match[1],
      path: match[2],
      line: i + 1,
    });
  }

  return {
    schema: 'bskel.hono-show-routes-snapshot/1',
    routes,
    unknownLines,
  };
}
