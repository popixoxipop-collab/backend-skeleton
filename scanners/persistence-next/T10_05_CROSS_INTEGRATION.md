# T10-05 packed cross-integration evidence

`observe-cli.mjs` is a read-only, non-test consumer of the T10 persistence IR. It is included in the npm tarball under `scanners/persistence-next/`; it does not change the root `bskel` command, write a database, or certify generation/release scope.

Run it from the unpacked package (or this checkout):

```sh
node scanners/persistence-next/observe-cli.mjs <project-root> --provider prisma
node scanners/persistence-next/observe-cli.mjs <project-root> --provider active-record
node scanners/persistence-next/observe-cli.mjs <project-root> --provider django-orm
node scanners/persistence-next/observe-cli.mjs <project-root> --adapter java-spring
node scanners/persistence-next/observe-cli.mjs <project-root> --adapter python-fastapi
node scanners/persistence-next/observe-cli.mjs <project-root> --adapter typescript-express
node scanners/persistence-next/observe-cli.mjs <project-root> --model-facts rails app/models/order.rb
node scanners/persistence-next/observe-cli.mjs <project-root> --model-facts laravel app/Models/Order.php
```

Each command emits one `sbf.persistence-ir/1` JSON value to stdout. Provider mode uses the T10 registry. Adapter mode runs the stable adapter's own detect/scan and bridges its actual scan result. Model-facts mode reads one repository-relative source file, calls the actual T07 `sbf.model-facts/1` extractor, then passes its output to the T10 bridge. A model path escaping the project, including through a symlink, is refused. The T07 one-file mode does not join facts across files; unresolved or implicit names remain diagnostics/unknowns.

`test/persistence-next/cross-integration.test.mjs` packs the npm artifact, unpacks it outside the checkout, and executes this consumer against fixtures for all eight modes above. It verifies provider identity, selected physical names/key types, and real T07 provenance/relation handoff. The test is discovered by the required nested T10 CI lane. This evidence closes the earlier packed-artifact, non-test consumer, provider/runner combination, and actual T07-output-chain gaps for the admitted slice only. It does not admit blocked long-tail providers or replace live DB verification, T14's allowlist, or T19 release acceptance.
