# Shared Project context builds

A Runner can build a structure index of a repository. Takonaut gives this
index to the Agents of the Project's members. Source text stays on the
Runner machine.

## Turn it on

1. In Takonaut, open **Project Settings → Shared context**.
2. Turn on indexing, set the path allowlist and accept the processing policy.
3. Grant this Runner.
4. Bind the repository on the machine one time:
   `tako-runner map <project-id> <path> --repository-id <id>`.
   `setup` does this for the repository that it finds. A mapping with only a
   Project is not sufficient.

Takonaut shows the status of each build in the Shared context settings.

## What a build does

The daemon builds an index of the default branch each time Takonaut sees a
new head.

- **Reads.** It reads only TypeScript, JavaScript and Python files that match
  the allowlist. It reads them from the Git objects of that exact commit, not
  from your working tree. It skips paths that look like secrets, files that
  are not UTF-8 and files that are too large. The limit is 5,000 files of up
  to 512 KiB each.
- **Extracts.** It extracts files, symbols, their relations and hashes. It
  works offline with bundled WebAssembly grammars. It uses no AI model and no
  network. It does not install or run code from the repository.
- **Uploads.** It uploads only that structure, at most 64 MiB, gzip
  compressed.

## When the daemon builds

- The daemon claims a build only when it has no analysis work. A build can
  delay queued analysis by up to 15 minutes.
- When the server has builds turned off, the daemon checks again every 10
  minutes.
- At start, the daemon removes build folders older than 30 minutes that a
  stopped daemon left in `<config dir>/runner-graph`.
  `diagnostic-bundle` shows how many there are, but not their names.

The server checks the artifact, publishes it and gives it to the Agents of
Project members. When an administrator turns off consent, the server stops
giving it at once and removes it within one hour.

## Claim API

`RunnerApiClient.claimGraphBuild()` claims one build with
`POST /api/runner/v2/graph/claim`.

- It needs the server feature `shared_project_context`, administrator
  consent for the repository and a graph grant for this Runner. A reported
  capability is not sufficient.
- The frozen `RunnerGraphClaim` contains the exact commit, the path
  allowlist, the consent revision and the extractor identity of the build.
  It contains no prompt, Profile or tools.
- `heartbeatGraphBuild` and `failGraphBuild` send the claim's
  `X-Runner-Attempt-Id`.
- Failure codes come from a fixed list (`RunnerGraphFailureCode`).

A 409 response means that you must stop the work. It has one of these
causes:

| Code | Cause |
|---|---|
| `lease_lost` | The lease is gone. |
| `admission_lost` | This Runner lost admission. The build goes back to the queue. |
| `consent_changed` | The consent changed. |

A missing or incorrect attempt header also gives a 409 with the message
"Runner attempt is no longer active".

## Staging sources

`stageGraphSources` (`src/graph-sources.ts`) prepares the input for the
indexer.

- It reads the blobs of the claimed commit from Git objects into a new
  private staging folder (mode `0700`).
- It does not check out a worktree. Repository hooks, `core.fsmonitor`,
  smudge filters and attributes do not run.
- It stages only regular UTF-8 text files that match the allowlist.
- It skips some files and records a reason for each file. It skips
  symlinks, submodules, binary files, files that are not UTF-8 and files that
  are too large. It also skips names that are the same as a different name on
  a file system that ignores case or Unicode form.
- It counts sensitive, unsafe or non-UTF-8 paths, but does not record their
  names.
- File count, file size and total size have limits. Each Git command has a
  time limit.
- If the commit is missing, it fetches the default branch one time. It does
  not fetch submodules, write `FETCH_HEAD` or start background maintenance.
- Git's terminal prompt is off. SSH or askpass prompts from the machine's own
  Git configuration can still appear.

Allowlist patterns:

- `**` matches whole path segments.
- `*` and `?` match within one segment.
- All other characters match literally.
- A pattern without wildcards matches that path and all paths below it.

These paths are unsafe:

- a path longer than 1,024 bytes
- a path with more than 64 levels
- a path with a segment longer than 255 bytes

The stager counts unsafe paths and does not examine them.
This also limits the cost of matching. Matching uses no regular expressions.

Read staged files by their manifest path. Do not walk the folder.

## Structure indexer

`createStructureIndexer` (`src/structure-index.ts`) is the Runner's offline
structure indexer (`tako-structure/1`).

- It uses WebAssembly tree-sitter grammars for TypeScript, TSX, JavaScript
  and Python. The grammars are in `grammars/`. The indexer refuses a grammar
  if its SHA-256 is not the pinned value.
- For one file, it returns definitions (kind, name, lines and UTF-8 byte
  offsets) and references. It reports parse errors.
- A file over 512 KiB fails as `oversize`.
- A parse or query that takes more than 5 seconds fails as `timeout`. The
  next file is not affected.
- Use one indexer for each process. `dispose()` releases parsers and
  queries, but the grammar modules stay loaded.
- Offsets refer to the UTF-8 encoding of the string that you give. To make
  offsets match the file's bytes, decode files with `fatal: true` and
  `ignoreBOM: true`.

The indexer covers:

- functions, classes, methods, interfaces, TypeScript type aliases, enums and
  namespaces
