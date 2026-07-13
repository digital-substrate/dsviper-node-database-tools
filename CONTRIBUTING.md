# Contributing

`@digitalsubstrate/dsviper-database-tools` is a pure-Node layer over the
`@digitalsubstrate/dsviper` binding. No compiled build.

## Develop

```bash
npm install                # pulls in @digitalsubstrate/dsviper
npm test                   # node --test over test/
```

## Scope

The package is a *composition of runtime atoms* — it consumes the public `dsviper`
API and adds no C++. Keep it that way: if something seems to need a binding change,
that belongs in the runtime/binding, not here.

- **Engine** (`src/rewrite.mjs`) — the target-directed `value()` and the
  `buildTargetDefinitions` pass. No I/O.
- **Migration** (`src/migrate.mjs`) — the `Database` read-old / write-new loop.
- **Commit migration** (`src/commit_migrate.mjs`) — the `CommitDatabase` faithful
  DAG replay.
- **Directives** (`src/directives.mjs`) — pure data; the declarative edit script.
- **Verify** (`src/verify.mjs`) — the round-trip self-check.
- **Tool** (`bin/database_migrate.mjs`) — the command-line entry point; loads a
  migration file and calls `runMigration` / `runCommitMigration`, dispatching on the
  source.

## No silent loss

Every lossy operation must be explicitly opted into with a policy, and refused
otherwise *before* any data is touched. New Class-B operations follow the same rule:
default to `'fail'`, consult the policy only on the offending value.

## Tests gate the release

`test/` (`node --test`) runs against the package and gates release. Add tests for any
new operation.
