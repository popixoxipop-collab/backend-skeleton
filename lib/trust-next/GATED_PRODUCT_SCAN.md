# T20 opt-in product gated scan

This T20-owned module connects the existing enforce-mode permission gate to real first-party runScan. It is a separate opt-in consumer, not the default bskel CLI or registry. A caller supplies a repository, an explicit T20 permission manifest, a bounded source-file list and optional terms. Every input file is approved and read through gate.read, copied into a fresh temporary snapshot, then scanned with the real product scanner. A rejected file aborts before the scanner runs.

The gate host offers only realpath and readFile. It offers no process, network, write, environment, listener, secret or device capability. The scanner and ripgrep still execute their own syscalls against the snapshot. This does not provide an OS sandbox for untrusted scanner code.

Supported cohort: Java Spring, JavaScript Express, Python FastAPI. The caller's file list is NOT proven complete. Hidden paths, traversal, .git, and node_modules are refused. Per-file input cap 2 MiB, aggregate cap 24 MiB, max 2048 files. External symbolic links are rejected. Concurrent parent-directory swaps remain outside the assurance scope: source trees must be quiescent. DB introspection and runtime routes are disabled.

The consumer returns the real scan report, source SHA-256 and sizes, permission digest, and self-checked gate audit. A self-computed hash chain is NOT a signed independent attestation. Production default behavior is unchanged.

Installed CLI invocation (explicit only):

    node node_modules/backend-skeleton/lib/trust-next/gated-product-scan-cli.mjs --repo /absolute/project --policy-json '{"schema":"bskel.trust-permissions/1","read_roots":["."]}' --files-json '["package.json","src/app.js"]'

Success returns JSON on stdout with exit 0. A denied read produces no successful stdout and exits 2 with structured stderr.

## Tests and release boundary

Run node --test test/trust-next/gated-product-scan.test.mjs and node scripts/run-next-nested-tests.mjs T20. Tests cover three real adapters, denied source files, unsafe paths and installed package CLI execution.

Ordinary bskel scan still uses its original entrypoint. The opt-in consumer does not mediate arbitrary process syscalls, prove complete file coverage or grant a signed release. T20-03/04/06, external provider integration, SLO, GC and T23 release gates remain separately blocked.
