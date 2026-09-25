// T20 test bridge: package.json currently runs only test/*.test.mjs.
// Keep substantive tests under the T20-owned test/trust-next/ namespace.
import './trust-next/permission-manifest.test.mjs';
import './trust-next/static-purity.test.mjs';
import './trust-next/adversarial-fixture-spec.test.mjs';
import './trust-next/artifact-trust.test.mjs';
import './trust-next/trust-requirements.test.mjs';
import './trust-next/external-adapter-permissions.test.mjs';
