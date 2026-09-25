// T13 CI aggregation shim: package.json runs `node --test test/*.test.mjs`, so nested
// target tests are imported here without changing the shared test command or package metadata.
import './http-wave-bc/catalog.test.mjs';
import './http-wave-bc/node-hono.test.mjs';
import './http-wave-bc/hono-show-routes.test.mjs';
