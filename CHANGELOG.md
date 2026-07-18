# Changelog

## [0.2.2] - 2026-07-18

Parity with Python 0.2.2 — two fixes surfaced by the engine ↔ `REWRITE.md` review.

- **`plan` was out of sync with the engine.** A same-kind element retype
  (`Set`/`Vector`/`Map`/`XArray`/`Optional`/`Tuple` `<A>→<B>`) was classified `B (review)` and
  warned "missing policy" even for a lossless **widening** — the engine treats it as Class A.
  `plan` now calls `containerElementRetypeClass`, so the *identify* surface matches the engine.
- **The CLI now exposes the whole decision loop.** `bin/database_migrate.mjs` gained `--plan`
  (identify) and `--dry-run` (inform) — both read-only, print-and-exit; the target is optional
  when either is used. Previously only `--verify` (decide) was reachable from the command line.

## [0.2.1] - 2026-07-18

Bugfix (parity with Python 0.2.1). A field `retypeField` between two **composite** types the engine
holds crashed in the scalar-narrowing tail (and a lossless widening of one was wrongly refused).

- `Optional<A> → Optional<B>` and `Tuple<...> → Tuple<...>` now join the same-kind **element
  retype** family — widen (Class A, automatic) / narrow (Class B, policied), nil- and
  position-preserving, nested-aware — the twin of the `Set`/`Vector`/`Map`/`XArray` element retype.
- `_retype` gained a fail-closed **composite guard**: any composite retype with no conversion branch
  (`struct↔struct`, `enum↔enum`, `key↔key`, …) is now a clean `[unsupported]` refusal, never a
  crash — use a Class-C hook.
- `REWRITE.md` updated to match.

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
