// definitions_migrate.mjs — the DSM-source twin of database_migrate. A 1:1 port of the Python
// definitions_migrate.py.
//
// A schema change migrates two artefacts: the data in a base (migrate_database) and the
// hand-authored `.dsm` files that document that schema. This tool patches the `.dsm` source in
// place under the SAME transformation module — a structured codemod, not a renderer — so the file
// split, comments, ordering and formatting are preserved by construction. It is non-destructive:
// it reads the source tree and writes a fresh target tree; the original is never mutated.
//
// The edits are span-precise. The parser (dsviper >= 1.2.6) yields a DSMSourceMap alongside the
// parsed definitions: the exact source span of every declaration, field, case, namespace and
// resolved type-reference. Each directive maps to edits at those spans. The shipped rewrite/
// engine is reused only as the verification oracle: re-parse the patched tree and compare its
// Definitions digest to the engine's target (runtimeId is a structure fingerprint, so equal
// digests prove the patch faithful).
//
// Function pools live OUTSIDE the persistence Definitions (they are binding/service, not stored
// data), so the engine's digest ignores them and carries no pool directive. But their signatures
// reference named types, and the source-map captures those references like any other — so a type
// rename or a namespace rename flows into pool signatures through the same reference pass, keeping
// the patched tree resolvable (which the verify re-parse checks).

import fs from 'node:fs';
import path from 'node:path';

import V from './dsviper.mjs';
import { DefinitionsRewriter } from './rewrite/index.mjs';

// -- name helpers ----------------------------------------------------------------------

// The qualified `NS::Name` representation of a binding TypeName.
function reprOf(typeName) {
    return `${typeName.nameSpace().name()}::${typeName.name()}`;
}

// The simple (unqualified) name of a `NS::Name` representation.
function simpleName(qualified) {
    return qualified.slice(qualified.lastIndexOf('::') + 2);
}


// -- span resolution: a global (content) offset -> (file, local offset) ----------------

// Byte offset of the start of each 1-based line (out[line - 1]).
function lineStarts(text) {
    const starts = [0];
    for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
    return starts;
}

// Last index of `ch` in text[start, end), or -1 (a bounded rfind for a single char).
function rfindChar(text, ch, start, end) {
    for (let i = end - 1; i >= start; i--) if (text[i] === ch) return i;
    return -1;
}

// Maps a DSMSourceSpan (global offsets into builder.content()) to (sourceFile, localStart,
// localStop). A file starts at a line boundary in the assembled content, so its global base byte
// is the content offset of its first line; the local offset is `global - base` (valid across
// multi-line spans).
class Resolver {
    constructor(builder) {
        const contentStarts = lineStarts(builder.content());
        const firstLine = {};
        for (const part of builder.parts()) {
            const src = part.source();
            const prev = (src in firstLine) ? firstLine[src] : part.lineStart();
            firstLine[src] = Math.min(prev, part.lineStart());
        }
        this._base = {};
        for (const [src, line] of Object.entries(firstLine)) this._base[src] = contentStarts[line - 1];
        this._builder = builder;
    }

    resolve(span) {
        const source = this._builder.part(span.line()).source();
        const base = this._base[source];
        return [source, span.start() - base, span.stop() - base + 1];   // [start, stop) half-open
    }
}


// -- an edit is a (sourceFile, localStart, localStop, replacement) ----------------------
//
// start == stop marks an insertion (a zero-width splice). `tidy` widens a deletion to swallow its
// statement terminator and leave no dangling line.

class Edit {
    constructor(source, start, stop, replacement, tidy = false) {
        this.source = source;
        this.start = start;
        this.stop = stop;
        this.replacement = replacement;
        this.tidy = tidy;
    }
}

const isSpace = (ch) => ch === ' ' || ch === '\t';

// Widen [start, stop) of a deletion to swallow the trailing statement terminator and leave no
// dangling blank line: eat a following `;` (past any spaces), then the rest of the line through
// its newline, and the indentation back to the line start when nothing else remains before it.
function tidyCut(text, start, stop) {
    const n = text.length;
    let end = stop;
    while (end < n && isSpace(text[end])) end += 1;
    if (end < n && text[end] === ';') end += 1;
    while (end < n && isSpace(text[end])) end += 1;
    if (end < n && text[end] === '\n') end += 1;
    let begin = start;
    while (begin > 0 && isSpace(text[begin - 1])) begin -= 1;
    if (begin === 0 || text[begin - 1] === '\n') {
        if (begin >= 2 && text[begin - 2] === '\n') {          // a blank line sits ABOVE the cut —
            let after = end;                                   // collapse a blank line now left BELOW
            while (after < n && isSpace(text[after])) after += 1;
            if (after < n && text[after] === '\n') end = after + 1;
        }
        return [begin, end];
    }
    return [start, end];
}

