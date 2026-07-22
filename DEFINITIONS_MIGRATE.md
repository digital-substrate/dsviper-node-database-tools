# DEFINITIONS_MIGRATE.md — the DSM-source codemod, for maintainers

The developer/maintainer companion to `src/definitions_migrate.mjs`, the **source twin** of the
data migration. `migrate_database.mjs` migrates the data in a base; this tool migrates the
hand-authored `.dsm` files that declare that schema — under the *same* transformation module. For
the engine that both rest on, read [REWRITE.md](REWRITE.md); to *use* the tools, the
[migration guide](MIGRATION_GUIDE.md); for the scope map and the "why not re-render?" answer in
user terms, [SUPPORT.md](SUPPORT.md). (A Node adaptation of the Python package's
`DEFINITIONS_MIGRATE.md`; the design is language-agnostic — only the file/symbol names differ.)

> 1 · The principle · 2 · Module map · 3 · The chain of proof · 4 · Invariants · 5 · The edit
> algebra · 6 · The directives, family by family · 7 · Extension points · 8 · The Viper boundary ·
> Appendix — a worked trace.

---

## 1 · The principle — patch, don't render

A schema change produces two artefacts to migrate, not one: the *data*, and the *source that
declares it*. The obvious way to migrate the second is to build the target `Definitions` with the
engine and render it back to DSM. That is exactly what this tool does **not** do, and the refusal
is the whole design.

Rendering is lossy in a dimension the engine does not model. A hand-authored tree carries a **file
split**, **comments**, **member ordering**, blank lines, alignment, a house style — none of which
lives in `Definitions`. Round-tripping through the engine would silently flatten all of it: the
migration would be correct and the diff unreadable, which for a hand-maintained artefact is a
failure. ([SUPPORT.md](SUPPORT.md) measures the loss.)

So the tool is a **structured codemod**: it edits the source text *in place* (into a fresh copy),
at spans the parser reports, and touches nothing else. Everything not named by a directive is
preserved **by construction** — not by care, not by a rendering that happens to be faithful, but
because those bytes are never read, never rewritten, never even loaded into a model.

That leaves the tool with exactly two things to know, and it owns **neither**:

- **What the target looks like** — the *shape*. Answered by the engine
  (`DefinitionsRewriter.fromDirectives` → `targetDefs` + `typeMap`). No target type text is ever
  authored here; a retyped field's new type is `typeMap`'s answer, stringified.
- **Where, exactly, in the text** — the *position*. Answered by the parser's `DSMSourceMap`
  by-product: the source span of every declaration, field, case, namespace, docstring and
  **resolved** type-reference.

The codemod is the join of those two oracles, and nothing more. Each directive becomes a set of
`(file, start, stop, replacement)` edits; the edits are spliced; the result is re-parsed and its
digest compared to the engine's target. **The engine is used as a verifier, not as a producer** —
that inversion is what distinguishes this module from every other consumer of `rewrite/`.

One consequence worth stating up front, because it will save you an afternoon: the tool is
**declaration-directed**, not text-directed. It never searches the text for a name. Every semantic
position comes from the source-map; the only text scanning it does is *syntactic* and local —
finding a closing brace, a statement terminator, a line's indentation.

---

## 2 · Module map

One file, `src/definitions_migrate.mjs`, plus a CLI wrapper (`bin/definitions_migrate.mjs`), in
four layers. The layers are worth keeping distinct in your head: a bug in the bottom two corrupts
*any* edit; a bug in the top two corrupts *one directive*.

| Layer | Symbols | Role |
|---|---|---|
| **Span resolution** | `Resolver` · `lineStarts` | a global offset into the assembled content → `[source file, local start, local stop]`, half-open |
| **The edit algebra** | `Edit` · `applyEdits` · `resolveOverlaps` · `tidyCut` · `tidyCutCase` | splice a set of edits into one file's text without them treading on each other |
| **Derivation** | `derive` (+ `buildIndex`, `insertBeforeClose`, `renderFieldLine`, `renderDoc`) | directives + source-map + engine → edits. One directive family per paragraph, in dependency order |
| **Region rewrites** | `reorderFields` / `reorderCases` / `bake` / `dropRegionEdits` · `relocateMovedTypes` / `matchBrace` | the two operations that move *text*, not just replace it — they consume the edits already derived |

The entry points around them:

