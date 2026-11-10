# T07-04 scoped adversarial test packet

This packet tests the existing Ruby/PHP **static** DSL fact layer and the local
corpus read path. It does not certify Rails, Laravel or Symfony runtime route
equivalence, stable adapter registration, or a production release.

## Reproduction

```sh
node --test test/language-ruby-php/t07-adversarial.test.mjs test/language-ruby-php/t07-mutation-catalog.test.mjs
node --test test/language-ruby-php/*.test.mjs
node test/conformance-next/product-mutation-runner.mjs --repo-root . --catalog next/t07/T07_04_PRODUCT_MUTATIONS.json --source-commit <clean-exact-commit> --out <receipt.json>
```

The mutation runner requires a clean committed checkout and runs each mutant
against the behavioral test file. Its separate catalog-anchor test is absent
from every `test_files` entry so a textual mismatch cannot count as a kill.
The four product-source mutants exercise repository-relative source paths,
fact-span provenance, Rails dynamic-parent taint, and Laravel dynamic-group
taint. The normal/negative fixtures also cover finite Symfony HTTP methods,
dynamic PHP attribute paths, and a real non-root `EACCES` on a mode-000 route
file. Permission denial is skipped when running as root because that mode
does not enforce a denial there.

The cross-version matrix executes `ruby -c` on the same Rails fixture with
macOS Ruby 2.6 and Homebrew Ruby 4.0 when both are present. The static fact
output is checked once because the scanner itself is a Node program. Hosts
without both Ruby lines explicitly skip that local matrix; exact-head CI
executes the remaining static tests under its Node-version jobs. PHP 8
attribute inputs are static source-profile fixtures only: no PHP interpreter,
framework boot, or PHP cross-version runtime equivalence is claimed.

The sealed T19 holdouts are not opened. Existing T07 source-analyzer bytes and
the immutable pinned-corpus observation are intentionally unchanged.
