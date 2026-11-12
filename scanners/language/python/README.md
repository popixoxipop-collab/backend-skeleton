# Python language scanner

This directory holds the Python analysis layer of track T06: a static reader for Python source and three framework shadows (FastAPI, Flask, Django). It is not part of the stable scanner path.

- `INTERFACE_RFC.md` describes the interface of the layer: inputs and outputs, identity, unknown and partial results, safety, promotion gates and file ownership. The test `test/language-python/interface-rfc.test.mjs` compares its tables and cited names with the code.
- `BASELINE.json` is the recorded baseline of the layer: counts, hashes and limits. The test `test/language-python/baseline-record.test.mjs` compares the pinned files and the replayed fixtures with it; its corpus test runs only when BASELINE_CORPUS_FETCH is 1.

The tests need a Python interpreter of version 3.8 or newer. Set `BSKEL_PYTHON` to choose one. CI does not run for a change that edits only Markdown files (limit `markdown-only-changes-skip-ci` of the interface document), so run the tests by hand after editing the documents of this directory. From the repository root:

    node scripts/run-next-nested-tests.mjs T06

The separate T06-02 evidence receipt records the exact Git revision, SHA-256 of this README, the RFC, the vocabulary, and the executable checks, plus the RFC command/exit code and zero-skip TAP counts. The verifier `node test/language-python/interface-rfc-evidence.mjs --check` reruns the command and checks those source blobs. It does not rewrite the historical T06-01 baseline, approve MET or certify runtime/release.