// A case lives in a comma-separated list, not a `;`-terminated statement. Eat a following comma
// (and its trailing blank line) if present; otherwise eat a preceding comma (removing the list's
// last case), plus any leading indentation.
function tidyCutCase(text, start, stop) {
    const n = text.length;
    let end = stop;
    while (end < n && isSpace(text[end])) end += 1;
    if (end < n && text[end] === ',') {                        // a middle/leading case: eat "<name>,"
        end += 1;
        while (end < n && isSpace(text[end])) end += 1;
        if (end < n && text[end] === '\n') end += 1;
        let begin = start;
        while (begin > 0 && isSpace(text[begin - 1])) begin -= 1;
        return (begin === 0 || text[begin - 1] === '\n') ? [begin, end] : [start, end];
    }
    let begin = start;                                         // the last case: eat the preceding ", "
    while (begin > 0 && (isSpace(text[begin - 1]) || text[begin - 1] === '\n')) begin -= 1;
    if (begin > 0 && text[begin - 1] === ',') begin -= 1;
    return [begin, stop];
}

// Drop any edit strictly contained within another edit's span: a wholesale replacement (a retyped
// field's type, a dropped block) subsumes the finer edits inside it (e.g. a reference rename that
// falls within a rewritten type).
function resolveOverlaps(edits) {
    const replacements = edits.filter((e) => e.stop > e.start);
    const kept = [];
    for (const e of replacements) {
        if (replacements.some((o) => o !== e && o.source === e.source     // offsets per-file — compare within one
            && o.start <= e.start && e.stop <= o.stop
            && (o.stop - o.start) > (e.stop - e.start))) continue;
        kept.push(e);
    }
    for (const e of edits) if (e.stop === e.start) kept.push(e);           // insertions never subsume
    return kept;
}

// Splice edits into one file's text, right-to-left. Assumes non-overlapping (see resolveOverlaps);
// insertions (start == stop) splice cleanly.
function applyEdits(text, edits) {
    const sorted = edits.slice().sort((a, b) => (b.start - a.start) || (b.stop - a.stop));
    for (const e of sorted) {
        let { start, stop } = e;
        if (e.tidy && e.replacement === '') [start, stop] = tidyCut(text, start, stop);
        text = text.slice(0, start) + e.replacement + text.slice(stop);
    }
    return text;
}


// -- rendering a lone member (an added field): reuse the binding's own DSM renderer -----

// The DSM text of one field — `<type> <name>[ = <literal>];` — produced by the binding's renderer
// over a throwaway one-field struct, so literal formatting (floats, uuids, containers) is the
// engine's, not ours. `valueOrType` is a default Value (static add) or a Type (a `derive=` field,
// which carries no default).
function renderFieldLine(name, valueOrType) {
    const ns = new V.NameSpace(new V.ValueUUId('dede0000-0000-4000-8000-000000000001'), 'T');
    const d = new V.Definitions();
    const ds = new V.TypeStructureDescriptor('F');
    ds.addField(name, valueOrType, '');
    d.createStructure(ns, ds);
    const dsm = V.DSMDefinitions.fromDefinitions(d.const()).toDsm();
    for (const line of dsm.split('\n')) {
        const stripped = line.trim();
        if (stripped.endsWith(';') && stripped !== '};' && !stripped.includes('struct')) return stripped;
    }
    throw new Error(`could not render field ${JSON.stringify(name)}`);
}


// -- edit derivation: directives + source-map -> edits ---------------------------------

const fkey = (repr, name) => `${repr} ${name}`;

// Build lookup indices over the flat source-map lists. A declaration is keyed by its
// `identifier()` — the source map's own identity for it: `NS::Name` for a type, and
// `NS::KeyConcept.name` for an attachment, whose key concept is part of its identity (one
// namespace may hold two attachments of the same name).
function buildIndex(sourceMap) {
    const decl = new Map();                                    // identifier -> declaration holder
    for (const d of sourceMap.declarations()) decl.set(d.identifier(), d);
    const fields = [];                                         // [{ repr, name, holder }]
    const fieldMap = new Map();
    for (const f of sourceMap.fields()) {
        const repr = reprOf(f.structure());
        fields.push({ repr, name: f.name(), holder: f });
        fieldMap.set(fkey(repr, f.name()), f);
    }
    const cases = [];
    const caseMap = new Map();
    for (const c of sourceMap.cases()) {
        const repr = reprOf(c.enumeration());
        cases.push({ repr, name: c.name(), holder: c });
        caseMap.set(fkey(repr, c.name()), c);
    }
    return { decl, fields, fieldMap, cases, caseMap };
}