| Symbol | Role |
|---|---|
| `definitionsMigrate(dsmDir, transformationModule, outDir, { verify = true, onNotice })` | the whole chain (§3): read → parse → directives → engine → derive → apply → verify → write |
| `readTree` / `parseTree` | I/O and the `DSMBuilder` assembly — the only places that touch a file or the parser |
| `refuseUnsupported` / `UNSUPPORTED` | the fail-closed seam (§7): a directive with no source-patch is refused up front |
| `refuseDanglingPools` / `poolFindings` / `signatureTypeNames` | the pools, which the engine cannot see: refuse a dropped type still named by a signature, notify a rewritten one |
| `bin/definitions_migrate.mjs` | the CLI (`--no-verify`, `--force`) |

> **Read order for a newcomer:** `definitionsMigrate()` (the six numbered steps — the whole story
> in forty lines) → `derive` top to bottom (each directive family is a self-contained paragraph)
> → `applyEdits` + `resolveOverlaps` (why edits do not collide) → `reorderFields` and
> `relocateMovedTypes` **last**. The two region rewrites are the only genuinely subtle code in
> the file, and they only make sense once you have seen what they are consuming.

---

## 3 · The chain of proof

Six steps, and each is a link. Read `definitionsMigrate()` alongside.

1. **Read** the source tree (`readTree`) — `.dsm` files only, sorted, never mutated.
2. **Parse** with a `DSMSourceMap` attached (`parseTree`). A parse error here is the *user's*
   source being broken, and it is refused with file:line:pos before anything else runs.
3. **Directives** — `transformationModule.buildDirectives(sourceDefs)`. The **same module** the
   data migration runs, over the same source definitions, so the two artefacts cannot drift by
   construction: one edit script, two consumers.
4. **The engine oracle** — `DefinitionsRewriter.fromDirectives(sourceDefs, directives)` yields the
   target `Definitions` and `typeMap`. Every refusal the engine makes (an un-policied lossy op, a
   dangling `dropType`, a namespace collision, a directive naming something absent) fires *here*,
   before a byte of text is touched, with the engine's own message.
5. **Derive and apply** — `derive` produces the edits, `applyEdits` splices them per file.
6. **Verify, then write** — re-parse the patched tree **in memory** and compare digests; only then
   write `outDir`. A failed verify leaves no target tree behind.

### What the digest proves

`runtimeId` is a content fingerprint of a definition and `Definitions.hexdigest()` aggregates them,
so an equal digest is a strong structural claim: the patched source declares *the same schema* the
engine built. It is sensitive to the **namespace uuid**, **type names**, **field names**, **field
order**, **field types and defaults**, **cases and their order**.

### What the digest does *not* prove — read this before adding a test

The digest is computed over the *persistence* `Definitions`, which deliberately excludes several
things this tool nonetheless edits. Where the oracle is blind, **the test must assert on the
patched text itself**; `verify: true` will happily pass a wrong patch.

| Edited by the tool | In the digest? | What actually covers it |
|---|---|---|
| documentation (`documentType` / `documentField` / `documentCase` / `documentAttachment`) | **no** — a doc is outside the `runtimeId` by design (a doc change must never re-id or re-key data) | the re-parse (it is syntactically valid) + a text assertion |
| a namespace's **display name** (`renameNamespace`) | **no** — the `runtimeId` binds the namespace *uuid*, not its name | the re-parse (references must still resolve) + a text assertion |
| function-pool signatures (both kinds — see below) | **no** — pools are binding/service, outside persistence | the re-parse: a signature naming a renamed or moved type must still **resolve**, and unambiguously |
| the file split, comments, formatting, blank lines | **no** | nothing — they are preserved *by construction* (§1), which is why no code may rewrite a region it was not asked to |

So there are really **two** oracles, and they are complementary: the **re-parse** proves the patch
is *syntactically valid and referentially closed*; the **digest** proves it is *structurally the
target*. Neither alone is enough, and both together still say nothing about style.

> **The rule, stated once.** Anything the digest cannot see must be pinned by a text assertion in
> `test/definitions_migrate.test.mjs`. A test for a documentation, namespace-rename, or pool-facing
> change that only calls `definitionsMigrate(..., { verify: true })` and asserts nothing is a test
> that passes on a no-op.

---

## 4 · Invariants

The properties the code holds true. A change that reads fine and quietly breaks one is the
dangerous kind.

