# Changelog

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
