# Contributing

1. Open an issue describing the defect or narrowly scoped change.
2. Add or update the smallest test that demonstrates the behavior.
3. Run `bun run test`, `bun run typecheck`, and `bun run pack:check`.
4. Do not weaken exact-SHA checkout, organization/Project scoping,
   sensitive-path filtering, symlink rejection, or credential-file checks.

Runtime dependencies require explicit justification. Keep the Pi runtime suite
pinned to one compatible version.
