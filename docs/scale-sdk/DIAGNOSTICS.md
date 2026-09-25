# Support explanations and diagnostics

T22 keeps display/reporting separate from semantic truth.

## Support explanation

`createSupportExplanation()` receives already-decided capability and field states. It does not
derive support from framework popularity, adapter confidence, or a display name.

Allowed states:

- `supported`
- `partial`
- `unsupported`
- `unknown`
- `not-applicable`
- `conflict`

Each capability may carry evidence references, constraints and next actions. Each field may carry
provenance references and explicit conflict candidates. The default note states that detection
confidence is not runtime proof.

The same report can be consumed as JSON or rendered with
`renderSupportExplanationMarkdown()` for a human-readable table.

## Support evidence matrix

`buildSupportEvidenceMatrix()` deterministically projects one or more support explanations into a matrix
by adapter and capability. Missing evidence stays `unknown`; contradictory supported/unsupported
reports become `conflict` rather than picking a winner. The matrix is a view over supplied
evidence, not a new certification source.

`supportEvidenceMatrixDiagnostics()` turns unresolved matrix cells into structured diagnostics that can
then be projected to SARIF.

## SARIF

`diagnosticsToSarif()` maps structured diagnostics to SARIF 2.1.0 without changing their bskel
status/evidence metadata. Editor and CI tools can ingest the projection without making bskel depend
on an IDE.

The projection deliberately preserves:

- diagnostic code
- severity
- message
- source file/line when supplied
- adapter id
- bskel status
- evidence references

SARIF generation is a projection only. A warning becoming a SARIF `warning` does not make its
underlying claim more or less trustworthy.

## Future CLI integration

A future `capability explain` or diagnostics export command can expose these structures only after
the shared CLI owner approves names/exit behavior. T22 does not add new commands directly.
