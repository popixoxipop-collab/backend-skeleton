# T20 adversarial evidence evaluator

The fixture catalog describes what must be attacked. The evaluator describes what counts as evidence that an admitted runner resisted those attacks.

Default required layers:
- runner: 13 cases
- evidence: 1 case

Declaration-only cases are already unit-testable and can be evaluated separately.

A runtime/evidence case cannot become PASS from a boolean supplied by candidate code. Every pass/fail must:
- use the observer kind declared by the fixture specification;
- carry at least one bounded external evidence reference.

Blocked infrastructure remains `blocked` with an explicit reason. A product failure remains `fail`. Missing cases remain visible.

`ready:true` means all requested T20 adversarial observations are present and passing. It is **not** a Runtime-tested support certificate; T16/T19/T00 still own runtime binding, independent QA and promotion.
