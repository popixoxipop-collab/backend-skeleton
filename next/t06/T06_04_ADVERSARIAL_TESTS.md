# T06-04 bounded adversarial tests

This slice tests the existing shadow-only Python AST analyzer. It does not change the analyzer, import or execute target source, wire a stable consumer, or claim runtime/holdout/certification/release authority.

Run `node --test test/language-python/t06-adversarial.test.mjs test/language-python/t06-mutation-catalog.test.mjs` and `node scripts/run-next-nested-tests.mjs T06`. The focused behavior suite tests normal and malformed source on real Python 3.11 and 3.12 interpreters when both are present, a real symlink escape, and a real unreadable file under a non-root reader. The matrix subtest explicitly skips when a host lacks either interpreter; a skip is not cross-version proof. The EACCES subtest skips for root rather than pretending mode 000 is unreadable. Record the per-host pass/skip counts and exit codes.

Run `node test/conformance-next/product-mutation-runner.mjs --repo-root . --catalog next/t06/T06_04_PRODUCT_MUTATIONS.json --source-commit <exact-clean-commit> --out <receipt>` against a clean committed tree. The four product-source mutants target unsafe integer coercion, lossy source decoding, source-size bypass, and project-root symlink escape. Record each baseline/mutant classification, exit code and the report hash. Catalog/anchor validation is isolated in `t06-mutation-catalog.test.mjs` and is deliberately absent from all mutant test-file lists: replacing a source string cannot count as a behavioral kill.

The `real-corpus.manifest.json` holdouts belong to T19 and remain sealed/unexecuted here. Python 3.11/3.12 fact parity is only for the selected stable syntax fixture; it does not certify arbitrary syntax, frameworks, or later Python versions. T00-04 remains PARTIAL.
