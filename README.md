# @digitalsubstrate/dsviper-database-tools

Definitions-directed **document rewriting** and **database migration** for
[Viper](https://www.npmjs.com/package/@digitalsubstrate/dsviper), in Node over the
`@digitalsubstrate/dsviper` binding — a 1:1 port of the Python `dsviper-database-tools`.

A Viper type's `runtimeId` is a content fingerprint of its *definition* that doubles as its storage
key, so a schema change re-ids and re-keys its data: there is no in-place `ALTER`, only a
**rebuild** — read `Base(A)` read-only, transform, write a fresh `Base(B)`. The old artefact stays
as rollback.

The engine underneath is more general than migration. `DefinitionsRewriter.value` is
`Value → Value` — it rewrites a document from a *source* schema to a *target* schema, indifferent to
where the value came from or where it goes. A `Database` / `CommitDatabase` migration is its
flagship application (what this tool ships); the same engine could transcode — a value decoded from
JSON, re-encoded as XML — because the whole transform lives in Viper's `Definition` / `Type` /
`Value` space. New here? Start with the **[migration guide](MIGRATION_GUIDE.md)** — the mental map.

This package gives you:

- **`TransformationDirectives`** — a *declarative* edit script (renames, shape changes, and the
  policies that govern lossy operations) — the model familiar from Django migrations, not a bespoke
  DSL.
- **`DefinitionsRewriter`** — one **target-directed** engine that builds the target `Definitions`
  from your directives and rewrites any value from the source domain to the target domain, spanning
  both families (renames *and* add / drop / reorder / retype).
- **`migrateDatabase.run` / `migrateDatabase.migrate`** — the read-old / write-new loop; pass
  `{ verify: true }` to have the tool prove its own result.
- **`migrateDatabase.dryRun`** — exercise the rewriter over every document with **no target, no blob
  copy, no transaction**: a one-pass preview of what a migration would do (documents kept, dropped,
  blobs referenced / stranded). The dividend of an I/O-free engine.
- **`plan` / `formatPlan`** — a **static plan report** from directives + schema alone (**no data**):
  every change classified lossless / policied / refused (with data-loss flags), and warnings for
  missing policies, `float→int`, and *possible forgotten renames*. Review a migration before running
  anything.
- **`migrateCommitDatabase.run` / `.migrate` / `.verify` / `.dryRun`** — the same surface for a
  **CommitDatabase**, rebuilt by faithful structural replay: every commit re-issued in topological
  order, history preserved (merges included). `verify` proves the rebuild *opcode by opcode* — a
  `CommitDatabase` stores mutations, so it is each opcode's rewrite that is checked (plus the DAG
  topology), not a re-materialised snapshot; `dryRun` is the same no-write preview at the opcode
  level.
- **`bin/database_migrate.mjs`** — a command-line tool for the whole decision loop: it loads a
  migration file and dispatches on the source (`Database` or `CommitDatabase`) — `--plan` (identify)
  and `--dry-run` (inform) are read-only pre-flight; `--verify` migrates and proves the result.

See the **[migration guide](MIGRATION_GUIDE.md)** for how to *think* about a migration, and
**[REWRITE.md](REWRITE.md)** for how the rewrite *works* and how to extend it — the target-directed
engine, the chain of proof, the invariants, and the code map.

## Install

The runtime `@digitalsubstrate/dsviper` is on npm; this tool is not (yet). Install the runtime,
clone this repo, and run the script from the repo — the same shape as `dsviper-tools`:

```bash
npm install "@digitalsubstrate/dsviper@>=1.2.5"
git clone <repo> dsviper-node-database-tools
cd dsviper-node-database-tools
node bin/database_migrate.mjs <migration> <source> <target>
```

(To use the engine as a library from elsewhere, `npm install` this directory to put
`@digitalsubstrate/dsviper-database-tools` on your path — it exports its API from `src/index.mjs`.)

## Write a migration

A migration is a Node file that exports `buildDirectives(sourceDefs)` — it receives the source's
live schema, so you build directives against real type/field names. The tool loads it and rewrites
the database.

