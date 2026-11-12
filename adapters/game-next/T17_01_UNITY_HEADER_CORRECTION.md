# T17-01 Unity document header correction

The pinned `BASELINE.json` describes an older source revision. Its limit
`exporters-drop-unmodeled-text-with-a-diagnostic` was too broad: at that revision,
`--- !u!1 &6 stripped` could cause the first document to disappear without a
diagnostic, or allow its body to change the preceding document.

The current `parseUnityTextScene` accepts the narrow document header form
`--- !u!<class-id> &<file-id>`. A line beginning with `---` that does not match
that form now raises `unsupported Unity document header`; it cannot produce a
successful, silently incomplete export. Nonblank, noncomment content outside a
document that is neither a YAML nor `!u!` tag directive receives
`UNITY_UNMODELED_LINE`. The focused regression test covers a malformed header
before all documents, a malformed header after a valid document, and orphaned
preamble content.

This correction does not expand the text parser into a general Unity YAML
reader or verify engine runtime behavior. The old baseline remains a historical
record; current tests and the merged source revision establish this correction.
