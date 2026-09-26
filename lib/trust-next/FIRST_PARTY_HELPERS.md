# First-party helper trust profiles

T20 separates two execution classes that other tracks had started to describe independently.

## static-worker

Example: T08 native-language worker.

Properties:
- trusted absolute launcher/path resolution belongs to the runner, not repository input;
- launcher executable and packaged worker modules are exact-digest `usage=helper` assets;
- target source arrives through bounded stdin/data protocol;
- child has no target repository read/write roots;
- child inherits no environment;
- network deny;
- no acquisition phase;
- target initializers/build scripts are never executed.

This answers T08's path question: absolute `process.execPath` and packaged module paths are **runner-owned exact-digest assets outside repository read_roots**. The repository permission model should not be widened merely so Node can load its own approved package code.

## compiler-helper

Example: T05 / existing Java AST helper candidate.

Properties:
- input files are separately approved/exact-hash checked before helper execution;
- source roots and scratch are explicit;
- runtime network remains deny;
- dependency acquisition, when unavoidable, is a **separate phase** with exact host:port grants and its own digest;
- target application/build-script execution remains false;
- launcher/toolchain/wrapper assets are exact-digest trusted helper bytes.

The existing Gradle-backed Java AST bridge is therefore not promoted merely because a semantic backend receives `approvedHelperExecution:true`. The approval must eventually bind to this T20 trust request plus the T16 effective runner/profile/evidence.

## Evidence boundary

Both classes still emit `executable_now:false` and `runtime_binding_required:true`.

T20 expresses trust inputs and permission requests; T16/T00 owns effective process/container execution identity and external enforcement evidence. A helper being first-party does not make it an OS sandbox.
