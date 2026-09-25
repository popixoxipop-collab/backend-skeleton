// Root-level shim so the repository's existing `node --test test/*.test.mjs` command executes
// T03's nested, ownership-local capability-next suite without changing package.json.
import './capability-next/core.test.mjs';
