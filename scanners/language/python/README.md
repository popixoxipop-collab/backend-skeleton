# Python language scanner

This directory holds the Python analysis layer of track T06: a static reader for Python source and three framework shadows (FastAPI, Flask, Django). It is not part of the stable scanner path.

- `INTERFACE_RFC.md` describes the interface of the layer: inputs and outputs, identity, unknown and partial results, safety, promotion gates and file ownership. The test `test/language-python/interface-rfc.test.mjs` compares its tables and cited names with the code.
- `BASELINE.json` is the recorded baseline of the layer: counts, hashes and limits. The test `test/language-python/baseline-record.test.mjs` compares the pinned files and the replayed fixtures with it; its corpus test runs only when BASELINE_CORPUS_FETCH is 1.

The tests need a Python interpreter of version 3.8 or newer. Set `BSKEL_PYTHON` to choose one. From the repository root:

    node scripts/run-next-nested-tests.mjs T06
