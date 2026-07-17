# Changelog

## [0.2.0] - 2026-07-17

Beta. Brings the Node port to full parity with Python `dsviper-database-tools` 0.2.0 — the
engine and both migration loops are feature-complete and self-verifying.

- **Engine** (`DefinitionsRewriter`, renamed from `DefinitionsTransformer`; `Unrepresentable`,
  renamed from `DropRecord`) — the full type / directive surface: renames, shape changes, retypes
  (leaf, all container elements, `Vec`/`Mat` element + dimension, the `Vector` bridge, variant
  arm-sets), definition-level drops, namespace split / merge, and Class-C hooks (cross-field,
  cross-document single-reference, aggregate). Total-or-explicit-refusal throughout.
- **`migrateDatabase`** — now a silo module (`.migrate` / `.verify` / `.dryRun` / `.run`): one
  exclusive transaction, **copy-on-reference** blob streaming (no orphan sweep), a source
  snapshot, `onProgress`, and a self-`verify`; rolls back and discards a partial target on any
  failure. Adds `dryRun` (the *inform* preview), `plan` / `formatPlan` (the static *identify*
  report), and `DiagnosticSink` / `formatReport` (dynamic per-site loss).
- **`migrateCommitDatabase`** — the same surface, with an **opcode-level `verify`** (each opcode's
  rewrite + the DAG topology, not a re-materialised snapshot), a `dryRun`, and progress.
  `dropAttachment` is admissible; record-scoped loss (`drop-record`) is refused. The `--verify`
  CLI flag now covers it.
- **Layout & docs** — the engine kernel is now a sub-package (`src/rewrite/`); `ARCHITECTURE.md`
  retired, replaced by a [migration guide](MIGRATION_GUIDE.md) (user) and
  [REWRITE.md](REWRITE.md) (maintainer, code-linked).

Requires `@digitalsubstrate/dsviper >= 1.2.5`.

## [0.1.0] - 2026-07-13

First cut. A 1:1 Node port of the Python `dsviper-database-tools`, in pure Node over
the `@digitalsubstrate/dsviper` binding.

- `TransformationDirectives` — declarative edit script (renames, the two namespace axes,
  shape changes, and Class-B policies).
- `DefinitionsTransformer.fromDirectives` — the target-directed engine over both
  families. Full type coverage: all containers, the three key flavours, `XArray`, and
  the numeric leaf algebra (widen/narrow/saturate/parse across int32↔int64, i.e. bigint).
- `migrateDatabase` / `runMigration` — the read-old / write-new loop with streamed blob
  byte-copy and orphan mark-sweep; `runMigration(…, { verify: true })` self-checks.
- `verifyMigration` — the round-trip verifier.
- `migrateCommitDatabase` / `runCommitMigration` — faithful `CommitDatabase` replay:
  every commit re-issued in topological order (history preserved, merges included), the
  10 opcode verbs translated, intra-DAG `commit_id` remap, one atomic transaction.
- `bin/database_migrate.mjs` — root CLI, dispatching on the source type.

Drove two additive fixes in `@digitalsubstrate/dsviper` (found by exercising the
`encoded=false` typed-value path): `ValueXArray.items(encoded)` and `decodeVariant`
short-circuiting an already-wrapped `ValueVariant` in a deep decode.
