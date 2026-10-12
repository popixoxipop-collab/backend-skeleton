# Python analysis layer: interface RFC

Track T06, audit item T06-02. This document describes the layer in `scanners/language/python` as it is today and changes no code. The test `test/language-python/interface-rfc.test.mjs` holds the tables of this text to the code (last section): it compares the tables, the headings, the cited ids and paths and the identifier-like words with the vocabulary file next to the test and with the code. The sentences are not parsed.

## Purpose and non-goals

The layer reads Python source files without running them and turns what it reads into plain data, in four steps.

1. `ast-helper.py` parses one file in a child interpreter and returns facts: imports, classes, functions, assignments, calls and control-flow mutations. `analyzer.mjs` starts the helper and wraps its answer.
2. `resolver.mjs` builds a project from the successful file results: one module per file, import records, and symbol resolution across modules.
3. `type-shape.mjs` and `model-shape.mjs` turn annotation and class facts into type facts and model facts (pydantic, SQLModel, settings).
4. `fastapi-shadow.mjs`, `flask-shadow.mjs` and `django-shadow.mjs` read the project and report the routes they can see, with diagnostics for the ones they cannot. A shadow is a parallel result that is meant to be compared with the stable scanner output; no JavaScript or TypeScript file under `scanners/` outside this directory names this layer (claim `stable-scanners-do-not-import-the-layer`). Only FastAPI has a comparison function.

What the layer does not do:

- It parses target code to a syntax tree and does not run or import it (claim `helper-source-has-no-execution-primitives`). It reads the files named in a call and does not follow their imports to other files (see Safety).
- It does not model how Python finds modules: there are no source roots, no site-packages and no installed distributions. A module that is not among the analyzed files is external.
- It does not evaluate. Calls are recorded as facts with their arguments and are not executed. Arithmetic, comparisons, comprehensions, lambdas, conditional expressions and f-strings become facts of kind unknown that name the syntax node (the expressions table below).
- It does not check types, and it does not check that a resolved name exists (limit `resolved-names-are-not-checked`).
- It is not part of the stable scanner path: no stable scanner imports it (claim `stable-scanners-do-not-import-the-layer`). Wiring it in is a separate obligation (see Promotion gates).
- It does not promise that its shapes stay as they are. This document records them. A change of a shape must change this document and the vocabulary file in the same change, or the test fails.

## Scope

The directory holds the files below. The test requires this table to equal the directory listing.

| File | Role |
| --- | --- |
| `ast-helper.py` | Static AST helper, run in a child interpreter. Reads one request on stdin and writes one JSON response on stdout. It parses the target source to a syntax tree and does not import or execute it (claim `helper-source-has-no-execution-primitives`, checked on the helper source text). |
| `analyzer.mjs` | Entry points analyzePythonFile and analyzePythonFiles, interpreter discovery, request and response envelopes. |
| `resolver.mjs` | Project facts from helper results: module identity, import resolution, symbol resolution. |
| `type-shape.mjs` | Annotation normalization into type facts for model fields. |
| `model-shape.mjs` | Pydantic, SQLModel and settings model facts from class facts. |
| `fastapi-shadow.mjs` | Shadow FastAPI endpoints, mounts, entities and DTOs, and the parity report against a legacy scan. |
| `flask-shadow.mjs` | Shadow Flask route registrations and declarations. |
| `django-shadow.mjs` | Shadow Django URL registrations and includes composed from urlpatterns. |
| `BASELINE.json` | Recorded baseline of this layer (T06-01), pinned by baseline-record.test.mjs. Its artifact_digest seals the record and detects accidental edits only; this document does not repeat the digest. Not edited by T06-02. |
| `INTERFACE_RFC.md` | This document (T06-02). |
| `README.md` | Pointer to this document and to BASELINE.json. |

Every export of every `.mjs` module of the layer is in the next table. The test requires the export names of each module to equal its rows (plus the three protocol constants of `analyzer.mjs`) and copies each signature from the source. All functions are synchronous: none is declared async, and the claims below call them without waiting.

| Export | File | Signature | Takes | Returns |
| --- | --- | --- | --- | --- |
| `findPythonRuntime` | `analyzer.mjs` | `findPythonRuntime({ pythonCommand = null, denyRoots = [] } = {})` | an options object | a runtime handle, or null when no approved interpreter is found |
| `analyzePythonFile` | `analyzer.mjs` | `analyzePythonFile({ repoRoot, file, pythonCommand = null, timeoutMs = DEFAULT_TIMEOUT_MS, maxBuffer = DEFAULT_MAX_BUFFER, maxSourceBytes = DEFAULT_MAX_SOURCE_BYTES } = {})` | an options object | one file result (ok or failure); throws on bad arguments and on a file-system error raised while the source is resolved or read |
| `analyzePythonFiles` | `analyzer.mjs` | `analyzePythonFiles({ repoRoot, files, pythonCommand = null, timeoutMs = DEFAULT_TIMEOUT_MS, maxBuffer = DEFAULT_MAX_BUFFER, maxSourceBytes = DEFAULT_MAX_SOURCE_BYTES, maxFiles = DEFAULT_MAX_FILES } = {})` | an options object | a batch result with one file result per input, sorted by source path; throws on bad arguments and on a file-system error, like analyzePythonFile |
| `buildPythonProjectFacts` | `resolver.mjs` | `buildPythonProjectFacts(entries)` | file results (entries that are not ok are dropped) | a project |
| `resolvePythonSymbol` | `resolver.mjs` | `resolvePythonSymbol(project, moduleId, symbol)` | a project, a module id and a dotted symbol | a resolution (resolved or unknown) |
| `resolveValueSymbol` | `resolver.mjs` | `resolveValueSymbol(project, moduleId, value)` | a project, a module id and a value fact | a resolution (unknown value when the fact is not a symbol) |
| `normalizePythonType` | `type-shape.mjs` | `normalizePythonType(project, moduleId, annotation)` | a project, a module id and an annotation value fact | a type fact |
| `annotatePythonModelTypes` | `type-shape.mjs` | `annotatePythonModelTypes(project, models)` | a project and the models of projectPythonModels | the models with a typeFact on every field |
| `projectPythonModels` | `model-shape.mjs` | `projectPythonModels(project)` | a project | a list of models (classes of a known family only) |
| `buildFastApiShadow` | `fastapi-shadow.mjs` | `buildFastApiShadow(project)` | a project | a FastAPI shadow |
| `summarizeLegacyFastApi` | `fastapi-shadow.mjs` | `summarizeLegacyFastApi(legacyScan)` | a scan result of the legacy FastAPI scanner (hand-fed shape in this test) | the comparable legacy summary |
| `diffFastApiShadow` | `fastapi-shadow.mjs` | `diffFastApiShadow(legacyScan, shadow)` | a legacy scan result and a FastAPI shadow | a parity report |
| `buildFlaskRouteShadow` | `flask-shadow.mjs` | `buildFlaskRouteShadow(project)` | a project | a Flask shadow |
| `buildDjangoUrlShadow` | `django-shadow.mjs` | `buildDjangoUrlShadow(project)` | a project | a Django shadow |

Framework names are recognised after resolution, by what they resolve to and not by how they are spelled (claim `framework-names-are-matched-after-resolution`). The names that the code matches:

| File | Names matched | For |
| --- | --- | --- |
| `model-shape.mjs` | pydantic_settings.BaseSettings | family settings |
| `model-shape.mjs` | sqlmodel.SQLModel | family sqlmodel |
| `model-shape.mjs` | pydantic.BaseModel | family pydantic (only when no other family was found) |
| `model-shape.mjs` | pydantic.Field, sqlmodel.Field | field metadata |
| `fastapi-shadow.mjs` | fastapi.APIRouter, fastapi.FastAPI | router and app declarations |
| `flask-shadow.mjs` | flask.Flask, flask.Blueprint | app and blueprint declarations |
| `django-shadow.mjs` | django.urls.path, django.urls.re_path, django.urls.include | url registrations and includes |

## Inputs and outputs

### Calling the analyzer

`analyzePythonFile` analyzes one file and `analyzePythonFiles` analyzes a list of files. Each takes one options object and returns when the child processes have finished; neither returns a promise. File paths are resolved against `repoRoot`. The options:

| Option | Applies to | Default | Accepted | Rejected with |
| --- | --- | --- | --- | --- |
| `repoRoot` | analyzePythonFile, analyzePythonFiles | none | a directory path; its realpath is the project root | analyzePythonFile requires repoRoot and file |
| `file` | analyzePythonFile | none | a path inside repoRoot | analyzePythonFile requires repoRoot and file |
| `files` | analyzePythonFiles | none | an array of non-empty paths inside repoRoot | analyzePythonFiles requires repoRoot and files[] |
| `pythonCommand` | findPythonRuntime, analyzePythonFile, analyzePythonFiles | `null` | an absolute path, or a bare name of letters, digits and . _ + - searched in the absolute entries of PATH | none: an unusable value yields no runtime, not an error |
| `denyRoots` | findPythonRuntime | `[]` | directories; an interpreter whose realpath is inside one is refused (the analyzers pass the project root) | none: a refused interpreter yields no runtime |
| `timeoutMs` | analyzePythonFile, analyzePythonFiles | `DEFAULT_TIMEOUT_MS` | an integer from 1 to 30000 | timeoutMs must be an integer between 1 and 30000 |
| `maxBuffer` | analyzePythonFile, analyzePythonFiles | `DEFAULT_MAX_BUFFER` | an integer from 65536 to 16777216 | maxBuffer must be between 65536 and 16777216 |
| `maxSourceBytes` | analyzePythonFile, analyzePythonFiles | `DEFAULT_MAX_SOURCE_BYTES` | an integer from 1024 to 16777216 | maxSourceBytes must be between 1024 and 16777216 |
| `maxFiles` | analyzePythonFiles | `DEFAULT_MAX_FILES` | an integer from 1 to 100000 | maxFiles must be an integer between 1 and 100000 |

The numeric defaults are written once, in `analyzer.mjs`:

