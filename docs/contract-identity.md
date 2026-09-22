# Contract identity references

This document defines a consumer-facing identity layer for bskel-emitted contracts without changing
`sbf_contract: "9"`. The API contract remains the authority for feature and operation meaning;
runtime/profile identifiers owned by downstream tools are separate and MUST NOT redefine that meaning.

## Versions

- `sbf.contract-ref/1`
- `sbf.action-ref/1`
- `sbf.field-ref/1`
- canonical binding serialization: `beval.binding-json/1`

Consumers MAY vendor this specification and the golden vectors, but MUST NOT import bskel at runtime.

## ContractRef

```json
{
  "contract_ref": "sbf.contract-ref/1",
  "contract_hash": "<sha256 of exact UTF-8 contract bytes>",
  "sbf_contract": "9",
  "feature_id": "001-hello",
  "feature_uid": "5b66d55b-8c64-4d26-b7b9-f4d5c9f17a01"
}
```

`contract_hash` is byte identity, not semantic equivalence. Reformatting the JSON produces a different
artifact even when parsing yields the same object.

## ActionRef

```json
{
  "action_ref": "sbf.action-ref/1",
  "contract": { "...": "ContractRef" },
  "operation_id": "getHello"
}
```

`operation_id` is the exact key under `contract.operations`. Consumers MUST NOT repair a missing key
by stripping or adding a feature prefix or by searching another contract.

The existing wire/UI form `<feature_id>:<operation_id>` remains useful inside one known contract set,
but it is not globally unique and is never a replacement for ContractRef.

## FieldRef

```json
{
  "field_ref": "sbf.field-ref/1",
  "action": { "...": "ActionRef" },
  "location": "query",
  "pointer": "/name"
}
```

`location` is one of `path`, `query`, `header`, `cookie`, or `body`. `pointer` is a JSON
Pointer relative to that location's value map/body root. A consumer MUST NOT choose a bare field name
when more than one location can contain the same name.

## Canonical binding serialization

New cross-tool binding digests use this exact framing:

```text
beval.binding-json/1\n
<document-kind>\n
<canonical-json>
```

Canonical JSON rules:

1. UTF-8.
2. Object keys sorted lexicographically by JavaScript string comparison.
3. Array order preserved.
4. Two-space indentation.
5. One trailing LF.
6. Unicode is preserved exactly; no NFC/NFD normalization.
7. Only JSON values are accepted. `undefined`, functions, symbols, bigint, NaN, Infinity,
   non-plain objects, and sparse arrays are rejected.

The digest is SHA-256 over the framed UTF-8 bytes above. Existing bskel contract hashes, becoder hashes,
and beval artifact hashes are unchanged.

## Fail-closed requirements

A consumer that does not understand one of these identity versions may retain it for diagnostics but
must not use it for trusted execution or automatic promotion. Display labels, case aliases, profile IDs,
run UUIDs, and evidence UUIDs are intentionally outside ContractRef and cannot alter API meaning.
