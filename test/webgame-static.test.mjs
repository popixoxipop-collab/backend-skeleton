// Temporary Track A validation shim. Remove after Node 22/24 CI proves the nested suite.
await import('./webgame-scan/parser.test.mjs');
await import('./webgame-scan/project-discovery.test.mjs');
await import('./webgame-scan/multiplane.test.mjs');
await import('./webgame-scan/schema.test.mjs');