| Constant | Expression | Value | Meaning |
| --- | --- | --- | --- |
| `DEFAULT_TIMEOUT_MS` | `3000` | 3000 | helper wall-clock limit per file in milliseconds |
| `DEFAULT_MAX_BUFFER` | `4 * 1024 * 1024` | 4194304 | largest accepted helper stdout in bytes |
| `DEFAULT_MAX_SOURCE_BYTES` | `2 * 1024 * 1024` | 2097152 | largest source file that is sent to the helper, in bytes |
| `DEFAULT_MAX_FILES` | `4096` | 4096 | largest file list accepted by one batch call |

The limits are checked before any file is read, so an invalid limit reaches neither the file system nor a child process (claim `limits-are-validated-before-any-file-is-read`). A wrong call throws. So does a file-system error that is raised while a source is resolved or read: the raw system error is thrown as it is, ENOENT for a missing file and EACCES for a file that cannot be read, and no result is returned for that call (claim `argument-errors-are-thrown-not-returned` tries the missing file; the EACCES case is tried by a separate test, which runs for an ordinary user and is reported as skipped, with a reason, where the process can read a file of mode 000, as root can). Everything else that goes wrong with the content of one file, or with the child process that analyzes it, is a failed result (claim `helper-failures-are-results-not-throws`). The errors thrown for a wrong call:

| Condition | Message |
| --- | --- |
| analyzePythonFile without repoRoot or file | `analyzePythonFile requires repoRoot and file` |
| analyzePythonFiles without repoRoot or with files that is not an array | `analyzePythonFiles requires repoRoot and files[]` |
| more files than maxFiles (example: maxFiles 1, two files) | `Python file list exceeds configured 1-file analysis limit` |
| a files entry that is empty or not a string | `analyzePythonFiles files[] must contain non-empty strings` |
| two entries that resolve to the same real file (example: a symlink and its target) | `Duplicate Python source after realpath resolution: real.py` |
| a real path outside the project root, or the root itself (example: ../outside.py) | `Python source escapes project root: ../outside.py` |
| a path that is not a regular file (example: a directory named dir) | `Python source is not a regular file: dir` |

The order of the work decides which failure a caller sees.

1. The arguments and the limits are checked. A violation throws.
2. Each file is resolved to its real path, which must lie inside the root, and is read. A file that cannot be found or read makes the call throw the raw system error (claim `argument-errors-are-thrown-not-returned`). A file larger than `maxSourceBytes` becomes a failed result with the code PYTHON_SOURCE_TOO_LARGE at once, without a digest.
3. Only when at least one file is left is an interpreter looked for (claims `oversize-is-reported-before-interpreter-discovery` and `empty-and-oversize-batches-need-no-interpreter`). Without one, each such file is a failed result with the code PYTHON_RUNTIME_UNAVAILABLE that still carries the source reference: path, size and digest (claim `no-interpreter-keeps-the-source-reference`).
4. One child process runs per remaining file.

A batch returns its results sorted by source path (claim `batch-results-are-sorted-by-source-path`), the batch protocol string and the interpreter handle (null when no interpreter was needed or found). Its `ok` is true only when every result is ok.

### Finding an interpreter

`findPythonRuntime` returns the interpreter handle (executable and version text) or null (claim `interpreter-discovery-rules`). A null result is the only report: it does not say which candidate failed or why.

- With `pythonCommand`, that command is the only candidate and there is no fallback when it fails (claim `explicit-command-has-no-fallback`). Without it the candidates are, in order, the value of `BSKEL_PYTHON` when it is set, then `python3`, then `python`.
- An absolute command is used as written. A bare name of letters, digits and the characters dot, underscore, plus and minus is searched in the absolute entries of `PATH` only. Anything else (a relative path, a name with a separator, a space or a semicolon) is not used.
- The real path of the executable must not lie inside a directory of `denyRoots`. The analyzers pass the project root, so a project cannot supply the interpreter that analyzes it.
- A candidate is accepted when a one-line version probe exits with status 0 and prints three numbers separated by dots, and the major number is above 3 or the major number is 3 and the minor number is at least 8. The first accepted candidate wins; an executable that was already tried is not tried again.

### The helper protocol

The analyzer starts the helper once per file as the interpreter with the flags for isolated mode, no site directory, no bytecode files and UTF-8 mode, followed by `ast-helper.py` (claim `helper-is-started-isolated`). The child environment holds only `SystemRoot` and `WINDIR`, and only when the parent has them, so no module search path or other variable reaches the helper. The request goes in on standard input as one JSON object and one JSON document comes back on standard output. The three protocol strings:

| Constant | Value | Use |
| --- | --- | --- |
| `PYTHON_AST_REQUEST_PROTOCOL` | `bskel.python-ast.request/1` | request envelope sent to the helper on stdin; the helper constant REQ must equal it |
| `PYTHON_AST_RESPONSE_PROTOCOL` | `bskel.python-ast.response/1` | single-file response envelope; the helper constant RESP must equal it |
| `PYTHON_AST_BATCH_RESPONSE_PROTOCOL` | `bskel.python-ast.batch-response/1` | batch response envelope returned by analyzePythonFiles |

- The request holds `protocol` (the request string), `filename` (the path relative to the project root, with forward slashes) and `source_base64` (the bytes of the file in base 64). Nothing else is sent.
- A response holds `protocol` (the response string) and `ok`, then `runtime`, `sourceEncoding` and `facts` on success or `error` on failure. The analyzer adds the source reference.
- A response that is not JSON, that carries another protocol string or whose `ok` is not a boolean becomes a failed result with the code PYTHON_ANALYZER_PROTOCOL_ERROR.
- A helper that exits with a non-zero status gives PYTHON_ANALYZER_FAILED with the first 800 characters of its standard error (claim `stderr-is-cut-at-800-characters`). Running past `timeoutMs` gives PYTHON_ANALYZER_TIMEOUT. Any other failure of the child process, such as output beyond `maxBuffer`, gives PYTHON_ANALYZER_FAILED.
- The protocol strings of the analyzer and the helper must be equal (claim `helper-and-analyzer-agree-on-protocols`).

### Output shapes

The tables below list the keys of every kind of object that the samples return, in the order file results, helper facts, project and resolver, type facts, model facts, and the three shadows. The test recomputes them from samples (small Python projects written inside the test) on the interpreter it finds. A key followed by a question mark is missing from some of the sample objects of that kind. An object kind that no sample produces is not listed (limit `examples-are-small-fixtures`).

#### Analyzer results

| Object | Keys | What |
| --- | --- | --- |
| batch result | `ok`, `protocol`, `results`, `runtime` | Return value of analyzePythonFiles: ok is true only when every result is ok; runtime is null when no interpreter was needed or found. |
| error | `code`, `message` | An error without position: a code from the code table and a message. |
| error with position | `code`, `column`, `end_column`, `end_line`, `line`, `message` | A syntax error: code, message and the span reported by the interpreter parser. |
| file result failure | `error`, `ok`, `protocol`, `source` | Failed result for one file: ok false with an error and the source reference. An analysis failure is returned in this shape and not thrown; a file-system error raised while the source is resolved or read is thrown as it is. |
| file result ok | `facts`, `ok`, `protocol`, `runtime`, `source`, `sourceEncoding` | Successful result for one file: the facts, the interpreter identity and the source encoding. |
| helper runtime | `implementation`, `version` | Interpreter identity inside a successful file result: implementation and version as a list of integers. |
| runtime handle | `executable`, `version` | Interpreter found by discovery: realpath of the executable and version as text; also the runtime of a batch. |
| source reference | `encoding?`, `path`, `sha256?`, `sizeBytes` | The bytes a result describes. sha256 is absent for oversize files and encoding is present only on success. |

#### Helper facts

| Object | Keys | What |
| --- | --- | --- |
| argument fact | `annotation`, `column`, `default`, `end_column`, `end_line`, `kind`, `line`, `name` | One parameter of a function. |
| assignment fact | `annotation`, `column`, `end_column`, `end_line`, `line`, `targets`, `value` | A top-level or class-body assignment: targets, optional annotation, value. |
| augmented assignment fact | `column`, `end_column`, `end_line`, `line`, `operator`, `target`, `value` | A top-level augmented assignment; operator is the Python operator class name and is not a closed set. |
| call keyword | `name`, `value` | One keyword argument of a call value. |
| call statement fact | `column`, `end_column`, `end_line`, `line`, `value` | A top-level or class-body expression statement that is a call. |
| class fact | `bases`, `calls`, `column`, `decorators`, `end_column`, `end_line`, `fields`, `keywords`, `line`, `methods`, `name` | A top-level class with its bases, keywords, decorators, fields, methods and call statements. |
| class keyword | `name`, `value` | One keyword in a class header, for example metaclass or table. |
| control-flow mutation assignment | `annotation`, `column`, `end_column`, `end_line`, `kind`, `line`, `targets`, `value` | An assignment nested in control flow, recorded only as a mutation fact. |
| control-flow mutation augmented-assignment | `column`, `end_column`, `end_line`, `kind`, `line`, `operator`, `target`, `value` | An augmented assignment nested in control flow, recorded only as a mutation fact. |
| control-flow mutation call | `column`, `end_column`, `end_line`, `kind`, `line`, `value` | A call statement nested in control flow, recorded only as a mutation fact. |
| facts | `assignments`, `augmentedAssignments`, `calls`, `classes`, `controlFlowMutations`, `functions`, `imports` | The seven fact lists the helper extracts from top-level statements. |
| function fact | `arguments`, `async`, `column`, `decorators`, `end_column`, `end_line`, `line`, `name`, `returns` | A top-level function or a method. |
| import fact | `column`, `end_column`, `end_line`, `kind`, `level`, `line`, `module`, `names` | One import statement at the top level. |
| imported name | `alias`, `name` | One imported name of an import fact, with its alias. |
| mapping entry | `key`, `value` | One key and value of a mapping value. |
| value binary | `kind`, `left`, `operator`, `right` | A binary operation; only the BitOr operator is recorded, any other operator is an unknown value. |
| value call | `args`, `callee`, `column`, `end_column`, `end_line`, `keywords`, `kind`, `line` | A call with callee, arguments and keywords. |
| value constant | `kind`, `value` | A string, boolean, None or a number inside the JavaScript safe range. |
| value float-special | `kind`, `reason`, `value` | A non-finite float kept as text with a reason. |
| value integer | `decimal`, `kind`, `reason` | An integer outside the JavaScript safe range, kept as decimal text with a reason. |
| value mapping | `entries`, `kind` | A dict display with its entries. |
| value missing | `kind` | No expression was present (for example an absent annotation or default). |
| value sequence | `container`, `items`, `kind` | A list, tuple or set display with its items. |
| value subscript | `base`, `kind`, `slice` | A subscript with base and slice. |
| value symbol | `kind`, `name` | A name or dotted attribute chain. |
| value unknown | `kind`, `node`, `reason?` | An expression the helper does not evaluate; node is the Python AST class name. |