// An insertion of `member` just before a declaration block's closing `}`, indented like the
// existing members. `memberSpan` (an existing member) supplies the indentation; `joinComma`
// prefixes `, ` onto the previous (comma-list) member.
function insertBeforeClose(declSpan, member, resolve, files, { memberSpan = null, joinComma = false } = {}) {
    const [src, bstart, bstop] = resolve(declSpan);
    const text = files[src];
    const brace = rfindChar(text, '}', bstart, bstop);
    if (brace < 0) return null;
    const lineBegin = rfindChar(text, '\n', bstart, brace) + 1;
    const braceIndent = text.slice(lineBegin, brace);
    let memberIndent = null;
    if (memberSpan !== null) {
        const mstart = resolve(memberSpan)[1];
        const mline = rfindChar(text, '\n', 0, mstart) + 1;
        memberIndent = text.slice(mline, mstart);
    }
    if (!memberIndent) memberIndent = braceIndent + '    ';
    if (joinComma && memberSpan !== null) {                    // append after the last case: ",\n<indent><m>"
        const mstop = resolve(memberSpan)[2];
        return new Edit(src, mstop, mstop, ',\n' + memberIndent + member);
    }
    return new Edit(src, brace, brace, memberIndent + member + '\n' + braceIndent);
}

function derive(directives, sourceMap, resolve, files, rewriter, sourceDefs) {
    const { decl, fields, fieldMap, cases, caseMap } = buildIndex(sourceMap);
    const srcStruct = {};
    for (const s of sourceDefs.structures()) srcStruct[s.representation()] = s;
    // an attachment directive addresses its target by `identifier()` (`NS::KeyConcept.name`) —
    // the attachment's identity, and the declaration's key — or, legacy, by the bare local name.
    // A local name is NOT an identity (one namespace may hold `A.orders` and `B.orders`), so a
    // legacy key that hits several attachments resolves to none of them here: the engine renames
    // every homonym, this layer would patch one, and the digest refuses. Map the unambiguous ones.
    const attRepr = {};
    const ambiguous = new Set();
    for (const a of sourceDefs.attachments()) {
        const id = a.identifier();
        attRepr[id] = id;
        const local = id.slice(id.lastIndexOf('.') + 1);
        if (Object.hasOwn(attRepr, local)) ambiguous.add(local);
        attRepr[local] = id;
    }
    for (const local of ambiguous) delete attRepr[local];
    let edits = [];

    const edit = (span, replacement, tidy = false) => {
        if (span === null) return;
        const [source, start, stop] = resolve(span);
        edits.push(new Edit(source, start, stop, replacement, tidy));
    };

    // type rename: patch the declaration name (its references are handled below)
    for (const [srcRepr, dstRepr] of Object.entries(directives.typeRenames)) {
        if (decl.has(srcRepr)) edit(decl.get(srcRepr).nameSpan(), simpleName(dstRepr));
    }

    // unified reference pass: every resolved type-reference — in a struct field AND in a
    // function-pool signature (pools sit outside the persistence Definitions, so the engine digest
    // ignores them, but the parser resolves them and the source-map captures them) — rewritten to
    // its target name, MIRRORING the source's qualification. A bare reference (`Customer`) stays
    // bare; a qualified one (`N::SI`, as pool signatures write) keeps its `NS::` prefix. A type
    // rename (simple name), a namespace rename (the prefix), and a move_type (both, and always
    // fully-qualified) are applied here, so a signature that outlives its type's edit stays valid.
    for (const r of sourceMap.references()) {
        const referent = r.referent();
        if (referent === null) continue;
        const rns = referent.nameSpace();
        const srcRepr = `${rns.name()}::${referent.name()}`;
        const nsUuid = rns.uuid().representation();
        const renamedType = Object.hasOwn(directives.typeRenames, srcRepr);
        const renamedNs = Object.hasOwn(directives.namespaceNames, nsUuid);
        const moved = Object.hasOwn(directives.typeNamespaces, srcRepr);
        if (!(renamedType || renamedNs || moved)) continue;    // untouched (incl. every primitive)
        const [srcFile, start, stop] = resolve(r.span());
        const original = files[srcFile].slice(start, stop);
        const tgtSimple = renamedType ? simpleName(directives.typeRenames[srcRepr]) : referent.name();
        let replacement;
        if (moved) {                                           // a bare `T` in the old namespace would
            const tgtNs = directives.typeNamespaces[srcRepr].name();   // dangle — always qualify to Y::T
            replacement = tgtNs + '::' + tgtSimple;
        } else {
            const tgtNs = directives.namespaceNames[nsUuid] ?? rns.name();
            replacement = original.includes('::') ? (tgtNs + '::' + tgtSimple) : tgtSimple;
        }
        if (replacement !== original) edits.push(new Edit(srcFile, start, stop, replacement));
    }

    // transform_type: a GLOBAL type substitution (source -> new_type, at every occurrence incl.
    // nested). The directive keys the source by runtimeId (engine storage) and records the source
    // type's representation alongside, which is the name this layer matches on — every occurrence
    // in sourceMap.types() whose representation matches is rewritten (the span covers the whole
    // expression, composites included). A nested source's inner occurrence lands inside the outer
    // replacement — overlap resolution keeps the outer one. A named source's declaration is dropped
    // by the engine (hooked), so cut it.
    if (Object.keys(directives.transformedTypes).length) {
        const fqnToNew = new Map();
        for (const [rid, [newType]] of Object.entries(directives.transformedTypes))
            if (Object.hasOwn(directives.transformedTypeNames, rid))
                fqnToNew.set(directives.transformedTypeNames[rid], newType.representation());
        for (const occ of sourceMap.types()) {
            const newFqn = fqnToNew.get(occ.representation());
            if (newFqn !== undefined) {
                const [src, start, stop] = resolve(occ.span());
                edits.push(new Edit(src, start, stop, newFqn));
            }
        }
        for (const fqn of fqnToNew.keys())                     // a named source's declaration is dropped
            if (decl.has(fqn)) edit(decl.get(fqn).blockSpan(), '', true);
    }

    // field rename
    for (const [structRepr, renames] of Object.entries(directives.fieldRenames)) {
        for (const [oldName, newName] of Object.entries(renames)) {
            const f = fieldMap.get(fkey(structRepr, oldName));
            if (f !== undefined) edit(f.nameSpan(), newName);
        }
    }

    // case rename
    for (const [enumRepr, renames] of Object.entries(directives.caseRenames)) {
        for (const [oldName, newName] of Object.entries(renames)) {
            const c = caseMap.get(fkey(enumRepr, oldName));
            if (c !== undefined) edit(c.nameSpan(), newName);
        }
    }

    // attachment rename: an attachment lives in declarations() too (the Converter records it), and
    // NOTHING references an attachment (a key is a concept-instance identity, not a foreign key),
    // so only its declaration name needs patching — no reference sweep. Keyed by local name.
    for (const [localOld, localNew] of Object.entries(directives.attachmentRenames)) {
        const d = decl.get(attRepr[localOld] ?? '');
        if (d !== undefined) edit(d.nameSpan(), localNew);
    }

    // field type change (retype / transform / resize / transpose): replace the type expression with
    // the engine-computed target type — the single oracle for the shape. The Class-C `fn` is
    // data-only; the dimension/policy directives carry no DSM text.
    const typeChanged = new Map();                             // struct repr -> Set(field)
    for (const group of [directives.retypedFields, directives.transformedFields,
        directives.resizedFields, directives.transposedFields]) {
        for (const [structRepr, entry] of Object.entries(group)) {
            const names = entry instanceof Set ? [...entry] : Object.keys(entry);
            if (!typeChanged.has(structRepr)) typeChanged.set(structRepr, new Set());
            for (const n of names) typeChanged.get(structRepr).add(n);
        }
    }
    for (const [structRepr, fnames] of typeChanged) {
        const s = srcStruct[structRepr];
        if (s === undefined) continue;
        const tgt = rewriter.typeMap[s.runtimeId().representation()];
        if (tgt === undefined) continue;
        const tns = tgt.typeName().nameSpace();
        const tgtField = new Map(tgt.fields().map((tf) => [tf.name(), tf]));
        const renames = directives.fieldRenames[structRepr] ?? {};
        for (const fname of fnames) {
            const f = fieldMap.get(fkey(structRepr, fname));
            const tf = tgtField.get(renames[fname] ?? fname);
            if (f === undefined || tf === undefined) continue;
            edit(f.typeSpan(), tf.type().representation(tns) + ' ');
            // a default was authored against the OLD type, so the engine does not carry it onto a
            // type-changed field. Follow the engine (it is the authority on the shape): cut the
            // `= <literal>` tail — the span from the field name's end to the declaration's end —
            // or the text would declare a default the target definition does not have.
            if (tf.defaultValue() === undefined || tf.defaultValue() === null) {
                const [src, , nstop] = resolve(f.nameSpan());
                const [, , dstop] = resolve(f.declarationSpan());
                if (dstop > nstop) edits.push(new Edit(src, nstop, dstop, ''));
            }
        }
    }

    // namespace rename (display name) / remap (uuid): patch every occurrence of the namespace
    // declaration across the file split (a namespace may span several files).
    for (const ns of sourceMap.nameSpaces()) {
        const key = ns.nameSpace().uuid().representation();
        if (Object.hasOwn(directives.namespaceNames, key)) edit(ns.nameSpan(), directives.namespaceNames[key]);
        if (Object.hasOwn(directives.namespaceUuids, key))
            edit(ns.uuidSpan(), '{' + directives.namespaceUuids[key].representation() + '}');
    }

    // documentation authoring: replace an existing docstring, else insert one before the
    // declaration (Class A — a doc change is outside the runtimeId, but carried faithfully).
    const docEdit = (docSpan, anchorSpan, text) => {
        const block = renderDoc(text);
        if (docSpan !== null) {                                // replace (or clear) an existing docstring
            edit(docSpan, block, !block);
        } else if (block) {                                    // author a new one, before the declaration
            const [src, astart] = resolve(anchorSpan);
            const lineBegin = rfindChar(files[src], '\n', 0, astart) + 1;
            const indent = files[src].slice(lineBegin, astart);
            edits.push(new Edit(src, lineBegin, lineBegin, reindent(block, indent)));
        }
    };

    for (const [typeRepr, text] of Object.entries(directives.typeDocs)) {
        const d = decl.get(typeRepr);
        if (d !== undefined) docEdit(d.documentationSpan(), d.blockSpan(), text);
    }
    for (const [structRepr, docs] of Object.entries(directives.fieldDocs)) {
        for (const [fname, text] of Object.entries(docs)) {
            const f = fieldMap.get(fkey(structRepr, fname));
            if (f !== undefined) docEdit(f.documentationSpan(), f.declarationSpan(), text);
        }
    }
    for (const [enumRepr, docs] of Object.entries(directives.caseDocs)) {
        for (const [cname, text] of Object.entries(docs)) {
            const c = caseMap.get(fkey(enumRepr, cname));
            if (c !== undefined) docEdit(c.documentationSpan(), c.nameSpan(), text);
        }
    }
    for (const [local, text] of Object.entries(directives.attachmentDocs)) {
        const d = decl.get(attRepr[local] ?? '');
        if (d !== undefined) docEdit(d.documentationSpan(), d.blockSpan(), text);
    }

    // add a field: render it and splice before the struct's closing brace
    for (const [structRepr, adds] of Object.entries(directives.addedFields)) {
        const d = decl.get(structRepr);
        if (d === undefined) continue;
        const members = fields.filter((x) => x.repr === structRepr).map((x) => x.holder.declarationSpan());
        const anchor = members.length ? members[members.length - 1] : null;
        for (const [name, payload] of adds) {
            const line = renderFieldLine(name, payload);
            const e = insertBeforeClose(d.blockSpan(), line, resolve, files, { memberSpan: anchor });
            if (e !== null) edits.push(e);
        }
    }

    // add a case: splice after the last case (comma-joined) or before the enum brace
    for (const [enumRepr, names] of Object.entries(directives.addedCases)) {
        const d = decl.get(enumRepr);
        if (d === undefined) continue;
        const enumCases = cases.filter((x) => x.repr === enumRepr).map((x) => x.holder.nameSpan());
        const last = enumCases.length ? enumCases[enumCases.length - 1] : null;
        for (const name of names) {
            const e = insertBeforeClose(d.blockSpan(), name, resolve, files,
                { memberSpan: last, joinComma: last !== null });
            if (e !== null) edits.push(e);
        }
    }

    // remove a case: comma-aware cut
    for (const [enumRepr, removed] of Object.entries(directives.removedCases)) {
        for (const cname of Object.keys(removed)) {
            const c = caseMap.get(fkey(enumRepr, cname));
            if (c !== undefined) {
                const [src, start0, stop0] = resolve(c.nameSpan());
                const [start, stop] = tidyCutCase(files[src], start0, stop0);
                edits.push(new Edit(src, start, stop, ''));
            }
        }
    }

    // drop type / drop attachment: cut the whole declaration block (attachments are declarations
    // too; nothing references one, so a cut dangles nothing)
    for (const typeRepr of directives.droppedTypes)
        if (decl.has(typeRepr)) edit(decl.get(typeRepr).blockSpan(), '', true);
    for (const local of directives.droppedAttachments) {
        const d = decl.get(attRepr[local] ?? '');
        if (d !== undefined) edit(d.blockSpan(), '', true);
    }

    // drop field: cut the whole field declaration
    for (const [structRepr, dropped] of Object.entries(directives.droppedFields)) {
        for (const fieldName of dropped) {
            const f = fieldMap.get(fkey(structRepr, fieldName));
            if (f !== undefined) edit(f.declarationSpan(), '', true);
        }
    }

    // reorder fields / cases: rewrite the member region in the TARGET order (a full permutation of
    // the target member set), each member carrying its own baked-in edits. Before move, so a
    // reordered+moved declaration's region edit is picked up as the moved text's internal edit.
    edits = reorderFields(edits, directives, decl, fields, resolve, files);
    edits = reorderCases(edits, directives, decl, cases, resolve, files);

    // move_type: relocate a whole declaration to a different namespace. Its text (docstring +
    // block, with any of its OWN edits — a rename/retype of the moved type — baked in) is CUT from
    // its source namespace block and spliced into the target: a fresh `namespace Y {uuid}` block
    // appended to a file where Y already lives, else to the declaration's own file (two adjacent
    // blocks for one namespace re-open it — valid DSM). References were re-qualified to Y:: above.
    // Run last, so a moved declaration's internal edits are already in `edits`.
    edits = relocateMovedTypes(edits, directives, decl, sourceMap, resolve, files, attRepr);

    return resolveOverlaps(edits);
}


