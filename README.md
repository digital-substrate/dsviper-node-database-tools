# @digitalsubstrate/dsviper-database-tools

Definitions-directed **document rewriting** and **database migration** for
[Viper](https://www.npmjs.com/package/@digitalsubstrate/dsviper), in Node over the
`@digitalsubstrate/dsviper` binding — a 1:1 port of the Python `dsviper-database-tools`.

A Viper type's `runtimeId` is a content fingerprint of its *definition* that doubles as
its storage key, so a schema change re-ids and re-keys its data: there is no in-place
`ALTER`, only a **rebuild** — read `Base(A)` read-only, transform, write a fresh
`Base(B)`. The old artefact stays as rollback.

This package gives you:

- **`TransformationDirectives`** — a *declarative* edit script (renames, shape changes,
  and the policies that govern lossy operations) — the model familiar from Django
  migrations, not a bespoke DSL.
- **`DefinitionsRewriter`** — one **target-directed** engine that builds the target
  `Definitions` from your directives and rewrites any value from the source domain to
  the target, spanning both families (renames *and* add / drop / reorder / retype /
  move / hook).
- **`migrateDatabase`** — the silo-2 module (`.migrate` / `.verify` / `.dryRun` / `.run`):
  the read-old / write-new loop with **copy-on-reference** blob streaming; pass
  `{ verify: true }` to `.run` to have the tool prove its own result.
- **`migrateCommitDatabase`** — the same surface for a `CommitDatabase`, rebuilt by
  faithful structural replay: every commit re-issued in topological order, history
  preserved (merges included). `.verify` proves the rebuild *opcode by opcode* plus the
  DAG topology, not a re-materialised snapshot.
- **`plan` / `formatPlan`** and **`DiagnosticSink` / `formatReport`** — static (schema-only)
  and dynamic (real per-site loss) pre-flight reports.
- **`bin/database_migrate.mjs`** — a command-line tool that loads a migration file,
  opens the source read-only, and writes a fresh target — dispatching on the source
  (`Database` or `CommitDatabase`).

See the **[migration guide](MIGRATION_GUIDE.md)** for how to *think* about a migration, and
**[REWRITE.md](REWRITE.md)** for how the rewrite *works* and how to extend it (code-linked).

## Install

The runtime `@digitalsubstrate/dsviper` is on npm; this tool is not (yet). Install the
runtime, clone this repo, and run the script from the repo — the same shape as
`dsviper-tools`:

```bash
npm install "@digitalsubstrate/dsviper@>=1.2.5"
git clone <repo> dsviper-node-database-tools
cd dsviper-node-database-tools
node bin/database_migrate.mjs <migration> <source> <target>
```

(To use the engine as a library from elsewhere, the package exports its API from
`src/index.mjs`; `npm install` this directory to put `@digitalsubstrate/dsviper-database-tools`
on your path.)

## Write a migration

A migration is a Node file that exports `buildDirectives(sourceDefs)` — it receives the
source's live schema, so you build directives against real type/field names. The tool
loads it and rewrites the database.

```js
// migration_shop_v2.mjs
import { TransformationDirectives } from '@digitalsubstrate/dsviper-database-tools';
import dsviper from '@digitalsubstrate/dsviper';

const { Type, ValueString } = dsviper;

export function buildDirectives(sourceDefs) {
    const d = new TransformationDirectives();
    d.renameField('Shop::Customer', 'fullname', 'full_name');
    d.addField('Shop::Customer', 'email', new ValueString(''));        // seeded default
    d.dropField('Shop::Customer', 'legacyId');
    d.retypeField('Shop::Order', 'amountCents', Type.INT64);           // widening — automatic
    d.retypeField('Shop::Order', 'quantity', Type.INT16, 'saturate');  // lossy — policy
    return d;
}
```

Run it:

```bash
node bin/database_migrate.mjs migration_shop_v2.mjs old.db new.db --verify
```

`old.db` is opened read-only and left intact; `new.db` is the rebuilt database.
`--verify` proves the target is a faithful image (both a `Database` and a `CommitDatabase`),
`--force` overwrites an existing target, `-v` prints the migration summary.

## The directive surface

`TransformationDirectives` is the complete, declarative edit script. Every directive
names its target by **qualified name** (`representation()`, e.g. `"Shop::Order"`);
fields and cases are plain names. Renames and retypes name the field/case by its
**source** name — the schema you are migrating *from* — even when you also rename it.

| Directive | Effect | Family · class |
|---|---|---|
| `renameNamespace(oldNs, newName)` | change a namespace's display **name** — new `Namespace::Type` representations, unchanged `runtimeId`s | rename |
| `remapNamespace(oldNs, newUuid)` | change a namespace's identity **UUID** — new `runtimeId`s, unchanged representations | re-home |
| `renameType(old, new)` | rename a concept / club / enum / struct (FQN → FQN) | rename |
| `renameField(struct, old, new)` | rename a struct field | rename |
| `addField(struct, name, default)` | add a field, seeded with `default` (a primitive-leaf `Value`) | shape · A |
| `dropField(struct, name)` | remove a field | shape · A |
| `reorderFields(struct, order)` | set the target field order (a permutation of the field names) | shape · A |
| `retypeField(struct, name, newType, policy?)` | change a field's leaf type; `policy` required when lossy | shape · A/B |
| `renameCase(enum, old, new)` | rename an enum case | rename |
| `addCase(enum, name)` | add a case (appended at the end) | shape · A |
| `reorderCases(enum, order)` | set the target case order (a permutation of the case names) | shape · A |
| `removeCase(enum, case, policy)` | remove a case; `policy` governs values still holding it | shape · B |
| `renameAttachment(oldId, newId)` | rename an attachment (its local name) | rename |
| `resolveCollisions(winner)` | how a `Map`-key / `Set`-element collision resolves (global) | policy |

**Class A** operations (widen, add-with-default, drop, reorder, add-case) are total and
apply automatically. **Class B** operations can lose information and carry a policy
(below). **Class C** is a custom hook you write (`transformField` / `transformType` /
`addField(..., derive)`) — for a change no declarative directive expresses (a field split
or merge, a value derived from siblings or another document). This table is the common
surface; the full vocabulary (definition-level drops, namespace `moveType` / `moveAttachment`,
`Vec`/`Mat` resize / transpose, `document*`, hooks) is covered by the
[migration guide](MIGRATION_GUIDE.md).

**Policies (no silent loss).** Every lossy operation is refused by default and must
carry an explicit policy — checked *before* any data is touched:

- numeric narrowing → `'fail'` (default) / `'saturate'` / `['default', value]`
- parse `string→X` → `'fail'` / `['default', value]` / `'drop-record'`
- `Optional<A>→A` on nil → `'fail'` / `['default', value]` / `'drop-record'`
- remove a populated enum case → `'fail'` / `['map-case', name]` / `'drop-record'`
- `Map` key collision winner → `resolveCollisions('fail' | 'first' | 'last')`

An in-range / parseable / non-nil value always converts exactly; a policy governs
only the offenders. A `'drop-record'` policy makes the migration loop skip that
document.

## Programmatic use

```js
import dsviper from '@digitalsubstrate/dsviper';
import { DefinitionsRewriter, migrateDatabase } from '@digitalsubstrate/dsviper-database-tools';

const { Database } = dsviper;

const source = Database.open('old.db', true);   // read-only
const directives = buildDirectives(source.definitions());
const [rewriter, targetDefs] =
    DefinitionsRewriter.fromDirectives(source.definitions(), directives);

const target = Database.create('new.db');
target.extendDefinitions(targetDefs.const());
migrateDatabase.migrate(source, rewriter, target);   // owns its own exclusive transaction
```

`migrateDatabase.migrate` transforms every document and streams each referenced blob to
the target as it is first needed (copy-on-reference — exactly the referenced blobs, never
an orphan), in one exclusive transaction that rolls back on any failure. Call
`migrateDatabase.verify` (or pass `{ verify: true }` to `.run`) to have the tool prove the
target is a faithful image. `migrateCommitDatabase` mirrors this surface for a
`CommitDatabase`.

## Status

Beta — feature-complete and self-verifying, at parity with Python `dsviper-database-tools`
0.2.0. The rewrite engine covers the full type / directive surface — all containers,
`Vec`/`Mat` (element conversion, resize, transpose, the `Vector` bridge), `XArray`, the
three key flavours, variant arm-sets, definition-level drops, namespace split / merge, and
Class-C hooks (cross-field, cross-document single-reference, aggregate). The `Database` loop
copies exactly the referenced blob bytes (copy-on-reference) and verifies its own result;
the `CommitDatabase` loop replays the whole commit DAG faithfully (history preserved, merges
included) over the 10 opcode verbs, in one atomic transaction that rolls back on failure, and
verifies itself *opcode by opcode* plus the DAG topology. The port also drove additive binding
fixes, found by exercising the `encoded=false` typed-value path. Validated by the test suite
(`npm test`).

Requires `@digitalsubstrate/dsviper` >= 1.2.5.