#### Project and resolver outputs

| Object | Keys | What |
| --- | --- | --- |
| collision | `moduleId`, `sources` | Several sources that map to one module id. Every source of a collision is excluded from the project. |
| import resolution ambiguous-import | `alias`, `alternateModule`, `kind`, `locality`, `module`, `name`, `source` | An import whose target module id is a collision. |
| import resolution module | `alias`, `importedLocality?`, `importedModule?`, `kind`, `locality`, `module`, `source` | Resolution of a plain import of a module. |
| import resolution star | `alias`, `kind`, `locality`, `module`, `source` | Resolution of a star import. |
| import resolution symbol | `alias`, `kind`, `locality`, `module`, `name`, `source` | Resolution of a from-import of one name. |
| module entry | `aliases`, `facts`, `importResolutions`, `isPackage`, `moduleId`, `packageId`, `source` | One analyzed module: identity, source, facts and the resolution of each of its imports. |
| project | `collisions`, `get`, `list`, `moduleLocality`, `modules` | Return value of buildPythonProjectFacts: the analyzed modules, the collisions and the lookups used by the other modules. |
| resolution ambiguous-import-target | `alternateModule`, `module`, `name`, `reason`, `status`, `symbol` | A name could be a submodule or a symbol of a package; both exist, so nothing is chosen. |
| resolution ambiguous-module | `module`, `reason`, `status`, `symbol` | The symbol leads into a module id that is a collision. |
| resolution cyclic-symbol-alias | `module`, `reason`, `status`, `symbol` | Following re-exports returned to a symbol already visited. |
| resolution resolved | `locality`, `module`, `name`, `status` | A symbol resolved to a module and an optional name. The name is not checked for existence. |
| resolution unknown bare | `status`, `symbol` | No resolution and nothing else is known. |
| resolution unknown value | `status`, `value` | resolveValueSymbol was given a value that is not a symbol. |
| resolution unknown with locality | `locality`, `module`, `name`, `status`, `symbol` | No resolution, but the locality of the module is known. |

#### Type facts

| Object | Keys | What |
| --- | --- | --- |
| type annotated | `base`, `kind`, `metadata`, `note` | typing.Annotated: the base type and the metadata value facts. |
| type builtin | `kind`, `name` | A builtin type name. |
| type forward-reference | `kind`, `text` | A string annotation, kept as text and not parsed. |
| type generic | `args`, `base`, `kind` | A subscripted type: base and arguments. |
| type literal | `kind`, `note`, `values` | typing.Literal: the value facts. |
| type none | `kind` | The None annotation. |
| type reference | `kind`, `locality`, `module`, `name`, `raw` | A name that resolved to a module and an optional name. |
| type union | `kind`, `options`, `syntax` | A union written as pep604, typing.Optional or typing.Union (syntax says which). |
| type unknown | `kind`, `raw?`, `reason` | The annotation could not be normalized; reason says why and raw keeps the fact when there is one. |
| type unresolved-reference | `kind`, `raw`, `reason` | A name that did not resolve; reason carries the resolver reason or unresolved. |

#### Model facts

| Object | Keys | What |
| --- | --- | --- |
| annotated model field | `annotation`, `declaredIn`, `default`, `line`, `metadata`, `name`, `typeFact` | A model field after annotatePythonModelTypes, with its typeFact. |
| field metadata | `alias`, `fieldCall`, `hasDefaultFactory`, `nullable`, `primaryKey` | Keyword facts read from a pydantic or sqlmodel Field call. |
| model | `bases`, `className`, `family`, `fields`, `inheritanceCycle`, `kind`, `limitations`, `module`, `primaryKeyFields`, `ref`, `table`, `tableStatus` | A class with a pydantic, SQLModel or settings ancestor. Classes of an unknown family are omitted. |
| model bases | `external`, `local` | Bases of a model split into local models (as refs) and external dotted names. |
| model field | `annotation`, `declaredIn`, `default`, `line`, `metadata`, `name` | A field of a model, declared in the class body. |

#### FastAPI shadow

| Object | Keys | What |
| --- | --- | --- |
| fastapi dto | `className`, `module` | A SQLModel class without table=True. |
| fastapi endpoint | `line`, `method`, `module`, `path`, `routerVar`, `source`, `verb` | A route declared with a literal path on a locally declared APIRouter. |
| fastapi entity | `className`, `module`, `primaryKeyFields` | A SQLModel class with table=True and its primary key fields. |
| fastapi mount | `child`, `line`, `module`, `prefix`, `prefixStatus`, `receiver`, `receiverKind`, `source` | An include_router call on a locally declared app or router. Mounts are recorded, not composed. |
| fastapi shadow | `dtos`, `endpoints`, `entities`, `mounts`, `unknowns` | Return value of buildFastApiShadow. |
| mount child resolved | `locality`, `module`, `name`, `raw` | The router argument of a mount resolved to a module and a name. |
| mount child unknown | `raw`, `reason`, `status` | The router argument of a mount could not be resolved. |
| parity counts | `legacy`, `shadow` | Counts of the legacy summary and of the shadow. |
| parity difference | `additionalInShadow`, `missingInShadow` | Keys present on one side only, for endpoints, entities or DTOs. |
| parity report | `counts`, `differenceCount`, `differences`, `parity`, `unknowns` | Return value of diffFastApiShadow. |
| parity side counts | `dtos`, `endpoints`, `entities` | Endpoint, entity and DTO counts of one side. |

#### Flask shadow

| Object | Keys | What |
| --- | --- | --- |
| flask declaration | `kind`, `line`, `module`, `prefix`, `prefixStatus`, `variable` | A locally declared Flask app or Blueprint with its prefix status. |
| flask registration | `function`, `limitations`, `line`, `localPath`, `methods`, `methodsStatus`, `module`, `path`, `prefix`, `receiver`, `receiverKind`, `source` | A route decorator with a literal rule on a locally declared app or blueprint. |
| flask shadow | `declarations`, `registrations`, `unknowns` | Return value of buildFlaskRouteShadow. |

#### Django shadow

| Object | Keys | What |
| --- | --- | --- |
| django include | `childModule`, `from`, `line`, `prefix` | An include edge from one url module to a child module (childModule is null when the target is not a literal module). |
| django registration | `kind`, `line`, `methodSemantics`, `module`, `name`, `nameStatus`, `patternSegments`, `source`, `target` | A path or re_path entry composed with the include prefixes above it. |
| django shadow | `includes`, `registrations`, `unknowns` | Return value of buildDjangoUrlShadow. |
| pattern segment | `kind`, `value` | One pattern text with its kind (path or regex). |
| view target class-view | `factory`, `kind`, `locality`, `module`, `name`, `raw` | A view given as Name.as_view(); the factory is recorded. |
| view target symbol | `kind`, `locality`, `module`, `name`, `raw` | A view given as a name that resolved to a symbol. |

## Identity

The derived outputs of the samples carry no schema, protocol, version or id key (claim `derived-outputs-carry-no-version-or-id`). The table below lists each identifier with the data it is derived from and the scope within which it is stable; the descriptions are written by hand, and each row names the claim that checks it. The one digest, the SHA-256 of the file bytes in the source reference, is a regression key: equal digests mean equal bytes and nothing else. The identity of a file is its path.

| Identifier | Strategy | Stable within | Breaks on | Note | Checked by |
| --- | --- | --- | --- | --- | --- |
| `source.path` | derived: realpath of the file made relative to the realpath of repoRoot, with / separators | one repoRoot and one file tree | renames; a symlink reports the path of its target | join key between results; use it, never the index in a batch | `source-path-is-the-realpath-relative-to-the-root` |
| `source.sha256` | digest of the raw source bytes (a regression key, not an identity) | the exact bytes | any edit, line-ending change or encoding change | equal digests mean equal bytes and nothing else | `no-interpreter-keeps-the-source-reference` |
| `moduleId` | derived from the source path: extension removed, / replaced by a dot, a trailing __init__ removed | one project snapshot | renames; source roots are ignored, so src.app.main is not app.main | a collision excludes every source of the id | `module-ids-come-from-paths` |
| `packageId` | derived from the source path: the directory of the file with / replaced by a dot (a package __init__ file gives its own directory), empty at the top level | one project snapshot | renames | p.q.py and p/q.py get the same module id p.q (a collision) but different package ids | `module-ids-come-from-paths` |
| `model ref` | derived: moduleId, a hash sign and the class name | one project snapshot | renames; a class defined twice in one module keeps the later definition | not unique when a module defines two classes of one name | `duplicate-names-last-definition-wins` |
| `import alias` | the local binding name inside one module | one module | a second import of the same alias replaces the first | only a second import replaces an import; an assignment, a function or a class of the same name does not (not modeled) | `duplicate-names-last-definition-wins` |
| `symbol resolution` | derived: the module id and optional name reached by following import records | one project snapshot | any change to the modules it passes through | a resolved name is not checked for existence | `resolved-names-are-not-checked` |
| `diagnostic` | none: a diagnostic has no id and is identified by its kind, module, line and the other fields it carries | one source revision | line numbers move with edits | compare whole objects, not positions | `derived-outputs-carry-no-version-or-id` |
| `parity key` | derived strings: VERB path#method for endpoints, className#key1,key2 for entities (the legacy side has one id field), className for DTOs | one pair of scans | renames, and the legacy scanner may spell paths differently | a regression key for the diff, not an identity of the route | `fastapi-parity-rule-and-keys` |
| `batch order` | sorted with localeCompare on source.path | one host locale | a different locale can order the same paths differently | never use the position as a key | `batch-results-are-sorted-by-source-path` |
| `protocol string` | constant, versioned by a trailing /1 | until the constant changes | a new protocol version | the only versioned identifiers in this layer | `helper-and-analyzer-agree-on-protocols` |