```js
// migration_shop_v2.mjs
import dsviper from '@digitalsubstrate/dsviper';
import { TransformationDirectives } from '@digitalsubstrate/dsviper-database-tools';

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

Run it — the decision loop is on the command line (*identify → inform → decide*):

```bash
node bin/database_migrate.mjs migration_shop_v2.mjs old.db          --plan      # identify: the static plan, no write
node bin/database_migrate.mjs migration_shop_v2.mjs old.db          --dry-run   # inform:   real loss on real data, no write
node bin/database_migrate.mjs migration_shop_v2.mjs old.db new.db   --verify    # decide:   migrate, then prove it faithful
```

`old.db` is opened read-only and left intact; `new.db` is the rebuilt database. `--plan`
(schema-only, what *could* change) and `--dry-run` (which policies bite, what would drop, on the
real data) are **read-only pre-flight** — they print and exit, so the target is omitted. `--verify`
proves the target is a faithful image (both a `Database` and a `CommitDatabase`), `--force`
overwrites an existing target, `-v` prints the migration summary. For a lossless migration, skip
straight to the run; walk the earlier steps when it can lose data.

## The directive surface

`TransformationDirectives` is the complete, declarative edit script. Every directive names its
target by **qualified name** (`representation()`, e.g. `"Shop::Order"`); fields and cases are plain
names. Renames and retypes name the field/case by its **source** name — the schema you are migrating
*from* — even when you also rename it.

Each operation is **Class A** (lossless — automatic), **Class B** (lossy — refused until you name a
policy), or **Class C** (a hook you write). The **[migration guide](MIGRATION_GUIDE.md)** explains
the loss model and when to reach for each; this section is the exact reference.

**Renames** — the name *is* the identity, so a rename is a re-id (references follow):

| Directive | Effect |
|---|---|
| `renameType(old, new)` | rename a struct / enum / concept / club (FQN → FQN) |
| `renameField(struct, old, new)` | rename a struct field |
| `renameCase(enum, old, new)` | rename an enum case |
| `renameAttachment(oldId, newId)` | rename an attachment (its local name) |

**Namespaces** — two orthogonal axes, plus per-definition moves for split / merge:

| Directive | Effect |
|---|---|
| `renameNamespace(oldNs, newName)` | change a namespace's display **name** — new representations, unchanged `runtimeId`s |
| `remapNamespace(oldNs, newUuid)` | change a namespace's identity **UUID** — new `runtimeId`s, unchanged representations |
| `moveType(typeRepr, targetNs)` | move one struct / enum / concept / club to another namespace (split / merge) — Class A |
| `moveAttachment(identifier, targetNs)` | move one attachment to another namespace |

**Struct field shape:**

| Directive | Effect | Class |
|---|---|---|
| `addField(struct, name, default)` | add a field seeded with `default` (a primitive-leaf `Value`) | A |
| `addField(struct, name, type, derive)` | add a field **derived** from the struct — `derive(sourceStruct, fieldName, targetType)` | C |
| `dropField(struct, name)` | remove a field | A |
| `reorderFields(struct, order)` | set the target field order (a permutation of the field names) | A |
| `retypeField(struct, name, newType, policy?)` | change a field's type (leaf, `Set`/`Vector`/`Map`/`XArray`/`Optional`/`Tuple` element, `Vec`/`Mat` element, variant arm-set, the `Vec`↔`Vector` bridge); `policy` required when lossy | A / B |

**`Vec` / `Mat` dimension** (named explicitly — never inferred from a target shape):

| Directive | Effect | Class |
|---|---|---|
| `resizeVecField(struct, field, size, { fill = 'zero', onShrink = 'fail' })` | grow (fill new cells) or shrink a `Vec` field | A / B |
| `resizeMatField(struct, field, columns, rows, { fill = 'identity', onShrink = 'fail' })` | grow or shrink a `Mat` field | A / B |
| `transposeMatField(struct, field)` | `Mat<c,r> → Mat<r,c>`, `[i,j] → [j,i]` | A |

**Enum shape:**

| Directive | Effect | Class |
|---|---|---|
| `addCase(enum, name)` | add a case (appended at the end) | A |
| `reorderCases(enum, order)` | set the target case order (a permutation of the case names) | A |
| `removeCase(enum, case, policy)` | remove a case; `policy` governs values still holding it | B |

**Definition-level drops** — remove a whole definition (the co-direction of the build):

| Directive | Effect |
|---|---|
| `dropType(typeRepr)` | remove a struct / enum / concept / club (refused if a surviving definition still references it, with an accumulated report) |
| `dropAttachment(identifier)` | remove an attachment **and delete its documents** — requires `acceptAttachmentDrops()` |

**Custom hooks (Class C)** — for a change no declarative directive expresses (a field retyped to an
*unrelated* type, a value derived from siblings or from another document). The hook owns its loss
model; the engine validates its output against the target type:

| Directive | Effect |
|---|---|
| `transformField(struct, field, newType, fn)` | replace one field via `fn(sourceStruct, fieldName, targetType)` — sees its siblings (cross-field), and via a `ctx` argument can dereference into `Base(A)` (cross-document) |
| `transformType(sourceType, newType, fn)` | replace **every** occurrence of a type via `fn(value, targetType)` — rides the recursion into nested positions |

**Documentation** (Class A — carried by default, these override; `''` clears):

| Directive | Effect |
|---|---|
| `documentType(typeRepr, text)` | set a struct / enum / concept / club docstring |
| `documentField(struct, field, text)` | set a field docstring |
| `documentCase(enum, case, text)` | set an enum-case docstring |
| `documentAttachment(identifier, text)` | set an attachment docstring |

**Policies & acknowledgements:**

| Directive | Effect |
|---|---|
| `resolveCollisions(winner)` | how a `Map`-key / `Set`-element collision resolves — `'fail'` / `'first'` / `'last'` |
| `acceptDocumentDrops()` | sign off that a `drop-record` policy may **delete whole documents** |
| `acceptAttachmentDrops()` | sign off that `dropAttachment` may **delete whole attachments** |

**Class-B policy vocabulary, by operation** — the exact policy each lossy operation accepts (it
converts in-range / parseable / non-nil values exactly, and applies the policy only to the
offenders; the *why* is the guide's §3):

- numeric narrowing (incl. `Set`/`Vector`/`Map`/`XArray`/`Optional`/`Tuple` and `Vec`/`Mat` element) → `'fail'` (default) / `'saturate'` / `['default', value]`
- parse `string→X` → `'fail'` / `['default', value]` / `'drop-record'`
- `Optional<A>→A` on nil → `'fail'` / `['default', value]` / `'drop-record'`
- remove a populated enum case / variant arm → `'fail'` / `['map-case', name]` / `'drop-record'`
- `Vector→Vec` length-fit → `'fail'` / `['fit', pad]` / `'drop-record'`
- `Vector→Set` collapse, `Map` key collision → `resolveCollisions(winner)`

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

`migrateDatabase.migrate` transforms every document and streams each referenced blob to the target
as it is first needed (copy-on-reference — exactly the referenced blobs, never an orphan), in one
exclusive transaction that rolls back on any failure. Pass `{ verify: true }` to
`migrateDatabase.run` (or call `migrateDatabase.verify`) to have the tool prove the target is a
faithful image. Pass an `onProgress` callback (to `.migrate` or `.run`) that receives a progress
object — bytes copied against the source's total blob bytes, documents, and attachment position —
for a progress bar over the dominant cost (blob I/O).

`migrateCommitDatabase` mirrors this surface for a `CommitDatabase` — same `migrate` / `verify` /
`dryRun` / `run`, an `onProgress` callback receiving a progress object (bytes + commit position),
and the same rollback-on-failure. It replays the commit DAG instead of copying documents; see the
[migration guide §5](MIGRATION_GUIDE.md) for what that changes.

## Status

Beta — feature-complete and self-verifying, at parity with Python `dsviper-database-tools`, but not
yet published, API-frozen, or battle-tested by an outside user. The rewrite engine covers the full
type / directive surface — all containers, `Vec`/`Mat` (element conversion, resize, transpose, the
`Vector` bridge), `XArray`, the three key flavours, variant arm-sets, definition-level drops,
namespace split / merge, and Class-C hooks (cross-field, cross-document single-reference, and
aggregate). The `Database` loop copies exactly the referenced blob bytes (copy-on-reference — never
an orphan) and verifies its own result; the `CommitDatabase` loop replays the whole commit DAG
faithfully (history preserved, merges included) over the 10 opcode verbs, in one atomic transaction
that rolls back on failure, and verifies itself *opcode by opcode* plus the DAG topology. The port
also drove additive binding fixes, found by exercising the `encoded=false` typed-value path.

Requires `@digitalsubstrate/dsviper` >= 1.2.5.
