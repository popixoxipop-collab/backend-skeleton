// Root-level test entry so the repository's existing `node --test test/*.test.mjs` CI contract
// exercises T06 without changing package.json or the shared workflow. Cases remain owned under
// test/language-python/**.
import './language-python/python-analyzer.cases.mjs';