### Module identity

A module is identified by its path in the analyzed set. The module id is the directory parts and the file name without its last extension, joined by dots; a package `__init__` file takes the id of its directory. The package id is the directory of the file, written with dots, and is empty at the top level. No source root, no `site-packages` directory and no installed distribution take part (limit `module-ids-ignore-source-roots`). The rows below are produced by the resolver (claim `module-ids-come-from-paths`).

| Source path | Module id | Package id | Is a package |
| --- | --- | --- | --- |
| `my-dir/x.py` | `my-dir.x` | `my-dir` | false |
| `p.q.py` | `p.q` | (empty) | false |
| `pkg/__init__.py` | `pkg` | `pkg` | true |
| `pkg/mod.py` | `pkg.mod` | `pkg` | false |
| `src/app/main.py` | `src.app.main` | `src.app` | false |
| `top.py` | `top` | (empty) | false |

Two sources can produce one module id, for example `a/b.py` and `a/b/__init__.py`, or a module and its stub file. Such sources are listed as a collision, every source of a collision is left out of the project, and the id reads as ambiguous (claim `colliding-modules-are-excluded`).

| Module id | Sources |
| --- | --- |
| `a.b` | a/b.py, a/b/__init__.py |
| `stub` | stub.py, stub.pyi |

The locality of a module id says how far the layer can see. A module that failed to analyze is not in the project and reads as external (claim `failed-files-vanish-and-read-as-external`).

| Module id | Locality |
| --- | --- |
| `a.b` | `ambiguous` |
| `stub` | `ambiguous` |
| `nothere` | `external` |

### Symbol resolution

`resolvePythonSymbol` follows the import records of one module from a symbol to the module and optional name it leads to. A resolved name is the result of following records, not a proof that the name exists (claim `resolved-names-are-not-checked`). Two classes of one name keep the later one, and so do two imports of one alias. A name that is both an import alias and an assignment, a function or a class stays the import, in either order, because the alias is looked up before the names the module declares; a later binding does not replace the import (claim `duplicate-names-last-definition-wins`). The rows below are the outputs of the function on a sample project, hand-written inputs included.

| Function | Module | Symbol | Result |
| --- | --- | --- | --- |
| `resolvePythonSymbol` | `pkg.other` | `thing` | `{"status":"resolved","locality":"local","module":"pkg.thing","name":null}` |
| `resolvePythonSymbol` | `pkg.other` | `thing.Inner` | `{"status":"resolved","locality":"local","module":"pkg.thing","name":"Inner"}` |
| `resolvePythonSymbol` | `pkg.other` | `Inner` | `{"status":"resolved","locality":"local","module":"pkg.thing","name":"Inner"}` |
| `resolvePythonSymbol` | `pkg.other` | `Thing` | `{"status":"resolved","locality":"local","module":"pkg","name":"Thing"}` |
| `resolvePythonSymbol` | `pkg.other` | `t2` | `{"status":"resolved","locality":"local","module":"pkg.thing","name":null}` |
| `resolvePythonSymbol` | `pkg.other` | `up` | `{"status":"unknown","locality":"unresolved-local","module":"","name":"up","symbol":"up"}` |
| `resolvePythonSymbol` | `pkg.other` | `nowhere` | `{"status":"unknown","locality":"unresolved-local","module":null,"name":"nowhere","symbol":"nowhere"}` |
| `resolvePythonSymbol` | `pkg.other` | `p` | `{"status":"resolved","locality":"external","module":"os","name":"path"}` |
| `resolvePythonSymbol` | `pkg.other` | `os` | `{"status":"resolved","locality":"external","module":"os","name":null}` |
| `resolvePythonSymbol` | `pkg.other` | `osp` | `{"status":"resolved","locality":"external","module":"os.path","name":null}` |
| `resolvePythonSymbol` | `pkg.other` | `pkg.thing.Inner` | `{"status":"resolved","locality":"local","module":"pkg.thing","name":"Inner"}` |
| `resolvePythonSymbol` | `pkg.other` | `pkg` | `{"status":"resolved","locality":"local","module":"pkg","name":null}` |
| `resolvePythonSymbol` | `pkg.other` | `loads` | `{"status":"resolved","locality":"external","module":"json","name":"loads"}` |
| `resolvePythonSymbol` | `pkg.other` | `dumps` | `{"status":"resolved","locality":"external","module":"json","name":"dumps"}` |
| `resolvePythonSymbol` | `pkg.other` | `cx` | `{"status":"unknown","locality":"ambiguous","module":"collisions","name":"cx","symbol":"cx"}` |
| `resolvePythonSymbol` | `pkg.other` | `collisions.cx` | `{"status":"unknown","reason":"ambiguous-module","module":"collisions","symbol":"collisions.cx"}` |
| `resolvePythonSymbol` | `pkg.other` | `undefinedname` | `{"status":"unknown","symbol":"undefinedname"}` |
| `resolvePythonSymbol` | `pkg.other` | `(empty string)` | `{"status":"unknown","symbol":""}` |
| `resolvePythonSymbol` | `pkg.other` | `x.y.z` | `{"status":"unknown","symbol":"x.y.z"}` |
| `resolvePythonSymbol` | `pkg.other` | `Thing.attr` | `{"status":"resolved","locality":"local","module":"pkg","name":"Thing.attr"}` |
| `resolvePythonSymbol` | `cyc_a` | `q` | `{"status":"unknown","reason":"cyclic-symbol-alias","module":"cyc_a","symbol":"q"}` |
| `resolvePythonSymbol` | `user` | `name` | `{"status":"unknown","reason":"ambiguous-import-target","module":"amb","name":"name","alternateModule":"amb.name","symbol":"name"}` |
| `resolvePythonSymbol` | `no.such` | `x` | `{"status":"unknown","symbol":"x"}` |
| `resolvePythonSymbol` | `pkg.other` | `(the number 5)` | `{"status":"unknown","symbol":5}` |
| `resolveValueSymbol` | `pkg.other` | `(a constant value)` | `{"status":"unknown","value":{"kind":"constant","value":1}}` |
| `resolveValueSymbol` | `pkg.other` | `(null)` | `{"status":"unknown","value":null}` |

## Unknown, partial and unsupported

Unknown is not absent, and unknown is not supported. When the layer cannot decide, it says so with a word and, where it can, a reason, and it does not guess a value. It does not report every case it cannot read: the cases it drops without any report are named below and in the limits table, and an item that is absent from a result must not be read as not present. The words that results use are of four kinds.

- Status words in results: `status` is resolved or unknown on a symbol, and the name, prefix and table statuses are verified or unknown.
- Fact kinds: a value the helper cannot read as a literal is a fact of kind unknown that names the syntax node it came from, or the reason it stopped (the expressions table below).
- Diagnostics: a shadow reports a registration it cannot read as an object with a kind and a reason instead of an endpoint.
- Failed files: a file that cannot be analyzed is a result with `ok` false and a code, and it is not in the project.

The words are listed per property below. Each row is a word that the code can write; the test requires every string literal that the sources write after one of these property names, and every code word, to be listed here, and the samples to reach every listed word that is not declared unreachable.

#### `code`: error.code

| Word | Meaning |
| --- | --- |
| `INVALID_REQUEST` | Helper only: the request envelope could not be read. The analyzer always sends a valid one, so this code is unreachable through the entry points. |
| `PYTHON_ANALYZER_FAILED` | The helper did not complete: a spawn error other than a timeout (for example ENOBUFS when stdout passes maxBuffer), a non-zero exit (the message carries the first 800 characters of stderr) or an uncaught helper exception. |
| `PYTHON_ANALYZER_PROTOCOL_ERROR` | The helper exited 0 but stdout was not JSON, or the JSON lacked the response protocol or a boolean ok. |
| `PYTHON_ANALYZER_TIMEOUT` | The helper was killed after timeoutMs milliseconds. |
| `PYTHON_RUNTIME_UNAVAILABLE` | No approved interpreter was found. The result keeps path, sha256 and sizeBytes and has no facts. |
| `PYTHON_SOURCE_ENCODING_UNSUPPORTED` | The source declares an encoding the interpreter does not know, or its bytes do not decode. |
| `PYTHON_SOURCE_TOO_LARGE` | The file is larger than maxSourceBytes. Reported before any interpreter lookup; only path and sizeBytes are known. |
| `PYTHON_SYNTAX_ERROR` | The interpreter parser rejected the source. The error carries line, column, end_line and end_column. |

#### `container`: container of a sequence value

| Word | Meaning |
| --- | --- |
| `list` | A list display. |
| `set` | A set display. |
| `tuple` | A tuple display. |

#### `family`: family of a model

| Word | Meaning |
| --- | --- |
| `pydantic` | A base resolves to pydantic.BaseModel and no other family was found. |
| `settings` | A base resolves to pydantic_settings.BaseSettings. |
| `sqlmodel` | A base resolves to sqlmodel.SQLModel. |
| `unknown` | Internal: the class has no known family. Such classes are omitted from the output, so this word never appears in a result. |

#### `kind`: kind of a fact, resolution, type, model, registration or diagnostic

