// Track A CI shim: the repository's existing npm test script only expands test/*.test.mjs.
// Importing the owned nested suite here makes those tests part of the existing CI without
// changing package.json or any shared CLI/gate file.
await import('./webgame-scan/parser.test.mjs');
await import('./webgame-scan/project-discovery.test.mjs');
await import('./webgame-scan/multiplane.test.mjs');
