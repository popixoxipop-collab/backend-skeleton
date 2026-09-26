# Artifact trust policy signatures

T20 reuses the existing bskel Ed25519 attestation primitive from `lib/attest.mjs`.

It does not invent:
- a second signature algorithm;
- a second canonicalization algorithm;
- key discovery/storage;
- automatic signer trust;
- timestamp authority.

The signed payload contains only:
- T20 signature contract;
- T20 policy schema;
- T20 policy digest format;
- exact normalized artifact-trust-policy SHA-256;
- policy generation.

Verification requires the caller to provide the trusted public key explicitly. `key_id` is checked against that key and may be additionally matched to an expected key id; it is not itself a trust root.

A correctly signed older generation can still be refused with `minimumGeneration`. This prevents signature validity from silently undoing a later revocation/policy generation.

Signature validity proves who signed these exact trust-policy bytes under the supplied key. It does not prove the policy is safe, that an artifact behaves correctly, or that runtime enforcement occurred.