| Word | Meaning |
| --- | --- |
| `ambiguous-import` | An import whose target module id is a collision. |
| `annotated` | Type fact for typing.Annotated. |
| `app` | A locally declared Flask app, or the receiver of a mount that is a FastAPI app. |
| `assignment` | Control-flow mutation: a nested assignment. |
| `augmented-assignment` | Control-flow mutation: a nested augmented assignment. |
| `binary` | Value fact: a BitOr operation. |
| `blueprint` | A locally declared Flask Blueprint. |
| `builtin` | Type fact: a builtin type name. |
| `call` | Value fact of a call, or control-flow mutation of a nested call statement. |
| `class-view` | View target written as Name.as_view(). |
| `config` | Model kind for the settings family. |
| `constant` | Value fact: a literal inside the JavaScript safe range. |
| `django-urlconf` | Diagnostic about a whole url module. |
| `django-urlpattern` | Diagnostic about one urlpatterns entry. |
| `dto` | Model kind for a SQLModel class without table=True or a pydantic class. |
| `entity` | Model kind for a SQLModel class with table=True. |
| `fastapi-endpoint` | Diagnostic about one FastAPI route decorator. |
| `fastapi-mount` | Diagnostic about one include_router call. |
| `flask-route` | Diagnostic about one Flask route decorator. |
| `float-special` | Value fact: a non-finite float. |
| `forward-reference` | Type fact: a string annotation. |
| `from` | Import fact written as from-import. |
| `generic` | Type fact: a subscripted type. |
| `import` | Import fact written as plain import. |
| `integer` | Value fact: an integer outside the JavaScript safe range. |
| `keyword-only` | Parameter after the star marker. |
| `kwarg` | Parameter that collects keyword arguments. |
| `literal` | Type fact for typing.Literal. |
| `mapping` | Value fact: a dict display. |
| `missing` | Value fact: no expression present. |
| `module` | Import resolution of a plain import. |
| `none` | Type fact: the None annotation. |
| `path` | Pattern segment written with path(). |
| `positional` | Ordinary parameter. |
| `positional-only` | Parameter before the slash marker. |
| `reference` | Type fact: a name that resolved. |
| `regex` | Pattern segment written with re_path(). |
| `sequence` | Value fact: a list, tuple or set display. |
| `star` | Import resolution of a star import. |
| `subscript` | Value fact: a subscript. |
| `symbol` | Value fact for a name, import resolution of a from-import, or a view target that resolved. |
| `union` | Type fact: a union. |
| `unknown` | Value fact, type fact or model kind that is not decided; see the reason where one is given. |
| `unresolved-reference` | Type fact: a name that did not resolve. |
| `vararg` | Parameter that collects positional arguments. |

#### `locality`: locality of a module

| Word | Meaning |
| --- | --- |
| `ambiguous` | The module id is a collision; nothing is chosen. |
| `external` | The module id is not a module of the project (this includes modules whose analysis failed). |
| `external-or-unresolved` | A relative import that left the project tree, or a module that may be external; not decided. |
| `local` | The module id is a module of the project. |
| `unresolved-local` | A relative import that cannot be mapped to a module id. |

#### `methodSemantics`: meaning of the methods of a Django registration

| Word | Meaning |
| --- | --- |
| `not-declared-by-urlconf` | A Django url pattern does not declare HTTP methods; the view decides. No method list is derived. |

#### `methodsStatus`: how the HTTP methods of a Flask registration were found

| Word | Meaning |
| --- | --- |
| `explicit-decorator` | The method comes from the decorator name (get, post, put, patch or delete). |
| `explicit-methods-list` | The methods came from a literal methods list or tuple. |
| `framework-default-unresolved` | No methods were given; the framework default (GET) is not asserted. |

#### `nameStatus`: status of the name of a Django registration

| Word | Meaning |
| --- | --- |
| `unknown` | The name keyword was absent or not a literal string. |
| `verified` | The name keyword is a literal string. |

#### `prefixStatus`: status of a router or blueprint prefix

| Word | Meaning |
| --- | --- |
| `unknown` | The prefix is not a literal string; it is recorded as empty and not composed. |
| `verified` | The prefix is a literal string, or absent. |

#### `reason`: reason a value, type, resolution or diagnostic is unknown or partial

| Word | Meaning |
| --- | --- |
| `ambiguous-import-target` | A name could be a submodule or a symbol of a package and both exist. |
| `ambiguous-module` | The symbol leads into a module id that is a collision. |
| `blueprint-prefix-not-literal` | The blueprint url_prefix is not a literal string. |
| `cyclic-symbol-alias` | Following re-exports returned to a symbol already visited. |
| `depth-limit` | A value nested deeper than 12 levels is replaced by an unknown value. |
| `include-cycle` | A url module includes itself through its children; the stack is reported. |
| `include-router-mount-not-composed` | Every mount is reported: prefixes of mounted routers are not composed into endpoint paths. |
| `include-target-not-literal-module` | include() was given something other than a literal module path. |
| `included-module-not-in-project` | include() names a module that is not in the project. |
| `methods-not-literal-sequence` | The methods keyword is not a literal list, tuple or set of strings. |
| `missing-annotation` | The field has no annotation. |
| `non-finite-json-number` | The float is infinite and has no JSON number. |
| `non-type-constant` | The annotation is a constant that is not a string or None. |
| `outside-js-safe-integer` | The integer is outside plus or minus 2 to the power 53 minus 1. |
| `pattern-entry-not-static-call` | A urlpatterns entry is not a call. |
| `regex-include-prefix-not-composed` | A re_path prefix of an include is not composed into child patterns. |
| `route-path-not-literal` | The route path is not a literal string. |
| `route-pattern-not-literal` | The pattern of a path or re_path call is not a literal string. |
| `route-receiver-not-locally-declared` | The decorated receiver is not an app or blueprint declared in the same module. |
| `router-argument-not-static-symbol` | The router argument of include_router is not a plain name. |
| `router-prefix-not-literal` | The router prefix is not a literal string; the endpoint is not emitted. |
| `router-variable-not-locally-declared` | The decorated variable is not an APIRouter declared in the same module. |
| `unresolved` | A name did not resolve and the resolver gave no reason. |
| `unresolved-generic-base` | The base of a subscripted annotation is unknown. |
| `unsupported-annotation-expression` | The annotation is an expression the normalizer does not read. |
| `unsupported-url-registration-callee` | A call in urlpatterns is not path, re_path or include. |
| `urlpatterns-ambiguous` | urlpatterns is assigned more than once. |
| `urlpatterns-dynamic` | urlpatterns is not a literal list or tuple. |
| `urlpatterns-mutated` | urlpatterns is changed after its assignment. |
| `view-call-not-statically-classifiable` | The view is a call other than Name.as_view(). |
| `view-expression-not-static` | The view is an expression that is not a name or a call. |
| `view-missing` | The path call has no view argument. |
| `view-symbol-unresolved` | The view name did not resolve to a symbol (the resolver reason is used when it gave one). |

#### `receiverKind`: kind of the receiver of a mount

| Word | Meaning |
| --- | --- |
| `app` | The receiver of include_router is a locally declared FastAPI app. |
| `blueprint` | Reserved word of the same property in the Flask declaration; see kind. |
| `router` | The receiver of include_router is a locally declared APIRouter. |

#### `status`: status of a resolution, mount child or view target

| Word | Meaning |
| --- | --- |
| `resolved` | The symbol, router or view was resolved to a module and name. |
| `unknown` | Not resolved. Nothing is claimed about the target. |

#### `syntax`: spelling of a union type

| Word | Meaning |
| --- | --- |
| `pep604` | A union written with the vertical bar. |
| `typing.Optional` | A union written as Optional. |
| `typing.Union` | A union written as Union. |

#### `tableStatus`: status of the SQLModel table keyword

| Word | Meaning |
| --- | --- |
| `unknown` | The table keyword is not a literal boolean. |
| `verified` | The table keyword is a literal boolean or absent. |

Some words cannot be reached through the entry points of the layer and are declared instead of sampled:

| Property | Word | Written in | Literal |
| --- | --- | --- | --- |
| `code` | `INVALID_REQUEST` | `ast-helper.py` | `INVALID_REQUEST` |
| `family` | `unknown` | `model-shape.mjs` | `let family = 'unknown'` |

### What is partial

A result is partial when it describes less than the source holds. The partial cases are named and tested.

- Depth: a value is read down to its 13th nesting level and a node on the 14th level is unknown with the reason depth-limit (claim `numeric-and-depth-rules`).
- Numbers: an integer beyond the safe integer range of JSON keeps its decimal text, and an infinite float (1e999 and -1e999 in the sample) is float-special with the reason non-finite-json-number and is not written as a JSON number (claim `numeric-and-depth-rules`).
- Nesting of statements: definitions and imports below the top level or inside control flow are not facts. Assignments, augmented assignments and calls inside control flow are kept as mutation facts (claim `nested-statements-are-dropped`).
- Files: a failed file is absent from the project (limit `failed-files-vanish-from-the-project`). A syntax error carries a position, whose end fields are null before Python 3.10, and an unknown or undecodable encoding has its own code (claim `syntax-errors-carry-a-position`). Which syntax is accepted follows the interpreter in use (claim `syntax-support-follows-the-interpreter`). Source with 300 nested parentheses fails as a file (claim `deeply-nested-parentheses-fail-the-file`), and a chain of 20000 attributes fails the helper (claim `deep-attribute-chains-fail-the-helper`).
- Models: a class is left out of the models, without a diagnostic, when none of its bases establishes a recognized family. A base that does not resolve is ignored, so a class with an unresolved base next to a recognized one stays a model (claim `unresolved-model-bases-are-omitted`).
- Mounts: a FastAPI `include_router` call is recorded where it is made, and its prefix is not composed into endpoint paths (claim `mounts-are-recorded-not-composed`). A Flask `register_blueprint` call is not recorded at all: the result is the same with and without the call, a blueprint route keeps the prefix of its own blueprint, and its `limitations` list says that mount overrides are not composed (claim `flask-register-blueprint-is-not-recorded`, limit `flask-blueprint-mounts-are-not-recorded`).
- Dynamic values: a route path, a method list or a prefix that is not a literal is reported as a diagnostic and the route is not emitted (claim `dynamic-values-are-reported-as-unknown`).