// -- reorder: rewrite a declaration's member region in the target order --------------------

// The leading whitespace of the line containing `pos`.
function lineIndent(text, pos) {
    const lineBegin = rfindChar(text, '\n', 0, pos) + 1;
    let i = lineBegin;
    while (i < text.length && isSpace(text[i])) i += 1;
    return text.slice(lineBegin, i);
}

// A field's full text extent: [docstring-or-declaration start, past the `;`].
function fieldUnit(f, resolve, files) {
    const [src, dstart, dstop] = resolve(f.declarationSpan());
    const text = files[src];
    let end = dstop;
    while (end < text.length && isSpace(text[end])) end += 1;
    if (end < text.length && text[end] === ';') end += 1;
    const doc = f.documentationSpan();
    const start = doc !== null ? resolve(doc)[1] : dstart;
    return [src, start, end];
}

// A case's full text extent: [docstring-or-name start, name end] (the comma is excluded).
function caseUnit(c, resolve, files) {
    const [src, nstart, nstop] = resolve(c.nameSpan());
    const doc = c.documentationSpan();
    const start = doc !== null ? resolve(doc)[1] : nstart;
    return [src, start, nstop];
}

// The text of files[src][start:stop] with the edits falling inside it applied (rebased to local
// offsets) — a member carries its own rename/retype into its new slot.
function bake(edits, src, start, stop, files) {
    const inside = edits.filter((e) => e.source === src && start <= e.start && e.stop <= stop);
    return applyEdits(files[src].slice(start, stop),
        inside.map((e) => new Edit(e.source, e.start - start, e.stop - start, e.replacement, e.tidy)));
}