**1 · The engine is the only authority on *shape*.** No DSM type expression is composed by hand.
A changed field's text comes from `typeMap` — `tgtField.get(...).type().representation(tns)` in
`derive` — for *every* type-changing directive at once (`retypeField`, `transformField`,
`resize*`, `transpose*` share the single `typeChanged` pass). This is why the dimension and
Class-C directives need no DSM-specific code: they change the target type, and the target type is
read off the engine. Never special-case a type's spelling here; if the text is wrong, the engine's
type is wrong.

**2 · The source-map is the only authority on *position*.** Every semantic edit is anchored to a
span the parser reported. The tool must never locate a declaration, field or reference by searching
the text — a comment mentioning `Order`, a string literal containing `::`, or a field name that is
a substring of another would all break it. Local *syntactic* scanning is fine and expected
(`tidyCut`, `lineIndent`, `matchBrace`, `insertBeforeClose`): those look for braces, terminators
and whitespace, never for meaning.

**3 · One span, one edit.** `applyEdits` splices right-to-left over offsets that assume the text
has not moved beneath them; `resolveOverlaps` only understands **strict containment** (a wholesale
replacement subsumes the finer edits inside it). Two edits with the *same* span would both apply
and corrupt each other. When you add a directive, ask which existing family could name the same
span, and make one subsume the other.

**4 · A reference mirrors the source's qualification — except a move, which always qualifies.**
The unified reference pass rewrites a resolved reference to its target name while **keeping the
form the author chose**: a bare `Customer` stays bare, a qualified `Shop::Order` keeps its prefix.
A pool signature may write either — outside a namespace a bare name still resolves, provided the
parser finds exactly one candidate. The one exception is `moveType`: a bare `T` left behind in the
old namespace would dangle, so a moved referent is always rewritten fully qualified. This is also
the pass that makes pool signatures survive a rename (§3) — the parser resolves them, so the
source-map holds their references like any other.

**5 · A relocated member carries its own edits, and they leave the list.** `bake` applies the
edits falling inside a member's extent to the member's *text* before that text is moved; the
consumed edits are then dropped (`dropRegionEdits` for a reorder, an identity filter in
`relocateMovedTypes`). Otherwise the same edit would apply twice — once inside the moved text,
once at the now-vacated offsets — or, worse, be silently lost. Whenever text moves, ask what was
supposed to happen *inside* it.

**6 · Derivation order is dependency order.** The paragraph order inside `derive` is not
cosmetic. Renames, references, types and docs are derived first; **`reorder` next**, so a reordered
member's own edits are already available to bake; **`move` last**, so a declaration that is
renamed *and* retyped *and* reordered *and* moved carries all of it into its new namespace. Moving
a paragraph up in that function is a silent-corruption change, not a refactor.

**7 · Nothing references an attachment.** A key is a concept-instance identity, not a foreign key,
so an attachment rename / move / drop patches its **declaration only** — no reference sweep. Same
fact, same consequence as on the data side. (Attachments are declarations in the source map like
any type, keyed — like every declaration — on the map's own `identifier()`, which for an attachment
is `NS::KeyConcept.name`. A bare local name is not unique, so a key maps to the **list** of
declarations it names: a legacy local name patches every homonym, exactly as the engine's lookup
does.)

**8 · Fail closed at the seam.** `UNSUPPORTED` is intentionally **empty** — every directive is
patched today. It stays as the seam: a directive added to `TransformationDirectives` upstream and
not taught to `derive` should be refused *up front* with an actionable message, not left to the
digest oracle to reject after the fact with a hex mismatch. Extending the directive vocabulary
without visiting this file is the failure mode it exists to catch.

**8b · A directive that names nothing is refused, not ignored.** A directive addresses its target
by its **source** name, so a misspelling matches nothing: the target is built as if it had never
been written, the digest agrees, and the run reports success having changed not one byte. The
engine's `refuseUnknownTargets` (phase 1, before anything is built) turns that silence into one
accumulated report. Two families are exempt **because their names are not source names**:
`fieldOrder` / `caseOrder` list the *target* member set, and `transformType` keys a `runtimeId`
that need not occur in the persistence schema at all — a composite used only in a pool signature is
exactly the case this tool exists to handle. Do not "tighten" either one.