### Facts that are not evaluated

The helper reads literals and names. It does not evaluate. The rows below show the source of each sample line and the fact the helper wrote for it.

| Source line | Fact |
| --- | --- |
| `A = 1` | `{"kind":"constant","value":1}` |
| `B = -1` | `{"kind":"constant","value":-1}` |
| `B2 = +2` | `{"kind":"constant","value":2}` |
| `C = 1.5` | `{"kind":"constant","value":1.5}` |
| `D = True` | `{"kind":"constant","value":true}` |
| `E = None` | `{"kind":"constant","value":null}` |
| `F = "s" "t"` | `{"kind":"constant","value":"st"}` |
| `G = 12345678901234567890` | `{"decimal":"12345678901234567890","kind":"integer","reason":"outside-js-safe-integer"}` |
| `G2 = 9007199254740993` | `{"decimal":"9007199254740993","kind":"integer","reason":"outside-js-safe-integer"}` |
| `G3 = -9007199254740992` | `{"decimal":"-9007199254740992","kind":"integer","reason":"outside-js-safe-integer"}` |
| `H = 1e999` | `{"kind":"float-special","reason":"non-finite-json-number","value":"Infinity"}` |
| `H2 = -1e999` | `{"kind":"float-special","reason":"non-finite-json-number","value":"-Infinity"}` |
| `K = 1j` | `{"kind":"unknown","node":"complex"}` |
| `L = b"x"` | `{"kind":"unknown","node":"bytes"}` |
| `M = ...` | `{"kind":"unknown","node":"ellipsis"}` |
| `S = int \| str` | `{"kind":"binary","left":{"kind":"symbol","name":"int"},"operator":"BitOr","right":{"kind":"symbol","name":"str"}}` |
| `NA = ~1` | `{"kind":"unknown","node":"UnaryOp"}` |
| `NB = not x` | `{"kind":"unknown","node":"UnaryOp"}` |
| `NC = 1 + 2` | `{"kind":"unknown","node":"BinOp"}` |
| `ND = -x` | `{"kind":"unknown","node":"UnaryOp"}` |
| `NE = -True` | `{"kind":"unknown","node":"UnaryOp"}` |
| `T = a if b else c` | `{"kind":"unknown","node":"IfExp"}` |
| `U = lambda: 0` | `{"kind":"unknown","node":"Lambda"}` |
| `V = [x for x in y]` | `{"kind":"unknown","node":"ListComp"}` |
| `W = f"{x}"` | `{"kind":"unknown","node":"JoinedStr"}` |
| `X = x.y().z` | `{"kind":"unknown","node":"Attribute"}` |

### Diagnostics

The shadows report what they cannot read as diagnostics. Each diagnostic is identified by its kind and its reason; the keys are the union over the samples that produce it. A diagnostic has no identifier of its own and no severity.

| Diagnostic (kind, then reason) | Keys | When |
| --- | --- | --- |
| `django-urlconf include-cycle` | `kind`, `module`, `reason`, `stack` | A url module is reached again through its own includes. |
| `django-urlconf include-target-not-literal-module` | `kind`, `module`, `pattern`, `reason` | include() argument is not a literal module path. |
| `django-urlconf included-module-not-in-project` | `kind`, `module`, `reason` | include() names a module that is not in the project. |
| `django-urlconf regex-include-prefix-not-composed` | `childModule`, `kind`, `module`, `pattern`, `reason` | include() under a re_path prefix; the prefix is not composed. |
| `django-urlconf urlpatterns-ambiguous` | `kind`, `module`, `reason` | urlpatterns is assigned more than once in a module. |
| `django-urlconf urlpatterns-dynamic` | `kind`, `module`, `reason` | urlpatterns is not a literal list or tuple. |
| `django-urlconf urlpatterns-mutated` | `kind`, `module`, `reason` | urlpatterns is mutated after assignment. |
| `django-urlpattern pattern-entry-not-static-call` | `kind`, `module`, `reason` | A urlpatterns entry that is not a call. |
| `django-urlpattern route-pattern-not-literal` | `callee`, `kind`, `module`, `reason` | The pattern of path or re_path is not a literal string. |
| `django-urlpattern unsupported-url-registration-callee` | `callee`, `kind`, `module`, `reason` | A call in urlpatterns other than path, re_path or include. |
| `django-urlpattern view-call-not-statically-classifiable` | `kind`, `module`, `pattern`, `rawTarget`, `reason` | A view given as a call other than as_view. |
| `django-urlpattern view-expression-not-static` | `kind`, `module`, `pattern`, `rawTarget`, `reason` | A view given as an expression that is not a name or a call. |
| `django-urlpattern view-missing` | `kind`, `module`, `pattern`, `reason` | A path call without a view. |
| `django-urlpattern view-symbol-unresolved` | `kind`, `module`, `pattern`, `rawTarget`, `reason` | A view name that did not resolve. |
| `fastapi-endpoint route-path-not-literal` | `kind`, `line`, `method`, `module`, `reason`, `routerVar` | A route decorator whose path is not a literal string. |
| `fastapi-endpoint router-prefix-not-literal` | `kind`, `line`, `localPath`, `method`, `module`, `reason`, `routerVar` | A route on a router whose prefix is not a literal string; no endpoint is emitted for it. |
| `fastapi-endpoint router-variable-not-locally-declared` | `kind`, `line`, `method`, `module`, `reason`, `routerVar` | A route decorator on a variable that is not a locally declared APIRouter (this includes decorators on the FastAPI app itself). |
| `fastapi-mount include-router-mount-not-composed` | `child`, `kind`, `line`, `module`, `prefix`, `prefixStatus`, `reason`, `receiver` | An include_router call; the mount is listed in mounts and its prefix is not composed into endpoint paths. |
| `flask-route blueprint-prefix-not-literal` | `function`, `kind`, `line`, `localPath`, `module`, `reason`, `receiver` | A blueprint route whose blueprint url_prefix is not a literal string. |
| `flask-route methods-not-literal-sequence` | `function`, `kind`, `line`, `localPath`, `module`, `reason`, `receiver` | A route whose methods keyword is not a literal sequence of strings. |
| `flask-route route-path-not-literal` | `function`, `kind`, `line`, `module`, `reason`, `receiver` | A route decorator whose rule is not a literal string. |
| `flask-route route-receiver-not-locally-declared` | `function`, `kind`, `line`, `module`, `reason`, `receiver` | A route decorator on a name that is not a locally declared app or blueprint. |

### Silent cases

Some registrations are dropped without a fact or a diagnostic (limit `shadow-silent-cases`). They are named so that nobody reads their absence as support:

- FastAPI: the decorators for options and for the general route form, and an include of a router on a receiver that is not a locally declared app or router (claim `fastapi-silent-cases`).
- Flask: the call that adds a URL rule, a bare route decorator and the options decorator (claim `flask-silent-cases`).
- Django: an include of a project module that has no URL pattern list is an include edge with no registration and no diagnostic (claim `django-include-without-urlpatterns-is-silent`).

An absent endpoint therefore reads as not supported or not seen. It is no evidence that a route is not present.

### Parity with the legacy scanner

`fastapi-shadow.mjs` can compare its endpoints with the output of the stable FastAPI scanner. The comparison is true only when the number of differences is zero and the shadow has no unknowns, and the differences are named by parity keys (claim `fastapi-parity-rule-and-keys`). The legacy scan shape in the samples is written by hand in the test and not produced by the legacy scanner (limit `legacy-scan-shape-is-hand-fed`).

## Safety

The layer is static. It reads Python source as bytes and parses it to a syntax tree. The claim `helper-source-has-no-execution-primitives` reads the helper source for calls that would run, import or compile the code it parses; it does not observe a run.

- The helper parses with the parser of the interpreter. It imports only `ast`, `base64`, `io`, `json`, `math`, `sys` and `tokenize`, contains no call of exec, eval, compile, open or `__import__`, and does not use os, subprocess, importlib or socket. Among the JavaScript modules only `analyzer.mjs` imports the child process and file system modules, and it calls only the stat, real path and read calls of the file system module (claim `helper-source-has-no-execution-primitives`). The other modules do not import those two modules.
- The files that are read are the ones named in the call. The analyzer resolves each one to its real path, requires that path to lie inside `repoRoot` (a symlink to a file outside throws), and reads it once. It does not follow the imports it finds in the source to other files, and it writes nothing.
- An interpreter that lies inside the project root is refused, because the root is passed as a deny root (claim `interpreter-discovery-rules`).
- A call is bounded in wall time per file (`timeoutMs`), in output size (`maxBuffer`), in source size (`maxSourceBytes`) and in the number of files (`maxFiles`). The memory of the interpreter is not bounded (limit `no-memory-bound`).
- There is no operating system sandbox. The helper runs with the privileges of the caller; its isolation is the interpreter flags, the near-empty environment and the absence of execution primitives (limit `no-os-sandbox`).
- Parsing hostile source can still make the interpreter fail. Such failures come back as failed files with a code and are not crashes of the caller (claims `deeply-nested-parentheses-fail-the-file` and `deep-attribute-chains-fail-the-helper`).

## Checked statements

A behaviour statement of this document that names a claim is backed by the check of that claim. The check does not read the sentence: it runs the real code on a sample written in the test, or reads the sources, and compares the result with values written in the check. Where a sentence says every, all, only or never, the check covers the cases of its sample and the sources it reads, not every possible input. A sentence that names no claim or limit is read from the source and is not checked. The needs column says what a check requires: none (plain Node), static (the source files), posix (a shell script that stands in for the interpreter, so the check is not evaluated on Windows) and python (an interpreter found by the discovery rules above).

A check that needs an interpreter fails when none is found, unless `BASELINE_ALLOW_UNVERIFIED` is set to 1. In that case the test skips the check, and the skip message says that it was not run. A skipped check is not a pass.

