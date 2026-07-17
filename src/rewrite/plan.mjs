// The static plan report — pre-validation from directives + definitions ALONE. A 1:1 port.
//
// `plan(sourceDefs, directives)` classifies every change a migration would make, reading only
// the schema (no documents, no target build, no I/O): each site is Class A (lossless), Class B
// (policied — can lose information), or refused; and separately flagged lossy when data changes
// or disappears (a field drop is Class A for the engine but a data loss for the author — the
// forgotten-rename trap). It also raises warnings the author should see before running.

import V from '../dsviper.mjs';
import { WIDENING, INT_RANGE, constDefs, vecmatRetypeClass } from './engine.mjs';

const FLOATS = new Set(['float', 'double']);
const INTS = new Set(Object.keys(INT_RANGE));

const fmtPolicy = (p) => Array.isArray(p)
    ? `[${p.map((x) => (x !== null && typeof x === 'object' && typeof x.representation === 'function' ? x.representation() : x)).join(', ')}]`
    : String(p);

// (class, human risk label) for a field retype, from the source and target leaf types.
function classifyRetype(srcType, newType) {
    const vm = vecmatRetypeClass(srcType, newType);    // Vec/Mat element widen (A) / narrow (B) / refused
    if (vm !== null) return vm;
    const sc = srcType.typeCode(); const tc = newType.typeCode();
    if (sc === 'variant' && tc === 'variant') {        // arm-set change (arms compared by repr)
        const srcArms = new Set(V.TypeVariant.cast(srcType).types().map((a) => a.representation()));
        const tgtArms = new Set(V.TypeVariant.cast(newType).types().map((a) => a.representation()));
        const removed = [...srcArms].filter((a) => !tgtArms.has(a)).sort();
        if (removed.length) return ['B', `variant arm removal (${removed.join(', ')})`];
        return ['A', 'variant add/reorder arms (lossless)'];
    }
    if (sc === 'variant' || tc === 'variant') return ['refused', `${sc}→${tc} — a variant↔non-variant retype is not supported`];
    if (WIDENING.has(`${sc}>${tc}`)) return ['A', `widening ${sc}→${tc} (lossless)`];
    if (tc === 'string') return ['A', `${sc}→string (total)`];
    if (sc === 'set' && tc === 'vector') return ['A', 'Set→Vector (canonical total-order sequence, lossless)'];
    if (sc === 'vector' && tc === 'xarray') return ['A', 'Vector→XArray (order preserved, deterministic positions, lossless)'];
    if (sc === 'xarray' && tc === 'vector') return ['A', 'XArray→Vector (live elements in order, lossless)'];
    if (sc === 'optional' && tc !== 'optional') return ['B', 'unwrap Optional (nil has no image)'];
    if (tc === 'optional' && sc !== 'optional') return ['B', `wrap into Optional<${tc}>`];
    if (sc === 'string') return ['B', `parse string→${tc}`];
    if (FLOATS.has(sc) && INTS.has(tc)) return ['B', `float→int (${sc}→${tc}: fraction + NaN/inf/overflow loss)`];
    if (INTS.has(sc) && INTS.has(tc)) return ['B', `narrowing ${sc}→${tc} (overflow)`];
    if (FLOATS.has(sc) && FLOATS.has(tc)) return ['B', `float narrowing ${sc}→${tc} (precision)`];
    if (INTS.has(sc) && FLOATS.has(tc)) return ['B', `${sc}→${tc} (precision for large magnitudes)`];
    return ['B', `${sc}→${tc} (review)`];
}