**9 · The source tree is read-only, and the target is written only after verification.** The
inputs are never mutated (the tool's non-destructiveness is what makes it safe to rerun), and the
re-parse + digest check runs on the in-memory patched text, so a failure leaves nothing on disk —
the codemod's twin of the data migration discarding a partial target.

---

## 5 · The edit algebra

The bottom two layers, in detail. Everything above them produces `Edit`s and trusts this.

### Spans

The parser reports offsets into `builder.content()` — the *assembled* content of every file. Index
**`content()`**, never the original input text: the builder may differ from what you appended (a
normalised newline, a trailing byte), so the spans are only valid against the content it returns.
Offsets index that string as a JS string; the same value the binding returns is used unchanged, so
the arithmetic holds as long as you never re-index the raw input. Spans are **inclusive**;
`Resolver.resolve` converts to half-open (`stop - base + 1`) because that is what `slice` wants. A
file occupies a contiguous line range in the assembled content, so its base is the content offset
of its first line, and a local offset is `global - base` — valid across a multi-line span.

### An edit

`new Edit(source, start, stop, replacement, tidy)`, with two degenerate forms that carry meaning:

- `start === stop` — an **insertion** (a zero-width splice). Insertions never subsume and are never
  subsumed by `resolveOverlaps`.
- `replacement === ''` with `tidy === true` — a **deletion that cleans up after itself**. `tidyCut`
  widens the span to swallow the trailing `;`, the rest of the line through its newline, and the
  leading indentation, then collapses a blank line left dangling below an already-blank line above.
  `tidyCutCase` is its comma-list twin: a case eats its *following* comma, or — when it is the
  list's last case — the *preceding* one.

`applyEdits` sorts by `(start, stop)` descending and splices, so earlier edits' offsets stay valid.

### Rendering, where it is unavoidable

Three things have no source text to patch, and only these three are rendered:

- **an added field** — `renderFieldLine` builds a throwaway one-field struct, runs the
  **binding's own** DSM renderer (`DSMDefinitions.fromDefinitions(...).toDsm()`) and lifts the
  member line out. Literal formatting (floats, uuids, containers) is therefore the runtime's, not
  ours — the same reason invariant #1 exists, applied to values;
- **a docstring** — `renderDoc` (`"""…"""`, multi-line aware), re-indented to the anchor by
  `reindent`;
- **a fresh `namespace Y {uuid} { … };` block** — when a `moveType`'s target namespace does not
  yet exist in the tree (§6).

Indentation for an inserted member is taken from an existing sibling (`insertBeforeClose`), not
from a constant, so the tool adopts the file's style rather than imposing one.

---

## 6 · The directives, family by family

`derive`, paragraph by paragraph, in its (load-bearing — invariant #6) order. `buildIndex` first
builds the three lookups the whole function uses: declarations by `identifier()` (types **and**
attachments), fields by `(struct repr, name)`, cases by `(enum repr, name)`.

**Type rename** — patch the declaration's `nameSpan`. Its references are *not* handled here.

**The unified reference pass** — one loop over `sourceMap.references()` handling three directives
at once: a type rename (the simple name), a namespace rename (the prefix), and a `moveType` (both,
always qualified). Qualification mirrors the source (invariant #4). Untouched referents — including
every primitive — are skipped, so the pass costs nothing on a small edit. This single loop is what
carries a rename into a **function-pool signature**, which the digest cannot check but the re-parse
can (§3). DSM declares two kinds of pool and this pass covers both: `function_pool` (stateless) and
`attachment_function_pool` (stateful — the name is a code-generation contract, meaning the generated
function takes `AttachmentGetting`, or `AttachmentMutating` under `mutable`, as an implicit first
parameter; it binds no persistence attachment, so no attachment directive reaches a pool). Neither
the pool header nor `mutable` is ever edited, so a migration cannot alter that contract.

Two pool failure modes exist, and they are different in kind — which decides *where* each is
caught. A **dropped** type leaves a signature naming nothing: that is membership of a name in a
set, so `refuseDanglingPools` answers it **up front**, before any edit, walking the parsed DSM
model (`poolFindings` over both pool kinds, `signatureTypeNames` down through containers), and
refuses with every site accumulated. A **renamed** type can instead make a bare signature reference
*ambiguous* (two namespaces now offer the same simple name): that is a property of the whole
patched tree, answerable only by resolving it — the parser's job at the verify re-parse, which
reports it sited and with its candidates. Do not try to pre-compute the second; it would mean
re-implementing the inspector.

A `transformType` is the third case and is neither: the signature is rewritten to the new type,
which is what was asked, so it is **notified** (`onNotice`, printed by the CLI) rather than
refused — a pool's API changed silently, and the author should know.

**`transformType`** — a *global* type substitution. The directive keys its source by `runtimeId`
(the engine's storage key) and records the source type's `representation()` beside it
(`transformedTypeNames`) — that name is what this layer matches on, and every **occurrence** in
`sourceMap.types()` carrying it is replaced. Keeping the name at the directive is what lets the
substitution reach a type the *schema* does not hold: a composite used only in a function-pool
signature is in no `Definitions`, so no walk over the definitions could have found it. A composite
occurrence spans the whole expression, so a nested match lands inside an outer replacement —
overlap resolution keeps the outer one (invariant #3). A *named* source type is hooked away by the
engine, so its declaration is cut.

**Field / case rename** — the member's `nameSpan`. **Attachment rename** — the declaration's, and
nothing else (invariant #7); a local name may address several, so every matching declaration is
patched.

**Type change** — the union of `retypedFields`, `transformedFields`, `resizedFields`,
`transposedFields`: one pass, one source of truth (invariant #1). The target field is looked up
under its *renamed* name, since a rename may be in flight in the same migration. A second edit
follows the first: when the engine's target field carries **no** default, the `= <literal>` clause
is cut — the parser reports its span (`defaultSpan`), so nothing is inferred — a default was
authored against the old type, so the engine does not carry it onto a type-changed field, and the
text must say the same thing the definition does.

**Namespace rename / remap** — patch `nameSpan` / `uuidSpan` at **every** occurrence in
`sourceMap.nameSpaces()`: one namespace may be re-opened in several files, and all of them must
agree or the tree stops assembling.

**Documentation** — replace an existing docstring span, or (when there is none) insert one at the
anchor declaration's line start, re-indented. `''` clears, via a `tidy` deletion. Remember the
digest is blind here (§3).

**Add a field / add a case** — `insertBeforeClose` splices before the block's closing brace, at
the sibling indentation; a case joins the comma list after the last existing case.

**Remove a case** — the comma-aware cut. **Drop a type / an attachment / a field** — a `tidy`
deletion of the whole block or declaration.

**Reorder fields / cases** — the first of the two region rewrites. The member region
`[min start, max end]` is replaced wholesale by the target permutation: each surviving member's
text is **baked** (invariant #5), dropped members are omitted, added members are rendered in place,
and the superseded edits — everything inside the region, plus the add-member insertions past it —
are removed from the list. An `order` that is not a permutation of the resulting member set throws
`Error` with the expected set: the failure is the *user's* directive being incoherent, and it is
worth failing loudly rather than producing a plausible tree the digest would then reject.

**`moveType` / `moveAttachment`** — the second region rewrite, and the most intricate. The
declaration's text (docstring included, own edits baked) is cut from its namespace block and
spliced into the target:

- into a **live** block for that namespace if one exists — preferring one in the same file — just
  before its closing brace, found by `matchBrace`, which counts braces while **skipping string
  and docstring bodies** (a `"has { brace"` default must not throw off the depth; a `{uuid}` is
  self-balancing and needs no care);
- otherwise a **fresh** `namespace Y {uuid} { … };` block appended to the declaration's own file.
  Two adjacent blocks for one namespace simply re-open it — valid DSM.

One extra pass earns its keep here: a reference *inside* the moved declaration to a type that
stays behind (an attachment's key concept, say) would dangle once the text lands in `Y`, because a
bare name no longer resolves there. Those are qualified on the way out — the reference pass above
only touched *renamed or moved* referents, and an unchanged staying sibling is neither.

---

## 7 · Extension points

### Adding a directive

The engine work comes first (see REWRITE.md §7); then, here:

1. **Decide the position**: which span in the source-map names the thing you edit? If none does,
   you need a parser change (§8), not a codemod change.
2. **Add a paragraph to `derive`**, respecting the order (invariant #6): before `reorder` unless
   it *is* a region rewrite.
3. **Never author type text** (invariant #1). If your directive changes a field's type, add it to
   the `typeChanged` union and you are done.
4. **Check for span collisions** with the families that could name the same position (invariant #3).
5. **Test it** — and if the digest cannot see your change (§3), assert on the patched text.
6. If you cannot patch it yet, put it in `UNSUPPORTED` with a reason. An honest refusal is a
   feature; a directive that silently no-ops and is caught later by a hex mismatch is not.

### Known edges

Scope limits, each one verified by running the tool, recorded so they are not rediscovered as
bugs.

> The one edge that used to sit here — a legacy local name addressing two homonymous attachments —
> is gone: once the source map began reporting a declaration's `identifier()`, a directive key could
> address the **list** of declarations it names, so a local name patches every homonym exactly as the
> engine's own lookup does. Nothing is silently incomplete today.

#### Cosmetic — deliberate

- **Two moves into the same absent namespace produce two adjacent blocks** (in reverse derivation
  order — both are zero-width insertions at the file end). Re-opening a namespace is valid DSM and
  the digest agrees; grouping the moves by target namespace before emitting would produce one
  block.
- **A declaration cut from its namespace can leave an empty `namespace N { … };` block behind.**
  Valid DSM, and the intended behaviour: the codemod removes what it was asked to remove and does
  not tidy the neighbourhood.
- **`--force` does not clean `outDir`**: files from a previous run survive alongside the new ones.

---

## 8 · The Viper boundary

Like the engine, this tool is **pure Node over the `@digitalsubstrate/dsviper` binding**, and the
same rule holds: if a change seems to need new runtime behaviour, it belongs in the runtime.

What it needs from the binding, beyond the engine's requirements:

- **`DSMSourceMap`** — the parser by-product: spans for declarations, fields, cases, namespaces,
  docstrings, resolved references and type occurrences, plus each declaration's `identifier()` —
  its identity in the parser's own terms, which is what keeps this layer from re-deriving one by
  string surgery (invariant #2) — and a field's `defaultSpan`. This is *newer than the package's
  peer floor*, which is why `test/definitions_migrate.test.mjs` **live-probes** the installed
  binding (`typeof V.DSMSourceMap === 'function'`, then `'types' in new V.DSMSourceMap()`) and skips
  cleanly where it is absent — the suite documents the contract without breaking on an older peer.
  Keep that probe on any new test here.
- **`DSMBuilder`** — assembly (`append` / `content` / `part`) and `parse(sourceMap)`.
- **`DSMDefinitions.fromDefinitions(...).toDsm()`** — the renderer, used *only* for the three
  unavoidable renderings of §5.
- **`Definitions.hexdigest()`** — the structural oracle, with the blindnesses catalogued in §3.

A missing span is the one thing that cannot be worked around here: locating the position by text
search would break invariant #2. The right fix is to extend the source-map in the parser.

> **Parity note.** This module is a 1:1 port of the Python `definitions_migrate.py`; keep it that
> way (see the port's reference document). One binding difference bites here: a field's
> `defaultValue()` returns `undefined` in Node where Python returns `None`, so the "cut the default"
> path guards on both.

---

## Appendix — a worked trace

The awkward case, because it exercises invariants #4, #5 and #6 at once: a type **moved** to
another namespace, **renamed**, and with a field **retyped**, while a sibling stays behind.

```js
d.moveType('Shop::Order', archiveNs);            // Shop::Order -> Archive::Order
d.renameType('Shop::Order', 'Shop::Ticket');     // ... and renamed (only the simple name is
                                                 //     read — the move carries the namespace)
d.retypeField('Shop::Order', 'quantity', V.Type.UINT64);
```

Source (one file), with `Customer` staying in `Shop`:

```dsm
namespace Shop {1111…} {
concept Customer;
struct Order {
    key<Customer> buyer;
    uint32 quantity;
};
};
```

`derive` runs in order:

1. **Type rename** — an edit on `Order`'s `nameSpan` → `Ticket`.
2. **Reference pass** — no *external* reference to `Shop::Order` here; `key<Customer>` is
   untouched (`Customer` is neither renamed, moved, nor in a renamed namespace).
3. **Type change** — an edit on `quantity`'s `typeSpan` → `uint64 `, the text coming from
   `typeMap` (invariant #1), not from the directive.
4. **Move** (last — invariant #6). The declaration's extent is cut, and the two edits above,
   falling inside it, are **baked** into the carried text and removed from the list (invariant #5).
   The extra qualification pass then notices `Customer` resolves to `Shop`, which is *not* the move
   target, and qualifies it — a bare `Customer` would dangle in `Archive`. `Archive` has no block
   in the tree, so a fresh one is appended.

Result:

```dsm
namespace Shop {1111…} {
concept Customer;
};

namespace Archive {2222…} {

struct Ticket {
    key<Shop::Customer> buyer;
    uint64 quantity;
};

};
```

**Verify** re-parses this in memory: it resolves (so the qualification was necessary and
sufficient), and its digest equals the engine's target (so the rename, the move and the retype all
landed). Only then is it written. Note what the digest did *not* check, and what the test must
therefore assert itself: that `concept Customer;` is still in its original file, unmoved and
uncommented — the whole point of a codemod.