function setsEqual(a, b) {
    if (a.size !== b.size) return false;
    for (const x of a) if (!b.has(x)) return false;
    return true;
}

function reorderFields(edits, directives, decl, fields, resolve, files) {
    for (const [structRepr, order] of Object.entries(directives.fieldOrder)) {
        const d = decl.get(structRepr);
        if (d === undefined) continue;
        const units = fields.filter((x) => x.repr === structRepr)
            .map((x) => [x.holder, fieldUnit(x.holder, resolve, files)]);
        if (!units.length) continue;
        const renames = directives.fieldRenames[structRepr] ?? {};
        const dropped = directives.droppedFields[structRepr] ?? new Set();
        const src = units[0][1][0];
        const rstart = Math.min(...units.map((u) => u[1][1]));
        const rend = Math.max(...units.map((u) => u[1][2]));
        const blockStop = resolve(d.blockSpan())[2];
        const texts = new Map();
        for (const [f, [s, us, ue]] of units)
            if (!dropped.has(f.name())) texts.set(renames[f.name()] ?? f.name(), bake(edits, s, us, ue, files));
        for (const [name, payload] of (directives.addedFields[structRepr] ?? []))
            texts.set(name, renderFieldLine(name, payload));
        if (!setsEqual(new Set(order), new Set(texts.keys())))
            throw new Error(`reorderFields(${structRepr}) not a permutation of ${[...texts.keys()].sort()}`);
        edits = dropRegionEdits(edits, src, rstart, rend, blockStop);
        const indent = lineIndent(files[src], rstart);
        edits.push(new Edit(src, rstart, rend, order.map((n) => texts.get(n)).join('\n' + indent)));
    }
    return edits;
}