- calls and constructions (`new X` or `new ns.X`)
- simple type annotations
- ES imports and re-exports, CommonJS `require("x")`, dynamic `import("x")`
  and `import x = require("x")`
- all Python import forms

The indexer does not cover these yet. A missing link does not prove that
there is no relation.

- generic, qualified and heritage type references
- `declare module "m"`
- dotted namespaces (`namespace A.B {}`)
- arrow methods in class fields and `#private` methods
- anonymous default exports
- computed `require` or `import`
- `export import x = require()`, which is a grammar error in
  tree-sitter-typescript 0.23.2

Other known behavior:

- A local function named `require` is recorded as an import. There is no
  scope analysis.
- Decorators are outside definition spans.
- Getters, setters and overloads repeat a name in a file.

For grammar licenses and design credit, see
[THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).

## Structure artifact

`buildStructureArtifact` (`src/structure-artifact.ts`) makes one commit's
artifact (`takonaut-structure-artifact/v1`) from the staged sources. The
artifact is canonical JSON with its SHA-256.

| Field | Contents |
|---|---|
| `files` | Each staged file in a supported language: path, size and hash. |
| `symbols` | See [Symbols](#symbols). |
| `edges` | See [Edges](#edges). |
| `unresolved` | See [Unresolved references](#unresolved-references). |
| `coverage` | See [Coverage](#coverage). |
| `withheld` | Counts of sensitive and unsafe paths from staging. Never names. |

### Symbols

Each symbol has:

- the position of its file
- a qualified name, for example `Greeter.greet`
- a stable ID. The ID contains the path, the kind, the qualified name and an
  ordinal. The ordinal separates true repeats, for example getter and setter
  pairs, overloads, or functions in anonymous callbacks.
- lines and UTF-8 byte offsets
- a hash of the definition's bytes. `export` and decorators are outside the
  hash. Constants have no hash, because a person could find a short value,
  for example a password, by guessing.

### Edges

An edge is `[kind, source, target, resolution]`. Source and target are node
positions: files first, then symbols.

Kinds:

- `contains`
- `imports`: relative JS and TS paths, Python relative imports, and Python
  absolute imports from the nearest package root. As in Python 3, absolute
  imports resolve only from folders that are not packages.
- `calls`
- `constructs`: `new X()` or a call to a class
- `references_type`

Resolutions:

| Resolution | Meaning |
|---|---|
| `same_file` | The only candidate in the file. |
| `same_class` | `this.f()` or `self.f()` to the only method `f` of the enclosing class. |
| `unique_name` | The only candidate in the snapshot, in the same language family. Local variables could still shadow this name-only match. |

### Unresolved references

An unresolved reference is `[kind, source, name, reason]`. References with
names longer than 256 bytes are skipped.

| Reason | Meaning |
|---|---|
| `not_found` | No candidate. |
| `ambiguous` | More than one candidate. |
| `non_relative` | An import that matches no staged file. |
| `receiver_unknown` | `x.f()` for any other receiver, or `this` in a nested function that is not an arrow function. |
| `shadowed` | A parameter, a type parameter or another definition in the same file binds the name. This includes destructured, rest and splat parameters. A callback parameter outside all definitions shadows the name in the whole file. |

- Import names are kept only when they look like package names. Paths and
  URLs are `null`.
- Bare package imports (`react`) and tsconfig path aliases are `external`.
- `from pkg import name` links only to `pkg`.
- A missing edge does not prove that there is no relation.

### Coverage

Each file has one of these values. One bad file never makes the snapshot
fail.

| Value | Meaning |
|---|---|
| `indexed` | Fully indexed. |
| `partial` | Parse errors, or more than a nesting depth of 32, 5,000 symbols or 20,000 references. |
| `skipped` | The file has an unsupported language or is too large. Or the stager skipped it, or the budget is used up. Or the snapshot is over its limits: 100,000 symbols, 600,000 references or about 48 MiB of symbols and references. |
| `error` | Timeout. |

### Limits

- The builder checks staged files again against the manifest.
- The whole snapshot has a time budget (120 seconds by default) and a size
  limit of 64 MiB.
- Local paths never appear in the artifact.

## Running a claimed build

`processGraphClaim` (`src/graph-build.ts`) runs one claimed build.

1. It keeps the lease with the same watchdog as analysis.
2. It refuses a claim for a different extractor, schema version or extractor
   configuration (`extractor_unavailable`) before a worker starts.
3. It runs the hidden `__graph-worker` command in its own process group,
   without the Runner credential. The worker stages the commit and builds the
   artifact with one indexer in a private work folder.
4. The parent reads the artifact. It does not follow links or block on
   special files. It checks the size and hash again.
5. `uploadGraphArtifact` sends exactly those bytes, gzip compressed, to
   `PUT /api/runner/v2/graph/builds/{build_id}/artifact`. The server stages
   the artifact, then checks and publishes it in the background.

- A whole build has a 15-minute deadline.
- Failures are reported as codes without content.
- After lease loss or shutdown, the Runner reports nothing. The lease
  expires, and another Runner can claim the build again.
- If the Runner cannot make sure that the worker stopped, it keeps the work
  folder and the daemon stops, as for analysis.
