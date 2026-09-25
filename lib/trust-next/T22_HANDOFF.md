# T20 ↔ T22 external adapter security handoff

T22 owns a data-only adapter SDK. T20 owns the execution/security boundary. A T22-valid manifest is therefore treated as a **request**, never an execution grant.

`translateAdapterSdkPermissions()` independently checks the security-critical T22 fields and maps them into `bskel.trust-permissions/1`:

- readRoots → read_roots
- writeRoots → write_roots
- network deny-by-default → T20 network deny
- subprocess deny-by-default → T20 process deny
- requested environment names → T20 environment allowlist and its stricter injection-variable checks
- external adapter secret refs → none in the current T22 preview

The translation refuses:
- a non-manual activation mode;
- an unknown SDK manifest contract;
- invalid adapter IDs;
- unknown permission keys;
- any wider T22 network/subprocess value;
- roots or environment requests rejected by T20.

`reviewAdapterSdkSecurity()` returns a non-executable review with the normalized permission-manifest digest. It intentionally does **not** inspect package bytes, verify signatures, create a runner, load an adapter, or grant Runtime-tested status.

Later activation additionally requires:
1. exact package bytes independently hashed in an acquisition boundary;
2. T20 artifact trust for `usage=package`;
3. T16-approved effective runner/process policy;
4. external isolation evidence for admitted T20 adversarial cases;
5. runtime evidence binding requested/effective identities.

This module exists so integration cannot simply copy T22's request fields into a child process.