| Id | Needs | Statement |
| --- | --- | --- |
| `limits-are-validated-before-any-file-is-read` | none | An out-of-range timeoutMs, maxBuffer, maxSourceBytes or maxFiles throws the message in the options table even when the file does not exist. |
| `argument-errors-are-thrown-not-returned` | posix | Bad arguments, an over-long list, an empty entry, a duplicate after realpath, a path outside the root and a non-regular file throw the messages in the errors table; a missing file throws the raw ENOENT error and a file that cannot be read throws the raw EACCES error. This claim tries the missing file; the EACCES case is tried by a separate test that runs for an ordinary user and is reported as skipped, with a reason, where the process can read a file of mode 000 (root, for example). |
| `oversize-is-reported-before-interpreter-discovery` | posix | A file larger than maxSourceBytes yields PYTHON_SOURCE_TOO_LARGE with only path and sizeBytes, and no interpreter is looked up. |
| `no-interpreter-keeps-the-source-reference` | none | Without an approved interpreter a file yields PYTHON_RUNTIME_UNAVAILABLE with path, sha256 (the digest of the file bytes) and sizeBytes and no facts. |
| `empty-and-oversize-batches-need-no-interpreter` | posix | An empty file list returns ok true and a null runtime; a batch of only oversize files returns ok false and a null runtime; neither looks for an interpreter. |
| `explicit-command-has-no-fallback` | posix | An explicit pythonCommand that cannot be used yields no runtime; python3 and python are not tried. |
| `batch-results-are-sorted-by-source-path` | none | Batch results are ordered by localeCompare of source.path, whatever the input order. |
| `source-path-is-the-realpath-relative-to-the-root` | posix | A symlink inside the root reports the path of its target; a symlink to a file outside the root throws. |
| `interpreter-discovery-rules` | posix | BSKEL_PYTHON is tried first; a bare name is searched only in absolute PATH entries; versions below 3.8 and unparsable probe output are refused; an interpreter inside the project root is refused. |
| `helper-failures-are-results-not-throws` | posix | A timeout, a non-zero exit, output that is not JSON, a wrong envelope and an output flood are returned as ok false results with their codes. |
| `stderr-is-cut-at-800-characters` | posix | The stderr text in a non-zero exit message is cut at 800 characters without a marker. |
| `helper-is-started-isolated` | posix | The helper gets -I -S -B -X utf8 and its own path as arguments, the request on stdin (protocol, filename, source_base64) and an environment without the variables of the parent process. |
| `helper-source-has-no-execution-primitives` | static | The helper source imports only ast, base64, io, json, math, sys and tokenize and contains no call of exec, eval, compile, open, __import__, and no use of os, subprocess, importlib or socket; among the JavaScript modules only analyzer.mjs imports node:child_process and node:fs, and it uses only statSync, realpathSync and readFileSync of the file system module. |
| `helper-and-analyzer-agree-on-protocols` | static | The request and response constants of the helper equal the analyzer constants, and all three protocol strings end with /1. |
| `stable-scanners-do-not-import-the-layer` | static | No .mjs, .js, .cjs or .ts file under scanners/ outside this directory contains the text language/python; folders named node_modules are skipped. |
| `numeric-and-depth-rules` | python | An integer beyond plus or minus 2 to the power 53 minus 1 keeps its decimal text, an infinite float is float-special, a value is read down to its 13th nesting level and a node on the 14th level is unknown with reason depth-limit, and an operator other than BitOr is an unknown BinOp. |
| `nested-statements-are-dropped` | python | Functions, classes and imports inside control flow, nested functions, inner classes and assignments inside an if in a class body produce no fact; only assignments, augmented assignments and calls inside control flow are kept, as mutation facts. |
| `syntax-errors-carry-a-position` | python | A syntax error is a failed file with line, column, end_line and end_column; the two end fields are null when the interpreter reports no end position (before Python 3.10). An unknown or undecodable encoding is PYTHON_SOURCE_ENCODING_UNSUPPORTED. |
| `deeply-nested-parentheses-fail-the-file` | python | Source with 300 nested parentheses is a failed file, not facts. |
| `deep-attribute-chains-fail-the-helper` | python | A chain of 20000 attributes makes the helper exit with a traceback, which is returned as PYTHON_ANALYZER_FAILED. |
| `syntax-support-follows-the-interpreter` | python | A match statement is read when the interpreter is Python 3.10 or newer and is a PYTHON_SYNTAX_ERROR on older interpreters. |
| `module-ids-come-from-paths` | python | The module id table equals the resolver output: extension removed, dots for separators, hyphens kept, a trailing __init__ removed, no source roots; the package id is the directory of the file written with dots. |
| `colliding-modules-are-excluded` | python | A module and a package of the same id, or a module and its stub, produce a collision, no module entry, and locality ambiguous. |
| `failed-files-vanish-and-read-as-external` | python | A result that is not ok is not in the project; its module id reads as external, and a name imported from it resolves as a name of an external module, not as unknown. |
| `resolved-names-are-not-checked` | python | A dotted name under a resolved module or class is reported as resolved without checking that it exists. |
| `duplicate-names-last-definition-wins` | python | Two classes of one name in a module give one model, the later one; two imports of one alias resolve to the later import. An assignment, a function or a class whose name is also an import alias does not replace the import, in either order: the alias is looked up before the names the module declares (not modeled). |
| `unresolved-model-bases-are-omitted` | python | A class is left out of the models, without a diagnostic, when none of its bases establishes a recognized family. A base that does not resolve is ignored: next to a base that establishes a family the class stays a model. |
| `framework-names-are-matched-after-resolution` | python | An aliased import of APIRouter is recognized; a local class named APIRouter is not. |
| `fastapi-silent-cases` | python | The decorators options and api_route, and include_router on a receiver that is not a locally declared app or router, produce neither a fact nor a diagnostic. |
| `fastapi-parity-rule-and-keys` | python | The parity flag is true only when the difference count is zero and the shadow has no unknowns; differences are named by the keys of the identity table. |
| `mounts-are-recorded-not-composed` | python | An include_router call is listed in mounts and in unknowns with the reason include-router-mount-not-composed; its prefix is not added to the endpoint paths, which carry only the prefix of their own router. |
| `flask-register-blueprint-is-not-recorded` | python | A register_blueprint call with a url_prefix leaves the result of the Flask shadow unchanged: no mount is recorded, a blueprint route keeps the prefix of its own blueprint, and its limitations list says that mount overrides are not composed. |
| `flask-silent-cases` | python | add_url_rule, a bare route decorator and the options decorator produce neither a registration nor a diagnostic. |
| `django-include-without-urlpatterns-is-silent` | python | An include of a project module that has no urlpatterns is recorded as an include edge and produces no registration and no diagnostic. |
| `dynamic-values-are-reported-as-unknown` | python | A path, prefix, method list or URL pattern that is not a literal yields a diagnostic with a reason and no registration for that entry, and the literal registrations beside it are still reported (FastAPI, Flask and Django). |
| `derived-outputs-carry-no-version-or-id` | python | Project, model, type and shadow outputs carry no schema, protocol, version or id key. |

## Remaining limits

Each limit has one of the four limit statuses of the baseline library. UNSUPPORTED means the layer does not do it. UNKNOWN means the layer cannot tell and says so, or says nothing. BLOCKED means it waits on something named. NOT_RECORDED means it was not measured here. A limit is closed only by a named owner and a test that names its id; this document closes none of them. The last column names the claim that demonstrates the limit, or says that it is stated and not recomputed.

| Id | Status | Statement | Checked by |
| --- | --- | --- | --- |
| `module-ids-ignore-source-roots` | `UNSUPPORTED` | Module ids are the repository path with dots; a source root such as src is part of the id. | `module-ids-come-from-paths` |
| `failed-files-vanish-from-the-project` | `UNKNOWN` | A file that fails to analyze disappears from the project and reads as an external module; a name imported from it resolves as external instead of unknown. | `failed-files-vanish-and-read-as-external` |
| `resolved-names-are-not-checked` | `UNKNOWN` | A name under a resolved module is not checked for existence. | `resolved-names-are-not-checked` |
| `nested-statements-are-dropped` | `UNSUPPORTED` | Definitions and imports below the top level or inside control flow are not facts. | `nested-statements-are-dropped` |
| `shadow-silent-cases` | `UNSUPPORTED` | Some registrations are dropped without a diagnostic (listed in the FastAPI, Flask and Django claims). | `fastapi-silent-cases` |
| `unresolved-model-bases-are-omitted` | `UNKNOWN` | A class none of whose bases establishes a recognized family is absent from the models; an unresolved base next to a recognized one is ignored and the class stays a model. | `unresolved-model-bases-are-omitted` |
| `duplicate-names-last-definition-wins` | `UNKNOWN` | Two classes of one name and two imports of one alias keep only the last one. An assignment, a function or a class of an import alias name does not replace the import, in either order (not modeled). | `duplicate-names-last-definition-wins` |
| `deep-attribute-chains-fail-the-helper` | `UNKNOWN` | A very long attribute chain fails the helper; where exactly depends on the interpreter, the claim uses 20000. | `deep-attribute-chains-fail-the-helper` |
| `mounts-are-not-composed` | `UNSUPPORTED` | A reported FastAPI endpoint path is not the served URL: include_router prefixes are listed in mounts and are not added to endpoint paths. | `mounts-are-recorded-not-composed` |
| `flask-blueprint-mounts-are-not-recorded` | `UNSUPPORTED` | A Flask register_blueprint call is not recorded and its url_prefix is ignored: a reported blueprint route path is the path under the prefix of its own blueprint, not necessarily the served URL. | `flask-register-blueprint-is-not-recorded` |
| `syntax-support-follows-the-interpreter` | `UNKNOWN` | The syntax accepted is the syntax of the interpreter that runs the helper, so a file can be readable on one host and a syntax error on another. | `syntax-support-follows-the-interpreter` |
| `batch-order-is-locale-dependent` | `UNKNOWN` | The batch order uses localeCompare, so it can differ between host locales. | `batch-results-are-sorted-by-source-path` |
| `no-os-sandbox` | `UNSUPPORTED` | The helper runs with the privileges of the caller; isolation is the -I -S -B flags, an empty environment and the absence of execution primitives, not a sandbox. | `helper-source-has-no-execution-primitives` |
| `no-memory-bound` | `UNSUPPORTED` | The memory used by the interpreter is not bounded by the layer. | stated, not recomputed |
| `examples-are-small-fixtures` | `NOT_RECORDED` | The tables that the test recomputes come from small fixtures written in the test, not from real projects. Real projects are read by the corpus test of test/language-python/baseline-record.test.mjs, which fetches the pinned commits when BASELINE_CORPUS_FETCH is 1 and is skipped otherwise. | stated, not recomputed |
| `legacy-scan-shape-is-hand-fed` | `NOT_RECORDED` | The samples hand-feed the legacy scan shape; the real legacy scanner is compared in test/language-python/python-fastapi-shadow.test.mjs. | stated, not recomputed |
| `samples-run-on-the-available-interpreter` | `NOT_RECORDED` | The samples are recomputed on the interpreter that the test finds. The tables were checked to be identical on four local interpreters (versions 3.9, 3.11, 3.12 and 3.14); other versions and the CI interpreters are not recorded here. | stated, not recomputed |
| `consumer-list-is-not-exhaustive` | `NOT_RECORDED` | Only the listed consumers are checked; an unlisted importer in another track is not detected. | stated, not recomputed |
| `fake-interpreter-checks-are-posix-only` | `NOT_RECORDED` | Child-process checks use shell-script stand-ins and are not evaluated on win32. | stated, not recomputed |
| `windows-branches-are-not-run` | `NOT_RECORDED` | The Windows branches of the interpreter search (executable extensions from PATHEXT, SystemRoot and WINDIR in the child environment) are read from the source and have not been run. | stated, not recomputed |
| `computed-words-are-sampled-only` | `NOT_RECORDED` | A word that the code builds by concatenation, such as the urlpatterns reasons, is checked through the samples and not through the source text, so a new variant of it is found only when a sample reaches it. | stated, not recomputed |