function reorderCases(edits, directives, decl, cases, resolve, files) {
    for (const [enumRepr, order] of Object.entries(directives.caseOrder)) {
        const d = decl.get(enumRepr);
        if (d === undefined) continue;
        const units = cases.filter((x) => x.repr === enumRepr)
            .map((x) => [x.holder, caseUnit(x.holder, resolve, files)]);
        if (!units.length) continue;
        const renames = directives.caseRenames[enumRepr] ?? {};
        const removed = directives.removedCases[enumRepr] ?? {};
        const src = units[0][1][0];
        const rstart = Math.min(...units.map((u) => u[1][1]));
        const rend = Math.max(...units.map((u) => u[1][2]));
        const blockStop = resolve(d.blockSpan())[2];
        const texts = new Map();
        for (const [c, [s, us, ue]] of units)
            if (!(c.name() in removed)) texts.set(renames[c.name()] ?? c.name(), bake(edits, s, us, ue, files));
        for (const name of (directives.addedCases[enumRepr] ?? [])) texts.set(name, name);
        if (!setsEqual(new Set(order), new Set(texts.keys())))
            throw new Error(`reorderCases(${enumRepr}) not a permutation of ${[...texts.keys()].sort()}`);
        edits = dropRegionEdits(edits, src, rstart, rend, blockStop);
        const indent = lineIndent(files[src], rstart);
        edits.push(new Edit(src, rstart, rend, order.map((n) => texts.get(n)).join(',\n' + indent)));
    }
    return edits;
}

// Remove edits superseded by a region rewrite: everything inside the member region (baked into the
// member texts), and the add-member insertions past it (their text is now in order).
function dropRegionEdits(edits, src, rstart, rend, blockStop) {
    return edits.filter((e) => !(e.source === src && (
        (rstart <= e.start && e.stop <= rend)
        || (e.start === e.stop && rend <= e.start && e.start <= blockStop))));
}

