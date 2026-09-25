// T21: keep the new performance/incremental tests on npm test's existing `test/*.test.mjs`
// path without changing package.json. The detailed tests live under test/perf-next so the
// workstream can grow independently without crowding the legacy test directory.
import './perf-next/t21-cache-key.test.mjs';
import './perf-next/t21-file-index-invalidation.test.mjs';
import './perf-next/t21-scheduler.test.mjs';
import './perf-next/t21-artifact-store.test.mjs';
import './perf-next/t21-artifact-gc.test.mjs';
import './perf-next/t21-cache-index.test.mjs';
import './perf-next/t21-cache-runtime.test.mjs';
import './perf-next/t21-legacy-cache-equivalence.test.mjs';
import './perf-next/t21-project-cache.test.mjs';
import './perf-next/t21-performance-policy.test.mjs';
import './perf-next/t21-benchmark-smoke.test.mjs';
