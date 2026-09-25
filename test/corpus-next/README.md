# T19 QA corpus admission policy

This directory is a **verification input**, not a product support list. An entry can be useful for development without being eligible to certify a framework.

Admission rules:

1. Every source is pinned to an exact 40-hex commit and records its license status and repo-relative root.
2. Synthetic/repository fixtures and real third-party repositories are distinguished. A real repo uses a canonical `https://github.com/owner/repo` URL.
3. `development` entries may have pending independent review. `holdout` entries may not: their golden must already be independently reviewed before admission.
4. Candidate output cannot be copied into the golden and called independent verification. `golden.generated_by_candidate=true` is rejected.
5. A reviewed golden records a reviewer different from the author. The validator rejects self-review.
6. Runtime requirements are explicit (`none`, `optional`, `required`). A required runtime profile must be named; lack of runtime access cannot be silently converted to PASS.
7. The current `manifest.json` only seeds the existing local fixtures into the **development** cohort. Every entry intentionally remains pending independent golden review, so its `certification_eligible` count is zero.
8. Third-party corpus growth must preserve pinned source/license metadata. The existing `test/fixtures/oracle-manifest.json` remains the network shadow-validation corpus; T19 does not duplicate or silently reclassify it as independent ground truth.