// Index of the `}` matching the `{` at openPos, counting braces but skipping string and docstring
// bodies (a `"has { brace"` default or a docstring must not throw off the depth). A `{uuid}`
// default is self-balancing, so it needs no care.
function matchBrace(text, openPos) {
    let depth = 0;
    let i = openPos;
    const n = text.length;
    while (i < n) {
        const ch = text[i];
        if (ch === '"') {
            if (text.slice(i, i + 3) === '"""') {              // docstring — cannot contain """
                const close = text.indexOf('"""', i + 3);
                i = close < 0 ? n : close + 3;
                continue;
            }
            i += 1;                                            // string literal — skip to closing "
            while (i < n && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
            i += 1;
            continue;
        }
        if (ch === '{') depth += 1;
        else if (ch === '}') {
            depth -= 1;
            if (depth === 0) return i;
        }
        i += 1;
    }
    return -1;
}

function relocateMovedTypes(edits, directives, decl, sourceMap, resolve, files, attRepr) {
    // types AND attachments move the same way (both are declarations); an attachment names its
    // target by LOCAL name, resolved to the declaration key NS::Name via attRepr.
    const moves = [];
    for (const [t, ns] of Object.entries(directives.typeNamespaces)) moves.push([t, ns]);
    for (const [i, ns] of Object.entries(directives.attachmentNamespaces))
        if (i in attRepr) moves.push([attRepr[i], ns]);
    if (!moves.length) return edits;
    const blocks = new Map();                                  // namespace uuid -> [[file, uuidStop]]
    for (const ns of sourceMap.nameSpaces()) {
        const [src, , ustop] = resolve(ns.uuidSpan());
        const key = ns.nameSpace().uuid().representation();
        if (!blocks.has(key)) blocks.set(key, []);
        blocks.get(key).push([src, ustop]);
    }
    const targetOf = new Map();                                // repr -> its target ns uuid
    for (const [t, ns] of moves) targetOf.set(t, ns.uuid().representation());
    for (const [typeRepr, targetNs] of moves) {
        const d = decl.get(typeRepr);
        if (d === undefined) continue;
        const [srcFile, bstart, bstop] = resolve(d.blockSpan());
        const doc = d.documentationSpan();
        const carryStart = doc !== null ? resolve(doc)[1] : bstart;
        const targetUuid = targetNs.uuid().representation();
        const internal = edits.filter((e) => e.source === srcFile      // this declaration's own edits
            && carryStart <= e.start && e.stop <= bstop);
        // a reference inside the moved declaration to a type NOT landing in the target namespace
        // (e.g. an attachment's key concept, staying behind) would dangle once the declaration is
        // in Y — a bare `Person` no longer resolves. Qualify those (the reference pass only touched
        // renamed/moved referents; an unchanged staying sibling needs this).
        for (const r of sourceMap.references()) {
            const referent = r.referent();
            if (referent === null || !referent.nameSpace().name()) continue;   // skip primitives
            const [rsrc, rstart, rstop] = resolve(r.span());
            if (rsrc !== srcFile || !(carryStart <= rstart && rstop <= bstop)) continue;
            const rns = referent.nameSpace();
            const rrepr = `${rns.name()}::${referent.name()}`;
            const effUuid = targetOf.has(rrepr) ? targetOf.get(rrepr) : rns.uuid().representation();
            const original = files[rsrc].slice(rstart, rstop);
            if (effUuid === targetUuid || original.includes('::')) continue;   // lands in target, or qualified
            if (internal.some((e) => rstart < e.stop && e.start < rstop)) continue;   // already edited
            const nsName = directives.namespaceNames[rns.uuid().representation()] ?? rns.name();
            internal.push(new Edit(rsrc, rstart, rstop, nsName + '::' + referent.name()));
        }
        edits = edits.filter((e) => !internal.includes(e));    // they travel with the text, not the hole
        const carried = applyEdits(files[srcFile].slice(carryStart, bstop),
            internal.map((e) => new Edit(e.source, e.start - carryStart, e.stop - carryStart, e.replacement, e.tidy)));
        edits.push(new Edit(srcFile, carryStart, bstop, '', true));   // cut it out

        const uuid = targetUuid;
        const existing = blocks.get(uuid);
        if (existing && existing.length) {                     // merge into a live namespace block
            const dest = (existing.find((b) => b[0] === srcFile) ?? existing[0])[0];
            const ustop = (existing.find((b) => b[0] === srcFile) ?? existing[0])[1];
            const text = files[dest];
            const close = matchBrace(text, text.indexOf('{', ustop));     // this block's closing brace
            const lineBegin = rfindChar(text, '\n', 0, close) + 1;
            edits.push(new Edit(dest, lineBegin, lineBegin, carried + '\n\n'));
        } else {                                               // split: a fresh block re-opens/creates Y
            const block = `\nnamespace ${targetNs.name()} {${uuid}} {\n\n${carried}\n\n};\n`;
            edits.push(new Edit(srcFile, files[srcFile].length, files[srcFile].length, block));
        }
    }
    return edits;
}

// A DSM docstring block for `text` (`"""…"""`), or "" to clear it.
function renderDoc(text) {
    if (!text) return '';
    if (text.includes('\n')) return '"""\n' + text + '\n"""';
    return '"""' + text + '"""';
}

// Prefix every line of a docstring block with `indent` and a trailing newline. It is spliced at
// the anchor's line start (before the anchor's own indent), so the anchor line keeps its existing
// indentation — no trailing indent here, or it would double.
function reindent(block, indent) {
    return block.split('\n').map((line) => indent + line + '\n').join('');
}


// -- the migration ---------------------------------------------------------------------

function readTree(dsmDir) {
    const files = {};
    for (const name of fs.readdirSync(dsmDir).sort()) {
        if (name.endsWith('.dsm')) files[name] = fs.readFileSync(path.join(dsmDir, name), 'utf-8');
    }
    return files;
}

function parseTree(files, sourceMap = undefined) {
    const builder = new V.DSMBuilder();
    for (const [name, text] of Object.entries(files)) builder.append(name, text);
    const [report, , definitions] = sourceMap !== undefined ? builder.parse(sourceMap) : builder.parse();
    return [builder, report, definitions];
}

// Every TransformationDirectives edit now has a source-patch; the whole surface is covered. The
// guard stays (empty) as the fail-closed seam: a directive added upstream lands here first, refused
// up front rather than left to the digest oracle to reject after the fact.
const UNSUPPORTED = {};

function refuseUnsupported(directives) {
    const reasons = [];
    for (const [attr, why] of Object.entries(UNSUPPORTED)) {
        const v = directives[attr];
        const nonEmpty = v instanceof Set ? v.size : (v && typeof v === 'object' ? Object.keys(v).length : v);
        if (nonEmpty) reasons.push(why);
    }
    if (reasons.length)
        throw new Error('definitions_migrate does not yet patch these directives: '
            + reasons.sort().join(', ')
            + ' — migrate the data with database_migrate.mjs and edit the .dsm by hand.');
}

// Patch the `.dsm` tree under `transformationModule.buildDirectives` and write the result to
// `outDir`. Returns the parse report.
export function definitionsMigrate(dsmDir, transformationModule, outDir, { verify = true } = {}) {
    const files = readTree(dsmDir);
    if (!Object.keys(files).length) throw new Error(`no .dsm files under ${JSON.stringify(dsmDir)}`);

    // 1. parse the source, collecting the source-map
    const sourceMap = new V.DSMSourceMap();
    const [builder, report, sourceDefs] = parseTree(files, sourceMap);
    if (report.hasError())
        throw new Error('source .dsm does not parse:\n'
            + report.errors().map((e) => `  ${e.source()}:${e.line()}:${e.pos()} ${e.message()}`).join('\n'));

    // 2. the SAME transformation module, from the source definitions
    const directives = transformationModule.buildDirectives(sourceDefs);
    refuseUnsupported(directives);

    // 3. engine oracle: the target definitions (+ the source->target type map)
    const [rewriter, targetDefs] = DefinitionsRewriter.fromDirectives(sourceDefs, directives);

    // 4. derive span-precise edits and apply them per file
    const resolver = new Resolver(builder);
    const resolve = (span) => resolver.resolve(span);
    const edits = derive(directives, sourceMap, resolve, files, rewriter, sourceDefs);
    const byFile = {};
    for (const name of Object.keys(files)) byFile[name] = [];
    for (const e of edits) byFile[e.source].push(e);
    const patched = {};
    for (const [name, text] of Object.entries(files)) patched[name] = applyEdits(text, byFile[name]);

    // 5. verify (oracle): re-parse the patched tree IN MEMORY, compare the definitions digest.
    //    Before the write, not after: a failed verify must leave no target tree behind (the
    //    codemod's twin of the data migration discarding a partial target).
    if (verify) {
        const [, vreport, vdefs] = parseTree(patched);
        if (vreport.hasError())
            throw new Error('patched .dsm does not parse:\n'
                + vreport.errors().map((e) => `  ${e.source()}:${e.line()}:${e.pos()} ${e.message()}`).join('\n'));
        const targetDigest = targetDefs.const().hexdigest();
        if (vdefs.hexdigest() !== targetDigest)
            throw new Error('verify failed: patched definitions digest '
                + `${vdefs.hexdigest().slice(0, 12)} != engine target ${targetDigest.slice(0, 12)}`);
    }

    // 6. write the fresh target tree
    fs.mkdirSync(outDir, { recursive: true });
    for (const [name, text] of Object.entries(patched))
        fs.writeFileSync(path.join(outDir, name), text, 'utf-8');

    return report;
}
