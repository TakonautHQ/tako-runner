# Third-party notices

## Bundled in this package

| Component | Version | License | Files |
| --- | --- | --- | --- |
| tree-sitter-typescript | 0.23.2 | MIT | `grammars/typescript/*` (grammar WebAssembly and `tags.scm`) |
| tree-sitter-javascript | 0.23.1 | MIT | `grammars/javascript/*` |
| tree-sitter-python | 0.23.6 | MIT | `grammars/python/*` |

Each grammar's license text is in its `grammars/<language>/LICENSE`. The files
are byte-for-byte copies from the npm packages above; `src/structure-index.ts`
pins their SHA-256 hashes and refuses any other bytes.

## Dependencies

`web-tree-sitter` 0.27.0 (MIT) is an exact-pinned npm dependency.

## Design credit

The structure indexer's approach (WebAssembly tree-sitter grammars driven by
tags queries) follows the generic extractor of Graft, `@nanonets/graft`
(Copyright (c) 2026 Context Graph Engine contributors, MIT). No Graft source
code is included.
