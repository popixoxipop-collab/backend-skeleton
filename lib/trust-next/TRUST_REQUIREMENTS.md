# T20 trust requirements handoff

Status: data-only bridge for T16/T00-04B review. It is not a RunBinding, runner profile, sandbox, attestation or support certificate.

The T20 layer produces exactly two immutable identities that a runtime owner can bind into its own execution/evidence model:

1. normalized permission manifest digest
2. normalized artifact-trust-policy digest + generation

`buildTrustRequirements()` emits:

```json
{
  "contract": "bskel.trust-requirements/1",
  "permission": {
    "format": "bskel.trust-permissions-json/1",
    "sha256": "<exact normalized permission digest>"
  },
  "artifact_policy": {
    "format": "bskel.trust-artifact-policy-json/1",
    "sha256": "<exact normalized trust-policy digest>",
    "generation": 7
  }
}
```

The runtime/evidence owner may return a T20 echo only after independently enforcing those requirements:

```json
{
  "contract": "bskel.trust-evidence-echo/1",
  "permission": {
    "format": "bskel.trust-permissions-json/1",
    "sha256": "<same>",
    "enforced": true
  },
  "artifact_policy": {
    "format": "bskel.trust-artifact-policy-json/1",
    "sha256": "<same>",
    "generation": 7,
    "enforced": true
  }
}
```

T20 verifies exact equality and rejects:
- digest mismatch;
- trust-policy generation mismatch;
- `enforced:false`;
- unknown authority/display/runner fields smuggled into the T20 echo.

This intentionally **does not identify the runner**. T16/T00 owns runner/profile/attempt identity and must bind this T20 requirement object into the existing runtime evidence model rather than T20 inventing a parallel RunBinding.

A self-authored echo by candidate code is not sufficient evidence. The actual verifier/runner must produce or independently attest the enforcement result according to T16/T19/T00 policy.