// Classify every change `directives` would make to `sourceDefs`, from the schema alone. Returns
// { changes, warnings, summary } — plain data. No documents are read and no target is built.
export function plan(sourceDefs, directives) {
    const defs = constDefs(sourceDefs);
    const d = directives;
    const structs = Object.fromEntries(defs.structures().map((s) => [s.representation(), s]));
    const changes = []; const warnings = [];

    const add = (kind, site, detail, cls = 'A', loss = false, policy = null) =>
        changes.push({ kind, site, detail, class: cls, loss, policy });

    for (const [old, nw] of Object.entries(d.typeRenames)) add('rename_type', old, `→ ${nw}`);
    for (const [key, name] of Object.entries(d.namespaceNames)) add('rename_namespace', key, `→ name '${name}' (new representations, same ids)`);
    for (const key of Object.keys(d.namespaceUuids)) add('remap_namespace', key, '→ new UUID (re-id, same representations)');

    for (const [srep, fields] of Object.entries(d.fieldRenames))
        for (const [o, n] of Object.entries(fields)) add('rename_field', `${srep}.${o}`, `→ ${n}`);
    for (const srep of Object.keys(d.fieldOrder)) add('reorder_fields', srep, 'target field order set');
    for (const [srep, adds] of Object.entries(d.addedFields))
        for (const [name, payload, derive] of adds) {
            if (derive !== null && derive !== undefined)   // Class-C derived field (hook-computed)
                add('add_field', `${srep}.${name}`, `derived ${payload.representation()} (${derive.name || 'hook'})`, 'C', true);
            else
                add('add_field', `${srep}.${name}`, `seeded ${payload.type().representation()}`);
        }
    for (const [srep, drops] of Object.entries(d.droppedFields))
        for (const name of drops) add('drop_field', `${srep}.${name}`, 'field removed — its data is DROPPED', 'A', true);
    for (const [srep, retypes] of Object.entries(d.retypedFields)) {
        const st = structs[srep];
        for (const [fname, [newType, policy]] of Object.entries(retypes)) {
            const [cls, risk] = st !== undefined ? classifyRetype(st.check(fname).type(), newType) : ['B', 'retype (source struct not found)'];
            add('retype_field', `${srep}.${fname}`, risk, cls, cls === 'B', policy);
            if (cls === 'B' && policy === null) warnings.push(`missing policy — ${srep}.${fname}: ${risk} (Class B must decree a policy)`);
            if (cls === 'refused') warnings.push(`refused — ${srep}.${fname}: ${risk}`);
        }
    }
    for (const [srep, fields] of Object.entries(d.transformedFields))
        for (const [fname, [, fn]] of Object.entries(fields)) {
            add('transform_field', `${srep}.${fname}`, `custom transform (${fn.name || 'hook'})`, 'C', true);
            warnings.push(`custom transform — ${srep}.${fname}: a Class-C hook owns the loss model (the engine validates its output; it may drop the record)`);
        }
    if (Object.keys(d.transformedTypes).length) {
        const byRid = Object.fromEntries([...defs.concepts(), ...defs.clubs(), ...defs.enumerations(), ...defs.structures()]
            .map((t) => [t.runtimeId().representation(), t]));
        for (const [rid, [newType, fn]] of Object.entries(d.transformedTypes)) {
            const site = rid in byRid ? byRid[rid].representation() : rid;
            add('transform_type', site, `custom transform of EVERY occurrence → ${newType.representation()} (${fn.name || 'hook'})`, 'C', true);
            warnings.push(`custom transform — ${site}: a Class-C hook rewrites every occurrence of this type (author owns the loss model)`);
        }
    }

    for (const [srep, fields] of Object.entries(d.resizedFields)) {
        const st = structs[srep];
        for (const [fname, [kind, dims, fill, onShrink]] of Object.entries(fields)) {
            let shrinks = false;
            if (st !== undefined) {
                const t = st.check(fname).type();
                if (kind === 'vec' && t.typeCode() === 'vec') shrinks = V.TypeVec.cast(t).size() > dims[0];
                else if (kind === 'mat' && t.typeCode() === 'mat') { const m = V.TypeMat.cast(t); shrinks = m.columns() > dims[0] || m.rows() > dims[1]; }
            }
            if (shrinks) {                                 // drops trailing cells → Class B
                add('resize_field', `${srep}.${fname}`, `${kind} shrink (drops cells)`, 'B', true, onShrink);
                if (onShrink !== 'accept') warnings.push(`resize shrink — ${srep}.${fname}: drops cells; onShrink='accept' to allow (currently ${JSON.stringify(onShrink)})`);
            } else {                                        // grow / same → Class A, fill invented
                add('resize_field', `${srep}.${fname}`, `${kind} grow (fill=${fill})`, 'A');
            }
        }
    }
    for (const [srep, fset] of Object.entries(d.transposedFields))
        for (const fname of [...fset].sort()) add('transpose_field', `${srep}.${fname}`, 'Mat transpose [i,j]->[j,i] (lossless)', 'A');

    for (const [erep, cren] of Object.entries(d.caseRenames))
        for (const [o, n] of Object.entries(cren)) add('rename_case', `${erep}::${o}`, `→ ${n}`);
    for (const [erep, added] of Object.entries(d.addedCases))
        for (const name of added) add('add_case', `${erep}::${name}`, 'appended');
    for (const erep of Object.keys(d.caseOrder)) add('reorder_cases', erep, 'target case order set');
    for (const [erep, removed] of Object.entries(d.removedCases))
        for (const [caseName, policy] of Object.entries(removed)) {
            add('remove_case', `${erep}::${caseName}`, 'case removed — populated values need a policy', 'B', true, policy);
            if (policy === null) warnings.push(`missing policy — ${erep}::${caseName}: remove-case (Class B must decree a policy)`);
        }

    // a drop + an add in the same struct is a possible forgotten rename, which would silently
    // lose the dropped field's data. Surface it — the engine cannot know intent.
    for (const srep of Object.keys(d.droppedFields))
        if (srep in d.addedFields) {
            const dropped = [...d.droppedFields[srep]].sort();
            const added = d.addedFields[srep].map(([n]) => n).sort();
            warnings.push(`possible forgotten rename in ${srep}: dropped ${JSON.stringify(dropped)}, added ${JSON.stringify(added)} — a drop+add silently loses the old data; declare renameField if a rename was meant`);
        }

    // non-injective type mapping: two source named types landing in one target registry slot.
    // The runtime governs this (refuses the duplicate at build) but opaquely and late; surface
    // it early, as a warning. Advisory, not authoritative.
    const slots = new Map();
    for (const named of [...defs.concepts(), ...defs.clubs(), ...defs.enumerations(), ...defs.structures()]) {
        const full = named.representation();
        const simple = (d.typeRenames[full] ?? full).split('::').pop();
        const nsUuid = named.typeName().nameSpace().uuid().representation();
        const remapped = d.namespaceUuids[nsUuid];
        const slot = `${remapped !== undefined ? remapped.representation() : nsUuid} ${simple}`;
        if (slots.has(slot))
            warnings.push(`non-injective type mapping: '${full}' and '${slots.get(slot)}' both map to target '${simple}' in the same namespace — the runtime will refuse the duplicate at build (and a variant with both as arms would be illegal); give them distinct target names`);
        else slots.set(slot, full);
    }

    const summary = {
        changes: changes.length,
        class_a: changes.filter((c) => c.class === 'A').length,
        class_b: changes.filter((c) => c.class === 'B').length,
        class_c: changes.filter((c) => c.class === 'C').length,
        refused: changes.filter((c) => c.class === 'refused').length,
        lossy: changes.filter((c) => c.loss).length,
        warnings: warnings.length,
    };
    return { changes, warnings, summary };
}

// Render a `plan()` report as human-readable text (the operator's pre-flight view).
export function formatPlan(report) {
    const s = report.summary;
    const out = [`Migration plan — ${s.changes} changes: ${s.class_a} lossless (A), ${s.class_b} policied (B), ${s.class_c ?? 0} custom (C), ${s.refused} refused; ${s.lossy} lossy; ${s.warnings} warning(s).`];
    const tag = { A: 'A ', B: 'B!', C: 'C~', refused: 'XX' };
    for (const c of report.changes) {
        const loss = c.loss ? ' [LOSS]' : '';
        const pol = c.policy !== null && c.policy !== undefined ? `  policy=${fmtPolicy(c.policy)}` : (c.class === 'B' ? '  policy=REQUIRED' : '');
        out.push(`  [${tag[c.class]}] ${c.kind.padEnd(16)} ${c.site.padEnd(30)} ${c.detail}${loss}${pol}`);
    }
    if (report.warnings.length) {
        out.push('Warnings:');
        for (const w of report.warnings) out.push(`  ! ${w}`);
    }
    return out.join('\n');
}