`BASELINE.json` records limits of its own. This document does not repeat them. The table below only says where this document speaks of each one, and the test requires the ids and statuses to equal those of the file.

| Id in BASELINE.json | Status | In this document |
| --- | --- | --- |
| `runtime-registered-routes-are-not-seen` | `UNSUPPORTED` | `shadow-silent-cases` |
| `mounts-are-not-composed-across-modules` | `UNSUPPORTED` | `mounts-are-not-composed` |
| `dynamic-values-stay-unknown` | `UNKNOWN` | `dynamic-values-are-reported-as-unknown` |
| `model-facts-gaps` | `UNSUPPORTED` | not repeated here |
| `match-statement-depends-on-the-interpreter` | `UNKNOWN` | `syntax-support-follows-the-interpreter` |
| `helper-diagnostics-vary-with-the-interpreter` | `UNKNOWN` | `syntax-errors-carry-a-position` |
| `reserved-holdouts-not-run` | `BLOCKED` | not repeated here |
| `no-corpus-beyond-the-pinned-files` | `NOT_RECORDED` | `examples-are-small-fixtures` |
| `boundary-test-needs-the-npm-registry` | `NOT_RECORDED` | not repeated here |
| `ci-not-observed-at-base` | `NOT_RECORDED` | not repeated here |
| `hashes-generated-on-one-platform` | `NOT_RECORDED` | `samples-run-on-the-available-interpreter` |

## Promotion gates

No JavaScript or TypeScript file under `scanners/` outside this directory names this layer (claim `stable-scanners-do-not-import-the-layer`), and this document does not wire it. Files of other tracks that name the layer are listed under File ownership. Wiring needs the obligations below, in order. Each has a named owner and is open. An obligation counts as open while no other .mjs file of `test/language-python` contains its id; it is closed by a test that names its id.

| Id | Owner | State | Scope | Blocks |
| --- | --- | --- | --- | --- |
| `T06-03` | T06 | OPEN | Minimal next or shadow implementation that preserves the stable path. | Any wiring of this layer into the stable scanner path. |
| `T06-04` | T06 | OPEN | Negative, mutation, permission and cross-version tests. | A claim that unknown or partial results are covered beyond the samples of this document. |
| `T06-05` | T06 | OPEN | Consumers, runner, provider and packed-artifact integration. | Moving the consumers listed below onto a changed interface. |
| `T06-06` | T06 | OPEN | Promotion and rollback evidence. | Promotion of the new layer to the stable path. |

Until then:

- No stable scanner imports a file of this layer (claim `stable-scanners-do-not-import-the-layer`).
- A shadow result is not reported as supported output. Unknown, unsupported, blocked and not recorded are separate words, and none of them is a pass.
- The consumers listed under File ownership are not moved onto a changed interface before the obligation for consumers is closed.

## File ownership

T06 owns `scanners/language/python/**`, `test/language-python/**` and the plan folder `next/t06/**`. The table below lists the scopes of T06 and the files of other tracks that touch this layer. The owner of each path is what `next/t00/check-ownership.mjs` reports for it, and the test runs that gate on every path of the table. The test requires the gate to accept the T06 paths together (exit code 0) and to name another owner for each neighbour path (exit code 2). A path that no track owns, or that is reserved, goes to its coordinator.

| Scope | Owner | Role |
| --- | --- | --- |
| `scanners/language/python/**` | T06 | The layer: every file of the directory. |
| `test/language-python/**` | T06 | Tests of the layer, including this document test. |
| `next/t06/**` | T06 | Plan scope for new T06 work. |
| `adapters/http-wave-a/python-scope/static-runner.mjs` | T12 | Consumer: imports the analyzer, the resolver and the three shadows. |
| `adapters/http-wave-a/python-flask/SCOPE.json` | T12 | Consumer record: names flask-shadow.mjs as a source. |
| `adapters/http-wave-a/python-django/SCOPE.json` | T12 | Consumer record: names django-shadow.mjs as a source. |
| `test/http-wave-a/python-scope-records.test.mjs` | T12 | Consumer test: imports findPythonRuntime. |
| `adapters/http-legacy-next/python-fastapi/SCOPE.json` | T11 | Consumer record: names fastapi-shadow.mjs as a source. |
| `scanners/project-graph/INTERFACE_RFC.md` | T02 | Neighbour document that mentions the layer; checked for existence and ownership only. |
| `next/t00/ownership-map.json` | T00 | Records the scopes above. |
| `scanners/adapters/python-fastapi.mjs` | UNOWNED | Stable path: the legacy FastAPI scanner whose output the parity report reads. |
| `scanners/index.mjs` | UNOWNED | Stable path: scanner entry. |
| `scanners/registry.mjs` | UNOWNED | Stable path: scanner registry. |
| `scripts/run-next-nested-tests.mjs` | RESERVED | Reserved file: names the T06 source and test directories. |
| `.github/workflows/ci.yml` | RESERVED | Reserved file: CI job definitions. |
| `package.json` | RESERVED | Reserved file: packs scanners/ into the npm artifact. |

The files below import or name files of this layer. They are listed so that an interface of this layer is not changed without their owners. The list is not exhaustive (limit `consumer-list-is-not-exhaustive`).

| Path | Use | Layer files named |
| --- | --- | --- |
| `adapters/http-wave-a/python-scope/static-runner.mjs` | import | `analyzer.mjs`, `resolver.mjs`, `flask-shadow.mjs`, `fastapi-shadow.mjs`, `django-shadow.mjs` |
| `test/http-wave-a/python-scope-records.test.mjs` | import | `analyzer.mjs` |
| `adapters/http-wave-a/python-flask/SCOPE.json` | text | `flask-shadow.mjs` |
| `adapters/http-wave-a/python-django/SCOPE.json` | text | `django-shadow.mjs` |
| `adapters/http-legacy-next/python-fastapi/SCOPE.json` | text | `fastapi-shadow.mjs` |

## How this document stays true

The test `test/language-python/interface-rfc.test.mjs` and the vocabulary file `test/language-python/interface-rfc.vocabulary.json` hold this document to the code.

- Each table block of this document (a block that starts with a table bar or with a level-4 heading) is rendered from the vocabulary file by one function of the test and must equal its rendering, and a line that starts with a table bar must lie inside such a block. A table edited in the document alone fails. The descriptive columns (Role, Takes, Returns, Use, Meaning, What, When, Condition, Note, Strategy, Stable within, Breaks on, Statement and For, and Scope and Blocks of the obligations table) are written by hand in the vocabulary and are not recomputed: an edit that changes the vocabulary and the document together passes.
- The vocabulary is compared with the code: the directory listing, the export names and signatures, the protocol strings, the defaults and the options (read from the source text), the string literals that the sources write after a word property name, and, on the interpreter the test finds, the key sets of the object shapes, the word tables, the diagnostic keys, the expressions, the module ids, the collisions, the localities and the symbol resolutions.
- Identifier-like words in the text must occur in a source file, the helper, a fixture of the test or the baseline library. Cited repository paths must exist, and file names must be files of this layer or of its tests.
- Each claim is a check that runs the code on a sample or reads the sources. Each limit names a claim or is stated as not recomputed. Each obligation is open while no other .mjs file of `test/language-python` contains its id.
- Negative cases edit a copy of the vocabulary, of the text or of the code facts, and require a problem that names the check.

The prose is not parsed. A sentence is backed only through the claim it names, and the check does not read the sentence. Changing, deleting or adding a sentence is not reported unless the change alters a table block, the title, a level 2 heading, a cited claim or limit id, a cited path, a file name, an identifier-like word that no source contains, a hyphenated name in backticks that is no claim, limit, word or diagnostic, a banned text or the number of lines. Replacing a claim id by another existing id, or editing a descriptive column in the vocabulary and in the document together, is not reported either.
