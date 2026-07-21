// Definitions-directed document rewriting — the engine. A 1:1 port of the Python engine.
//
// `DefinitionsRewriter.fromDirectives(sourceDefs, directives)` builds the target
// `Definitions` from source + the edit script, and rewrites any value from the source domain
// to the target domain with a single TARGET-DIRECTED engine (`value()`) that spans both
// families: family 1 — renames (size-preserving, ids follow); family 2 — shape changes (the
// walk is driven by the *target* type, with a decreed policy on every lossy op).
//
// It is a composition of already-bound runtime atoms — no C++. See REWRITE.md (Python repo)
// for the algorithm, the invariants, and where each is enforced.

import V from '../dsviper.mjs';

// How many parameters a hook declares — decides whether it gets the `ctx` (an extra trailing
// slot). A local hook stays clean; a non-local one opts in by declaring it.
const hookParamCount = (fn) => fn.length;

// Handed to a hook that declares a slot for it. Bundles the read-only source view
// (`attachmentGetting`, null unless a store loop wired one) and a re-entrant rewrite
// capability, for non-local (cross-document) Class-C derivation. The engine never fetches — it
// forwards this; the hook uses it. `rewrite(value, targetType, {followRefs})` applies the SAME
// migration to a fetched source value; `followRefs=false` (default) blanks the source view for
// the nested call, bounding depth and breaking any cross-document reference cycle.
class HookContext {
    constructor(rewriter) { this._rw = rewriter; }

    get hasSourceView() { return this._rw._sourceView !== null; }

    get attachmentGetting() {
        if (this._rw._sourceView === null)
            throw new Error('[hook] no source view is wired — this migration reads another '
                + 'document, but was run without one. Run it through migrateDatabase.migrate / '
                + 'dryRun (which wires the source), or guard with `ctx.hasSourceView`.');
        return this._rw._sourceView;
    }

    get hasSelfKey() { return this._rw._selfKey !== null; }

    // The SOURCE key of the document currently being rewritten — the record's own identity,
    // stable across the whole walk. Lets an aggregate hook match INCOMING references
    // (sum(order.amount where order.custRef == selfKey)). null (throws here) outside a store
    // loop, and inside a re-entrant ctx.rewrite (a fetched value has no well-defined self).
    get selfKey() {
        if (this._rw._selfKey === null)
            throw new Error('[hook] no self key is wired — either this migration was not run '
                + 'through a store loop (migrate / dryRun), or the hook fired inside a re-entrant '
                + 'ctx.rewrite (a fetched value has no self). Guard with `ctx.hasSelfKey`.');
        return this._rw._selfKey;
    }

    rewrite(value, targetType = undefined, { followRefs = false } = {}) {
        const rw = this._rw;
        if (followRefs) return rw.value(value, targetType);
        const savedView = rw._sourceView; const savedKey = rw._selfKey;
        rw._sourceView = null;
        rw._selfKey = null;                // a fetched value has no well-defined self identity
        try { return rw.value(value, targetType); }
        finally { rw._sourceView = savedView; rw._selfKey = savedKey; }
    }
}

// representationally-lossless leaf widenings — automatic (Class A)
export const WIDENING = new Set([
    'int8>int16', 'int8>int32', 'int8>int64', 'int16>int32', 'int16>int64', 'int32>int64',
    'int32>double', 'int16>double', 'int8>double',
    'uint8>uint16', 'uint8>uint32', 'uint8>uint64', 'uint16>uint32', 'uint16>uint64', 'uint32>uint64',
    'float>double',
]);
const PRIMITIVES = new Set(['void', 'bool', 'uint8', 'uint16', 'uint32', 'uint64',
    'int8', 'int16', 'int32', 'int64', 'float', 'double',
    'blob_id', 'commit_id', 'uuid', 'string', 'blob', 'vec', 'mat']);
export const INT_RANGE = {   // BigInt bounds (JS int64/uint64 are bigint)
    int8: [-128n, 127n], int16: [-32768n, 32767n],
    int32: [-2147483648n, 2147483647n], int64: [-(2n ** 63n), 2n ** 63n - 1n],
    uint8: [0n, 255n], uint16: [0n, 65535n], uint32: [0n, 4294967295n], uint64: [0n, 2n ** 64n - 1n],
};
const FLOATS = new Set(['float', 'double']);
// composite (non-scalar) kinds. A retype among these is expressed by a structural branch in
// `_retype`; one that reaches the scalar-leaf tail unhandled fails CLOSED (invariant #1) rather
// than crashing in the numeric path (which assumes a scalar operand).
const COMPOSITES = new Set(['struct', 'enum', 'concept', 'club', 'optional', 'vector', 'set',
    'map', 'xarray', 'tuple', 'variant', 'key', 'any']);
const IS64 = (tc) => tc === 'int64' || tc === 'uint64';
const coerce = (tc, n) => (IS64(tc) ? n : Number(n));          // bigint for 64-bit int, else number
// numeric native for a target leaf: a float/double target takes a JS number; an int target
// takes a bigint for 64-bit, else a number. (Widening a float→double must NOT go through BigInt.)
const numericNative = (tc, native) =>
    (tc === 'double' || tc === 'float') ? Number(native) : coerce(tc, BigInt(native));


// Classify a Vec/Mat field retype. Returns [class, detail] — 'A', 'B', or 'refused' — or null
// when neither side is Vec/Mat (an ordinary scalar/container retype). Three families: element
// conversion at fixed dims (widen A / narrow B), the Vector bridge (flatten Vec/Mat→Vector A,
// element type T preserved; Vector→Vec length-fit B; Vector→Mat refused), and refused (a bare
// dimension change, Vec↔Mat, or a bridge that also changes the element type).
export function vecmatRetypeClass(srcType, newType) {
    const sc = srcType.typeCode(); const tc = newType.typeCode();
    if (!['vec', 'mat'].includes(sc) && !['vec', 'mat'].includes(tc)) return null;

    // -- the Vector bridge: fixed <-> variable, element type T preserved --------
    if (['vec', 'mat'].includes(sc) && tc === 'vector') {          // flatten -> Vector (A)
        const se = (sc === 'vec' ? V.TypeVec.cast(srcType) : V.TypeMat.cast(srcType)).elementType();
        const te = V.TypeVector.cast(newType).elementType();
        if (se.representation() !== te.representation())
            return ['refused', `${sc}→Vector with an element-type change `
                + `(${se.representation()}→${te.representation()}) — a flatten preserves T; `
                + 'convert the element type at fixed shape instead'];
        const order = sc === 'mat' ? ' (column-major)' : '';
        return ['A', `${sc}→Vector flatten${order} (lossless — the fixed-size constraint is dropped)`];
    }
    if (sc === 'vector' && tc === 'mat')                           // un-flatten -> Mat (refused)
        return ['refused', 'Vector→Mat un-flatten — the length and the column-major/row-major '
            + 'layout are both ambiguous (the runtime itself rejects a flat Mat); build the '
            + 'columns explicitly, or route it through a reshape hook'];
    if (sc === 'vector' && tc === 'vec') {                         // length-fit -> Vec (B)
        const se = V.TypeVector.cast(srcType).elementType();
        const te = V.TypeVec.cast(newType).elementType();
        if (se.representation() !== te.representation())
            return ['refused', `Vector→Vec with an element-type change `
                + `(${se.representation()}→${te.representation()}) — a length-fit preserves T`];
        return ['B', 'Vector→Vec length-fit (the runtime length must equal the fixed size)'];
    }

    // -- same-kind element conversion, fixed dimensions -----------------------
    let se; let te;
    if (sc === 'vec' && tc === 'vec') {
        const sv = V.TypeVec.cast(srcType); const tv = V.TypeVec.cast(newType);
        if (sv.size() !== tv.size())
            return ['refused', `Vec size ${sv.size()}→${tv.size()} — a dimension change needs a `
                + 'resize directive (element widening/narrowing at fixed size is supported)'];
        se = sv.elementType().typeCode(); te = tv.elementType().typeCode();
    } else if (sc === 'mat' && tc === 'mat') {
        const sm = V.TypeMat.cast(srcType); const tm = V.TypeMat.cast(newType);
        if (sm.columns() !== tm.columns() || sm.rows() !== tm.rows())
            return ['refused', `Mat ${sm.columns()}×${sm.rows()}→${tm.columns()}×${tm.rows()} — a `
                + 'dimension change needs a resize/transpose directive'];
        se = sm.elementType().typeCode(); te = tm.elementType().typeCode();
    } else {
        return ['refused', `${sc}→${tc} — a Vec↔Mat / Vec↔scalar conversion is not supported`];
    }
    if (se === te) return ['A', `Vec/Mat identity (${se})`];
    if (WIDENING.has(`${se}>${te}`)) return ['A', `Vec/Mat element widening ${se}→${te} (lossless)`];
    return ['B', `Vec/Mat element narrowing ${se}→${te}`];
}


// Class of a same-container-kind element retype — set/vector/xarray/map whose element (and, for
// a map, key) type changes: widen / format / same-kind → 'A' (lossless), a narrowing element →
// 'B' (needs a policy). Recurses for nested containers; a map weighs both key and value (either
// narrowing => B). Returns 'A' / 'B', or null if not a same-kind container retype.
export function containerElementRetypeClass(srcType, newType) {
    const sc = srcType.typeCode(); const tc = newType.typeCode();
    if (sc !== tc || !['set', 'vector', 'xarray', 'map', 'optional', 'tuple'].includes(sc)) return null;

    const elemClass = (se, te) => {
        const nested = containerElementRetypeClass(se, te);        // nested container -> recurse
        if (nested !== null) return nested;
        const s = se.typeCode(); const t = te.typeCode();
        if (s === t || WIDENING.has(`${s}>${t}`) || t === 'string') return 'A';   // same / widen / format
        return 'B';                                                // a narrowing (or parse) leaf
    };

    if (sc === 'map') {
        const sm = V.TypeMap.cast(srcType); const tm = V.TypeMap.cast(newType);
        return [elemClass(sm.keyType(), tm.keyType()),
            elemClass(sm.elementType(), tm.elementType())].includes('B') ? 'B' : 'A';
    }
    if (sc === 'tuple') {                                          // fixed arity — classify every position
        const st = V.TypeTuple.cast(srcType).types(); const ts = V.TypeTuple.cast(newType).types();
        if (st.length !== ts.length) return null;                 // an arity change is a shape change, not this
        return st.some((a, i) => elemClass(a, ts[i]) === 'B') ? 'B' : 'A';
    }
    const getter = { set: V.TypeSet, vector: V.TypeVector, xarray: V.TypeXArray, optional: V.TypeOptional }[sc];
    return elemClass(getter.cast(srcType).elementType(), getter.cast(newType).elementType());
}


// The source value has no faithful image in the target domain — a nil that cannot be unwrapped,
// a string that will not parse, a populated case that was removed — and the decreed
// `drop-record` policy elects to elide rather than abort. Names the engine's condition: the
// Database loop catches it to skip the enclosing document; other consumers may dispose of it
// differently.
export class Unrepresentable extends Error {}

export const constDefs = (defs) => (typeof defs.const === 'function' ? defs.const() : defs);

// A short, serialisable rendering of a value for a diagnostic sample. Accepts a Value, a native
// scalar, or null (for an elided/absent image).
function sample(x) {
    if (x === null || x === undefined) return null;
    if (typeof x === 'string') return x;                          // an already-rendered marker
    if (typeof x === 'object' && typeof x.representation === 'function') return x.representation();
    return String(x);
}

// The native scalar of a leaf Value, or `x` itself if already native.
const nativeOf = (x) =>
    (x !== null && typeof x === 'object' && typeof x.representation === 'function') ? V.Value.dumps(x) : x;


export class DefinitionsRewriter {
    _commitIdRemap = null;       // { src commit repr -> new ValueCommitId }, set during a DAG replay
    _sink = null;                // diagnostic sink: called with a finding each time a Class-B policy
                                 // actually bites; null = no observation
    _sourceView = null;          // read-only source `AttachmentGetting` for non-local hooks (wired
                                 // by the store loop); null = no cross-document reads
    _selfKey = null;             // source key of the document being rewritten (record identity);
                                 // wired by the store loop per-document; null = no self identity

    constructor(sourceDefs, targetDefs, directives) {
        this.source = constDefs(sourceDefs);
        this.target = constDefs(targetDefs);
        this.d = directives;
        this.attMap = {};
        this._buildMaps();
        this._shapeGuard();
        this._policyCompleteness();
    }

    // -- build the target Definitions from source + directives, then wire the rewriter against
    //    it. Returns [rewriter, target].
    static fromDirectives(sourceDefs, directives) {
        const [target, tmap, attMap] = buildTargetDefinitions(sourceDefs, directives);
        const self = Object.create(DefinitionsRewriter.prototype);
        // Object.create bypasses the constructor, so the class-field defaults do not run — set
        // the runtime channels explicitly (Python inherits them as class attributes).
        self._commitIdRemap = null; self._sink = null; self._sourceView = null; self._selfKey = null;
        self.source = constDefs(sourceDefs);
        self.target = target.const();
        self.d = directives;
        self.typeMap = { ...tmap };        // src rid repr -> target named Type
        self.attMap = { ...attMap };       // src attachment rid repr -> target Attachment
        // No shape guard here: the target was BUILT from the directives, consistent by
        // construction. But Class-B policies are still required.
        self._policyCompleteness();
        return [self, target];
    }

    // -- notify the diagnostic sink that a Class-B policy governed an OFFENDER. Exact conversions
    //    never emit — they are lossless by contract. Cheap no-op when unobserved.
    _emit(op, site, policy, before, after) {
        if (this._sink === null) return;
        this._sink({ site, op, policy, before: sample(before), after: sample(after) });
    }

    // -- extend a diagnostic site path only while observing (keeps the migrate hot path free of
    //    string building).
    _sub(site, suffix) {
        return (this._sink !== null && site !== null && site !== undefined) ? `${site}${suffix}` : site;
    }

    // -- id map M (name-matching + rename directives), keyed by source rid repr
    _buildMaps() {
        this.typeMap = {};
        const groups = [
            [this.source.concepts(), this.target.concepts()],
            [this.source.clubs(), this.target.clubs()],
            [this.source.enumerations(), this.target.enumerations()],
            [this.source.structures(), this.target.structures()],
        ];
        for (const [srcList, tgtList] of groups) {
            const tgtByName = Object.fromEntries(tgtList.map((t) => [t.representation(), t]));
            for (const s of srcList) {
                const tgtName = this.d.typeRenames[s.representation()] ?? s.representation();
                if (!(tgtName in tgtByName))                   // (P1) name completeness
                    throw new Error(`[P1] no target for ${s.representation()} -> ${tgtName}`);
                this.typeMap[s.runtimeId().representation()] = tgtByName[tgtName];
            }
        }
    }

    _mapNamed(t) { return this.typeMap[t.runtimeId().representation()]; }

    // -- arms of the SOURCE variant (mapped to the target domain) absent from the TARGET variant
    //    — i.e. removed. Membership by runtimeId. Returns the removed arms' reprs.
    _variantRemovedArms(srcType, newType) {
        const tgtIds = new Set(V.TypeVariant.cast(newType).types().map((a) => a.runtimeId().representation()));
        return V.TypeVariant.cast(srcType).types()
            .filter((a) => !tgtIds.has(this.mapType(a).runtimeId().representation()))
            .map((a) => a.representation());
    }

    // -- (P2) shape invariance: every matched pair identical up to renames
    _shapeGuard() {
        for (const s of this.source.structures()) {
            const tgt = this._mapNamed(s);
            const fren = this.d.fieldRenames[s.representation()] ?? {};
            const srcFields = s.fields();
            const tgtNames = tgt.fields().map((f) => f.name());
            if (srcFields.length !== tgtNames.length)
                throw new Error(`[P2] field count differs for ${s.representation()} — that is a family-2 shape change, not a rename`);
            srcFields.forEach((f, i) => {
                const expected = fren[f.name()] ?? f.name();
                if (tgtNames[i] !== expected)
                    throw new Error(`[P2] field #${i} of ${s.representation()}: expected '${expected}', target has '${tgtNames[i]}' — reorder/retype is family 2`);
            });
        }
        for (const s of this.source.enumerations()) {
            const tgt = this._mapNamed(s);
            const cren = this.d.caseRenames[s.representation()] ?? {};
            const srcCases = s.cases().map((c) => c.name());
            const tgtCases = tgt.cases().map((c) => c.name());
            if (srcCases.length !== tgtCases.length)
                throw new Error(`[P2] case count differs for ${s.representation()}`);
            srcCases.forEach((c, i) => {
                const expected = cren[c] ?? c;
                if (tgtCases[i] !== expected)
                    throw new Error(`[P2] case #${i} of ${s.representation()}: expected '${expected}', target '${tgtCases[i]}'`);
            });
        }
    }

    // -- (policy-completeness) refuse a lossy retype / removed case with no policy, at
    //    construction — before any data is touched.
    _policyCompleteness() {
        for (const s of this.source.structures()) {
            const retypes = this.d.retypedFields[s.representation()] ?? {};
            for (const [fname, [newType, policy]] of Object.entries(retypes)) {
                const srcType = s.check(fname).type();
                const sc = srcType.typeCode();
                const tc = newType.typeCode();
                const vm = vecmatRetypeClass(srcType, newType);        // Vec/Mat element retype?
                if (vm !== null) {
                    const [kind, detail] = vm;
                    if (kind === 'refused')
                        throw new Error(`[unsupported] ${s.representation()}.${fname}: ${detail}`);
                    if (kind === 'B' && policy === null)
                        throw new Error(`[policy-completeness] ${detail} on ${s.representation()}.${fname} needs a decreed policy`);
                    continue;                                          // element widen (A) / policied narrow (B)
                }
                const ce = containerElementRetypeClass(srcType, newType);   // container element retype?
                if (ce !== null) {
                    if (ce === 'B' && policy === null)
                        throw new Error(`[policy-completeness] ${sc}->${tc} element narrowing on ${s.representation()}.${fname} needs a decreed policy`);
                    continue;
                }
                if (sc === 'variant' || tc === 'variant') {            // variant arm-set change
                    if (sc !== 'variant' || tc !== 'variant')
                        throw new Error(`[unsupported] ${s.representation()}.${fname}: ${sc}->${tc} — a variant<->non-variant retype is not supported`);
                    const removed = this._variantRemovedArms(srcType, newType);
                    if (removed.length && policy === null)
                        throw new Error(`[policy-completeness] variant arm removal (${removed.join(', ')}) on ${s.representation()}.${fname} needs a decreed policy — a value on a removed arm has no target image`);
                    continue;                                          // add/reorder (A) / removal (B)
                }
                const classA = WIDENING.has(`${sc}>${tc}`) || tc === 'string'
                    || (sc === 'set' && tc === 'vector')
                    || (sc === 'vector' && tc === 'xarray')
                    || (sc === 'xarray' && tc === 'vector');
                if (!classA && policy === null)
                    throw new Error(`[policy-completeness] ${sc}->${tc} on ${s.representation()}.${fname} needs a decreed policy`);
            }
        }
        for (const e of this.source.enumerations()) {
            for (const [caseName, policy] of Object.entries(this.d.removedCases[e.representation()] ?? {}))
                if (policy === null)
                    throw new Error(`[policy-completeness] removed case ${e.representation()}.${caseName} needs a decreed policy`);
        }
        validateDimensionOps(this.source, this.d);   // resize/transpose: direct-Vec/Mat + fill
    }

    // -- type => type
    mapType(t) {
        const th = this.d.transformedTypes[t.runtimeId().representation()];
        if (th !== undefined) return this.mapType(th[0]);          // global hook: this type maps to newType
        const tc = t.typeCode();
        if (['struct', 'enum', 'concept', 'club'].includes(tc)) return this._mapNamed(t);
        if (tc === 'optional') return new V.TypeOptional(this.mapType(V.TypeOptional.cast(t).elementType()));
        if (tc === 'vector') return new V.TypeVector(this.mapType(V.TypeVector.cast(t).elementType()));
        if (tc === 'set') return new V.TypeSet(this.mapType(V.TypeSet.cast(t).elementType()));
        if (tc === 'map') { const m = V.TypeMap.cast(t); return new V.TypeMap(this.mapType(m.keyType()), this.mapType(m.elementType())); }
        if (tc === 'xarray') return new V.TypeXArray(this.mapType(V.TypeXArray.cast(t).elementType()));
        if (tc === 'tuple') return new V.TypeTuple(V.TypeTuple.cast(t).types().map((x) => this.mapType(x)));
        if (tc === 'variant') return new V.TypeVariant(V.TypeVariant.cast(t).types().map((x) => this.mapType(x)));
        if (tc === 'key') return new V.TypeKey(this.mapType(V.TypeKey.cast(t).elementType()));
        return t;                        // primitives, Any, Vec, Mat, AnyConcept
    }

    // -- convert one container element to the target element type `te`. A differing-kind leaf,
    //    or a nested container whose type changed, goes through the policy-governed `_retype`;
    //    a same-kind composite or an identical type recurses via `value`.
    _retypeElement(elem, te, policy, esite) {
        if (elem.typeCode() !== te.typeCode()) return this._retype(elem, te, policy, esite);
        if (['set', 'vector', 'xarray', 'map', 'vec', 'mat', 'optional', 'tuple'].includes(te.typeCode())
            && elem.type().runtimeId().representation() !== te.runtimeId().representation())
            return this._retype(elem, te, policy, esite);
        return this.value(elem, te, esite);
    }

    // -- add a converted element to a target set, guarding a non-injective collapse (two source
    //    elements mapping to one member) under collisionPolicy — shared by `value` and `_retype`.
    _setAdd(out, ne, site) {
        if (out.contains(ne)) {                                    // Class B: element collapse
            if (this.d.collisionPolicy === 'fail')
                throw new Error(`[Class-B] set element collapse: ${ne.representation()} — a non-injective element migration would silently drop a member; decree resolveCollisions('first'|'last')`);
            this._emit('set-collapse', site, this.d.collisionPolicy, ne, null);
            return;                                                // first/last both = collapse to one
        }
        out.add(ne);
    }

    // -- set a converted (key, value) into a target map, guarding a key collision under
    //    collisionPolicy. Shared by `value` and `_retype`.
    _mapSet(out, nk, nv, site) {
        if (out.contains(nk)) {                                    // Class B: key collision
            const pol = this.d.collisionPolicy;
            if (pol === 'last') { this._emit('map-collision', site, pol, out.at(nk, false), nv); out.set(nk, nv); }
            else if (pol === 'first') { this._emit('map-collision', site, pol, nv, null); }
            else throw new Error(`[Class-B] map key collision: ${nk.representation()}`);
        } else {
            out.set(nk, nv);
        }
    }

    // -- the SINGLE container/holder traversal — the one place that knows the container/holder
    //    kinds (optional / vector / set / map / xarray / tuple). Rebuilds `tt` by applying
    //    `elemFn(element, elementType, site) -> converted` to each element. `elemFn` is either
    //    `value`'s type-preserving recurse or `_retype`'s policied `_retypeElement`; sharing one
    //    loop keeps the two from drifting (the very drift that opened the earlier Optional/Tuple
    //    gap — value() had them, _retype()'s hand-kept copy did not). Set-collapse / map-collision
    //    are guarded here, uniformly for both callers. Returns null if `tt` is not one of the six
    //    (the caller handles struct / key / any / enum / variant / commit_id / leaf). Vec/Mat are
    //    NOT here (numeric, cell-addressed, retype-only) nor is variant (arm-set semantics).
    _mapElements(v, tt, elemFn, site) {
        const tc = tt.typeCode();
        if (tc === 'optional') {
            const vo = V.ValueOptional.cast(v);
            if (vo.isNil()) return new V.ValueOptional(tt);
            const et = V.TypeOptional.cast(tt).elementType();
            return new V.ValueOptional(tt, elemFn(vo.unwrap(false), et, site));
        }
        if (tc === 'vector') {
            const vv = V.ValueVector.cast(v);
            const et = V.TypeVector.cast(tt).elementType();
            const out = new V.ValueVector(tt);
            const esite = this._sub(site, '[]');
            for (let i = 0; i < vv.size(); i++) out.append(elemFn(vv.at(i, false), et, esite));
            return out;
        }
        if (tc === 'set') {
            const vs = V.ValueSet.cast(v);
            const et = V.TypeSet.cast(tt).elementType();
            const out = new V.ValueSet(tt);
            const esite = this._sub(site, '{}');
            for (let i = 0; i < vs.size(); i++) this._setAdd(out, elemFn(vs.at(i, false), et, esite), site);
            return out;
        }
        if (tc === 'map') {
            const mt = V.TypeMap.cast(tt); const kt = mt.keyType(); const et = mt.elementType();
            const vm = V.ValueMap.cast(v);
            const out = new V.ValueMap(tt);
            const ksite = this._sub(site, '<key>'); const vsite = this._sub(site, '<val>');
            for (const [k, val] of vm.items(false))
                this._mapSet(out, elemFn(k, kt, ksite), elemFn(val, et, vsite), site);
            return out;
        }
        if (tc === 'xarray') {
            // ATOMIC: the source layout (positions + tombstones) is copied opaquely inside
            // rebuildFrom, and the re-mapped elements are installed in the SAME step.
            const vx = V.ValueXArray.cast(v);
            const et = V.TypeXArray.cast(tt).elementType();
            const esite = this._sub(site, '[]');
            const out = new V.ValueXArray(tt);
            out.rebuildFrom(vx, vx.items(false).map(([pos, val]) => [pos, elemFn(val, et, esite)]));
            return out;
        }
        if (tc === 'tuple') {
            const vt = V.ValueTuple.cast(v);
            const ets = V.TypeTuple.cast(tt).types();
            if (vt.size() !== ets.length)                             // a tuple conversion is per-position;
                throw new Error(`[unsupported] tuple arity change ${vt.size()}->${ets.length} — a tuple conversion must preserve arity (it is a per-position element conversion)`);
            const parts = [];
            for (let i = 0; i < vt.size(); i++) parts.push(elemFn(vt.at(i, false), ets[i], this._sub(site, `.${i}`)));
            return new V.ValueTuple(tt, parts);
        }
        return null;
    }

    // -- retype dispatcher: structural (unwrap, Vector<->Set, the Vector bridge, variant arm-set,
    //    Vec/Mat element, container element) + leaf (widen/narrow/format/parse). Class A converts
    //    automatically; Class B consults the policy ONLY on the offending value.
    _retype(sv, tt, policy, site = null) {
        const sc = sv.typeCode(); const tc = tt.typeCode();

        // -- structural
        if (sc === 'optional' && tc !== 'optional') {                 // unwrap Optional<A> -> A
            const vo = V.ValueOptional.cast(sv);
            if (vo.isNil()) return this._onMissing(tt, policy, 'nil-unwrap', site, 'nil');
            // The unwrapped value may itself need a POLICY-GOVERNED leaf conversion; route a
            // differing leaf back through _retype so the policy governs it too. Same typeCode =>
            // plain rewrite / composite recursion via value().
            const inner = vo.unwrap(false);
            if (inner.typeCode() === tc) return this.value(inner, tt, site);
            return this._retype(inner, tt, policy, site);
        }
        if (sc === 'vector' && tc === 'set') {                        // Vector -> Set (collapse: the
            const et = V.TypeSet.cast(tt).elementType();              // set dedups silently — that is
            const out = new V.ValueSet(tt); const vv = V.ValueVector.cast(sv);   // the point of the shape
            const esite = this._sub(site, '[]');                     // change; the policy only gated
            for (let i = 0; i < vv.size(); i++) out.add(this.value(vv.at(i, false), et, esite));   // completeness)
            return out;
        }
        if (sc === 'set' && tc === 'vector') {                        // Set -> Vector (Class A)
            const et = V.TypeVector.cast(tt).elementType();
            const out = new V.ValueVector(tt); const vs = V.ValueSet.cast(sv);
            const esite = this._sub(site, '{}');
            for (let i = 0; i < vs.size(); i++) out.append(this.value(vs.at(i, false), et, esite));
            return out;
        }
        if (sc === 'vector' && tc === 'xarray') {                     // Vector -> XArray (Class A)
            const et = V.TypeXArray.cast(tt).elementType();
            const out = new V.ValueXArray(tt); const vv = V.ValueVector.cast(sv);
            const esite = this._sub(site, '[]');
            for (let i = 0; i < vv.size(); i++) {                      // DETERMINISTIC index-derived
                const pos = new V.ValueUUId(`00000001-0000-0000-0000-${i.toString(16).padStart(12, '0')}`);
                out.insert(V.ValueXArray.END, this.value(vv.at(i, false), et, esite), pos);   // positions
            }
            return out;
        }
        if (sc === 'xarray' && tc === 'vector')                       // XArray -> Vector (Class A)
            return this.value(V.ValueXArray.cast(sv).toVector(), tt, site);

        if (['vec', 'mat'].includes(sc) && tc === 'vector') {         // Vec/Mat -> Vector (Class A): flatten
            const out = new V.ValueVector(tt);
            if (sc === 'vec') {
                const vv = V.ValueVec.cast(sv);
                for (let i = 0; i < vv.size(); i++) out.append(vv.at(i, false));
            } else {                                                  // Mat flattens COLUMN-MAJOR
                const vm = V.ValueMat.cast(sv); const sm = V.TypeMat.cast(sv.type());
                for (let c = 0; c < sm.columns(); c++)
                    for (let r = 0; r < sm.rows(); r++) out.append(vm.at(c, r, false));
            }
            return out;
        }
        if (sc === 'vector' && tc === 'vec') {                        // Vector -> Vec (Class B): length-fit
            const n = V.TypeVec.cast(tt).size(); const vv = V.ValueVector.cast(sv);
            const elems = [];
            for (let i = 0; i < vv.size(); i++) elems.push(vv.at(i, true));   // natives for the ValueVec ctor
            if (elems.length === n) return new V.ValueVec(tt, elems);         // exact length -> lossless
            const op = `Vector→Vec length ${elems.length}→${n}`;
            if (policy === null || policy === 'fail')
                throw new Error(`[Class-B] Vector→Vec length ${elems.length} != fixed size ${n}; decree a policy`);
            if (policy === 'drop-record') { this._emit(op, site, policy, elems.length, null); throw new Unrepresentable('length-fit'); }
            if (Array.isArray(policy) && policy[0] === 'fit') {       // truncate the tail / pad the fill
                const fitted = elems.slice(0, n);
                while (fitted.length < n) fitted.push(nativeOf(policy[1]));
                this._emit(op, site, policy, elems.length, n);
                return new V.ValueVec(tt, fitted);
            }
            throw new Error(`unknown policy ${JSON.stringify(policy)} for Vector→Vec`);
        }

        if (sc === 'variant' && tc === 'variant') {                   // variant arm-set change
            const vv = V.ValueVariant.cast(sv);
            const inner = this.value(vv.unwrap(false), undefined, site);   // map the concrete arm value
            const tgtIds = new Set(V.TypeVariant.cast(tt).types().map((a) => a.runtimeId().representation()));
            if (tgtIds.has(inner.type().runtimeId().representation())) {    // arm survives (add / reorder)
                const out = new V.ValueVariant(tt);                        // re-wrap BY TYPE — index-safe
                out.wrap(inner, inner.type());
                return out;
            }
            const op = `variant arm removed: ${inner.type().representation()}`;   // value on a removed arm (B)
            if (policy === null || policy === 'fail')
                throw new Error(`[Class-B] variant value on a removed arm ${inner.type().representation()}; decree a policy`);
            if (policy === 'drop-record') { this._emit(op, site, policy, inner, null); throw new Unrepresentable('variant-arm-removed'); }
            if (Array.isArray(policy) && policy[0] === 'default') { this._emit(op, site, policy, inner, policy[1]); return policy[1]; }
            throw new Error(`unknown policy ${JSON.stringify(policy)} for variant arm removal`);
        }

        if (sc === 'vec' && tc === 'vec') {                           // Vec<T,n> -> Vec<T',n>: element
            const te = V.TypeVec.cast(tt).elementType();              // widen (A) / narrow (B), fixed size.
            const vv = V.ValueVec.cast(sv); const out = new V.ValueVec(tt);
            const n = V.TypeVec.cast(tt).size();
            for (let i = 0; i < n; i++) {
                const conv = this._retype(vv.at(i, false), te, policy, this._sub(site, `[${i}]`));
                out.set(i, V.Value.dumps(conv));
            }
            return out;
        }
        if (sc === 'mat' && tc === 'mat') {                           // Mat<T,c,r> -> Mat<T',c,r>: element
            const tm = V.TypeMat.cast(tt); const te = tm.elementType();
            const vm = V.ValueMat.cast(sv); const out = new V.ValueMat(tt);
            for (let c = 0; c < tm.columns(); c++)
                for (let r = 0; r < tm.rows(); r++) {
                    const conv = this._retype(vm.at(c, r, false), te, policy, this._sub(site, `[${c},${r}]`));
                    out.set(c, r, V.Value.dumps(conv));
                }
            return out;
        }

        // Same-kind container / holder element retype (optional / vector / set / map / xarray /
        // tuple; element widen A / narrow B) — the retype twin of value()'s traversal, through the
        // SAME `_mapElements` loop, so the two can never drift (the drift that opened the earlier
        // Optional/Tuple gap). Each element rides `_retypeElement` (the policy-governed leaf path);
        // the container shape is preserved. A same-shape narrow that collides two elements is the
        // Class-B non-injective loss `_setAdd` / `_mapSet` guard. Guarded `sc === tc`: a cross-kind
        // pair (all bridged above) must NOT reach `_mapElements`, which dispatches on the target.
        if (sc === tc) {
            const mapped = this._mapElements(
                sv, tt, (e, et, s) => this._retypeElement(e, et, policy, s), site);
            if (mapped !== null) return mapped;
        }

        // -- leaf: a scalar<->scalar conversion from here on. Any COMPOSITE reaching this point has no
        //    conversion branch above — fail CLOSED (invariant #1), never the numeric tail's crash on a
        //    composite operand. Such a retype (struct<->struct, enum<->enum, key<->key, …) needs a hook.
        if (COMPOSITES.has(sc) || COMPOSITES.has(tc))
            throw new Error(`[unsupported] retype ${sc}->${tc}: no conversion branch for this composite retype — use a transformField / transformType hook, or an explicit directive; the engine will not guess a composite mapping`);
        if (WIDENING.has(`${sc}>${tc}`))
            return V.Value.create(tt, numericNative(tc, V.Value.dumps(sv)));   // A: widen (lossless)
        if (tc === 'string') return new V.ValueString(String(V.Value.dumps(sv)));    // A: format (total)
        if (sc === 'string') return this._parse(sv, tt, policy, site);               // B: parse
        const native = V.Value.dumps(sv);                                            // numeric narrowing
        const [lo, hi] = INT_RANGE[tc] ?? [null, null];
        if (FLOATS.has(sc) && (tc in INT_RANGE)) return this._floatToInt(Number(native), tt, lo, hi, policy, site);
        if (lo !== null) {
            const n = BigInt(native);
            if (lo <= n && n <= hi) return V.Value.create(tt, coerce(tc, n));         // in range -> exact
            if (policy === null || policy === 'fail')
                throw new Error(`[Class-B] ${sc}->${tc} out of range: ${n}`);
            const op = `narrow ${sc}→${tc}`;
            if (policy === 'saturate') {
                const clamped = n < lo ? lo : (n > hi ? hi : n);
                this._emit(op, site, policy, n, clamped);
                return V.Value.create(tt, coerce(tc, clamped));
            }
            if (Array.isArray(policy) && policy[0] === 'default') { this._emit(op, site, policy, n, policy[1]); return policy[1]; }
            throw new Error(`unknown policy ${JSON.stringify(policy)}`);
        }
        if (policy === null || policy === 'fail') throw new Error(`[Class-B] ${sc}->${tc} unsupported`);
        if (Array.isArray(policy) && policy[0] === 'default') return policy[1];
        throw new Error(`unknown policy ${JSON.stringify(policy)}`);
    }

    // float -> int (Class B). Truncate toward zero, then the decreed policy governs the offenders:
    // a finite value out of range, or a non-finite one (NaN / +-inf) which has no int image at all.
    _floatToInt(native, tt, lo, hi, policy, site = null) {
        const tcn = tt.typeCode();
        if (Number.isFinite(native)) {
            const truncated = Math.trunc(native);
            const bt = BigInt(truncated);
            if (lo <= bt && bt <= hi) {
                if (native !== truncated) this._emit(`float→${tcn} truncate`, site, policy, native, truncated);
                return V.Value.create(tt, coerce(tcn, bt));        // in range after truncation
            }
        }
        const op = `float→${tcn} edge`;                            // non-finite / out of range
        if (policy === null || policy === 'fail')
            throw new Error(`[Class-B] float→${tcn}: ${native} has no in-range int image (fraction / overflow / non-finite); decree a policy`);
        if (policy === 'saturate') {
            let clamped;
            if (native === Infinity) clamped = hi;
            else if (!Number.isFinite(native)) clamped = lo;        // NaN, -inf -> lo
            else { const bt = BigInt(Math.trunc(native)); clamped = bt < lo ? lo : (bt > hi ? hi : bt); }
            this._emit(op, site, policy, native, clamped);
            return V.Value.create(tt, coerce(tcn, clamped));
        }
        if (Array.isArray(policy) && policy[0] === 'default') { this._emit(op, site, policy, native, policy[1]); return policy[1]; }
        if (policy === 'drop-record') { this._emit(op, site, policy, native, null); throw new Unrepresentable('float-narrow'); }
        throw new Error(`unknown policy ${JSON.stringify(policy)} for float→int`);
    }

    _onMissing(tt, policy, kind, site = null, before = null) {      // nil-unwrap / parse-fail
        if (policy === null || policy === 'fail') throw new Error(`[Class-B] ${kind}: absent value; decree a policy`);
        if (policy === 'drop-record') { this._emit(kind, site, policy, before, null); throw new Unrepresentable(kind); }
        if (Array.isArray(policy) && policy[0] === 'default') { this._emit(kind, site, policy, before, policy[1]); return policy[1]; }
        throw new Error(`unknown policy ${JSON.stringify(policy)}`);
    }

    _parse(sv, tt, policy, site = null) {
        const s = V.Value.dumps(sv); const tc = tt.typeCode();
        try {
            if (tc in INT_RANGE) {
                const n = BigInt(s);                                 // throws on non-integer text
                const [lo, hi] = INT_RANGE[tc];
                if (!(lo <= n && n <= hi)) throw new Error('range');
                return V.Value.create(tt, coerce(tc, n));            // parseable -> exact (no loss)
            }
            const f = Number(s);
            if (Number.isNaN(f) && String(s).trim().toLowerCase() !== 'nan') throw new Error('parse');
            return V.Value.create(tt, f);
        } catch {
            return this._onMissing(tt, policy, `parse→${tc}`, site, s);
        }
    }

    // -- Vec/Mat DIMENSION transforms (family 2). Position-preserving: cell [i]/[i,j] keeps its
    //    coordinates. Grow fills the new cells; shrink drops the trailing ones. No flatten — no
    //    layout ambiguity; column-major is preserved throughout.
    _shrinkLoss(onShrink, site, before, after) {
        if (onShrink === 'fail')
            throw new Error(`[Class-B] resize would drop cells (${before} → ${after}); pass onShrink='accept' to keep the fit and discard the trailing cells`);
        if (onShrink === 'accept') { this._emit('resize-shrink', site, onShrink, before, after); return; }
        throw new Error(`unknown onShrink ${JSON.stringify(onShrink)}`);
    }

    _resize(sv, tt, spec, site = null) {
        const [kind, , fill, onShrink] = spec;
        if (kind === 'vec') {
            const svv = V.ValueVec.cast(sv);
            const sn = svv.size(); const n = V.TypeVec.cast(tt).size();
            if (sn > n) this._shrinkLoss(onShrink, site, sn, n);      // shrink: the tail is dropped (raises on 'fail')
            const out = new V.ValueVec(tt);                          // inits to the type's zero
            for (let i = 0; i < Math.min(sn, n); i++) out.set(i, svv.at(i, true));   // preserve the overlap
            if (n > sn && fill !== 'zero') for (let i = sn; i < n; i++) out.set(i, nativeOf(fill));
            return out;
        }
        const svm = V.ValueMat.cast(sv); const smt = V.TypeMat.cast(sv.type());   // kind == 'mat'
        const sc = smt.columns(); const sr = smt.rows();
        const tmt = V.TypeMat.cast(tt); const tc = tmt.columns(); const tr = tmt.rows();
        if (sc > tc || sr > tr) this._shrinkLoss(onShrink, site, `${sc}×${sr}`, `${tc}×${tr}`);
        const out = new V.ValueMat(tt);                              // inits to IDENTITY
        for (let c = 0; c < Math.min(sc, tc); c++)                   // preserve the source block; new
            for (let r = 0; r < Math.min(sr, tr); r++) out.set(c, r, svm.at(c, r, true));   // cells keep identity
        if (fill !== 'identity') {                                   // 'zero' / scalar: overwrite the
            const fv = fill === 'zero' ? 0 : nativeOf(fill);         // cells outside the source block
            for (let c = 0; c < tc; c++)
                for (let r = 0; r < tr; r++) if (c >= sc || r >= sr) out.set(c, r, fv);
        }
        return out;
    }

    _transpose(sv, tt) {
        const svm = V.ValueMat.cast(sv); const smt = V.TypeMat.cast(sv.type());
        const out = new V.ValueMat(tt);                              // tt is Mat<r,c> (derived)
        for (let c = 0; c < smt.columns(); c++)
            for (let r = 0; r < smt.rows(); r++) out.set(r, c, svm.at(c, r, true));   // [c,r] -> [r,c]
        return out;
    }

    // -- Class-C hooks. The VALIDATION is where total-or-explicit-refusal survives user code: the
    //    hook returns a valid target value (used), throws Unrepresentable (drop), or throws
    //    (refuse) — anything not a value of `targetType` is refused.
    _validateHookOutput(result, targetType) {
        if (!(result !== null && typeof result === 'object' && typeof result.type === 'function'))
            throw new Error(`[hook] transform must return a Value, got ${result === null ? 'null' : typeof result}`);
        if (result.type().runtimeId().representation() !== targetType.runtimeId().representation())
            throw new Error(`[hook] transform returned ${result.type().representation()}, expected ${targetType.representation()}`);
    }

    _applyValueHook(fn, value, targetType, site) {                   // transform_type (value-scoped)
        const result = hookParamCount(fn) >= 3
            ? fn(value, targetType, new HookContext(this))           // opts into the non-local ctx
            : fn(value, targetType);                                 // user code; may throw Unrepresentable
        this._validateHookOutput(result, targetType);
        this._emit('transform', site, fn.name || 'hook', value, result);
        return result;
    }

    _applyFieldHook(fn, sourceStruct, fieldName, targetType, site) {   // struct-scoped
        const result = hookParamCount(fn) >= 4
            ? fn(sourceStruct, fieldName, targetType, new HookContext(this))   // opts into the non-local ctx
            : fn(sourceStruct, fieldName, targetType);               // sees the struct (siblings) + field name
        this._validateHookOutput(result, targetType);
        let before;
        try { before = sourceStruct.at(fieldName, false); }         // the old field value, if any
        catch { before = null; }                                    // a new / derived field has none
        this._emit('transform', site, fn.name || 'hook', before, result);
        return result;
    }

    // -- target field name -> source field name (via renames), or null if added
    _fieldSource(src, tgt) {
        const fren = this.d.fieldRenames[src.representation()] ?? {};
        const tgtToSrc = Object.fromEntries(Object.entries(fren).map(([s, t]) => [t, s]));
        const srcNames = new Set(src.fields().map((f) => f.name()));
        const out = {};
        for (const f of tgt.fields()) {
            const n = f.name();
            out[n] = n in tgtToSrc ? tgtToSrc[n] : (srcNames.has(n) ? n : null);
        }
        return out;
    }

    // -- value => value, TARGET-DIRECTED. `tt` = the target type (derived if undefined).
    value(v, tt = undefined, site = null) {
        if (tt === undefined) tt = this.mapType(v.type());
        // global Class-C hook: any node whose SOURCE type is transformType'd (a field-level
        // transformField on the same position wins — applied in the struct branch, which never
        // recurses here for that field). Rides the recursion -> reaches nested occurrences.
        const th = this.d.transformedTypes[v.type().runtimeId().representation()];
        if (th !== undefined) return this._applyValueHook(th[1], v, tt, site);
        const tc = v.typeCode();
        const obs = this._sink !== null;

        if (tc === 'struct') {
            const vs = V.ValueStructure.cast(v);
            const src = vs.typeStructure(); const srep = src.representation();
            const tgt = V.TypeStructure.cast(tt);
            const fsrc = this._fieldSource(src, tgt);
            const retypes = this.d.retypedFields[srep] ?? {};
            const resized = this.d.resizedFields[srep] ?? {};
            const transposed = this.d.transposedFields[srep] ?? new Set();
            const transformed = this.d.transformedFields[srep] ?? {};
            const adds = {};                                         // target name -> [default | Type, derive?]
            for (const [name, payload, derive] of (this.d.addedFields[srep] ?? [])) adds[name] = [payload, derive];
            const out = {};
            for (const f of tgt.fields()) {
                const sn = fsrc[f.name()];
                if (sn === null) {                                    // added / derived field
                    const [payload, derive] = adds[f.name()] ?? [null, null];
                    if (derive !== null && derive !== undefined) {    // Class-C: derived from the struct
                        out[f.name()] = this._applyFieldHook(derive, vs, f.name(), f.type(), obs ? `${srep}.${f.name()}` : null);
                    } else {                                          // static seed value (NOT defaultValue():
                        out[f.name()] = (payload !== null && payload !== undefined) ? payload : f.defaultValue();
                    }
                } else if (sn in transformed) {                       // Class-C field hook (sees the struct)
                    const fn = transformed[sn][1];
                    out[f.name()] = this._applyFieldHook(fn, vs, sn, f.type(), obs ? `${srep}.${sn}` : null);
                } else if (sn in resized) {                           // family 2: Vec/Mat resize
                    out[f.name()] = this._resize(vs.at(sn, false), f.type(), resized[sn], obs ? `${srep}.${sn}` : null);
                } else if (transposed.has(sn)) {                      // family 2: Mat transpose
                    out[f.name()] = this._transpose(vs.at(sn, false), f.type());
                } else if (sn in retypes) {                           // family 2: retype
                    const [newType, policy] = retypes[sn];
                    out[f.name()] = this._retype(vs.at(sn, false), newType, policy, obs ? `${srep}.${sn}` : null);
                } else {                                              // kept/renamed -> recurse
                    out[f.name()] = this.value(vs.at(sn, false), f.type(), obs ? `${srep}.${f.name()}` : null);
                }
            }
            return new V.ValueStructure(tgt, out);
        }

        if (tc === 'key') {
            // Rebuild on the target concept + stable instanceId, then retype to the mapped Key<X>
            // so the flavour (concept / club / any-concept) survives.
            const vk = V.ValueKey.cast(v);
            const base = V.ValueKey.create(this._mapNamed(vk.typeConcept()), vk.instanceId());
            return base.toKey(V.TypeKey.cast(tt));
        }

        if (tc === 'any') {
            const va = V.ValueAny.cast(v);
            return va.isNil() ? new V.ValueAny() : new V.ValueAny(this.value(va.unwrap(false), undefined, site));
        }

        if (tc === 'enum') {
            const ve = V.ValueEnumeration.cast(v);
            const erepr = ve.typeEnumeration().representation();
            let name = ve.name();
            const removed = this.d.removedCases[erepr] ?? {};
            if (name in removed) {                                    // Class B: removed case populated
                const policy = removed[name];
                if (Array.isArray(policy) && policy[0] === 'map-case') { this._emit('remove-case', site, policy, name, policy[1]); name = policy[1]; }
                else if (policy === 'drop-record') { this._emit('remove-case', site, policy, name, null); throw new Unrepresentable('remove-case'); }
                else throw new Error(`[Class-B] removed case populated: ${name}`);
            } else {
                name = (this.d.caseRenames[erepr] ?? {})[name] ?? name;
            }
            return new V.ValueEnumeration(V.TypeEnumeration.cast(tt), name);
        }

        // Container / holder kinds (optional / vector / set / map / xarray / tuple) — one shared
        // traversal, so `value` and `_retype`'s same-kind element retype stay in lockstep.
        const mapped = this._mapElements(v, tt, (e, et, s) => this.value(e, et, s), site);
        if (mapped !== null) return mapped;

        if (tc === 'variant') {
            const vv = V.ValueVariant.cast(v);
            const inner = this.value(vv.unwrap(false), undefined, site);
            const out = new V.ValueVariant(tt);
            out.wrap(inner, inner.type());
            return out;
        }

        if (tc === 'commit_id' && this._commitIdRemap !== null)       // DAG replay: intra remapped, external kept
            return this._commitIdRemap[v.representation()] ?? v;

        // primitive leaf. GUARD: an unhandled composite must NOT pass through verbatim (stale ids).
        if (!PRIMITIVES.has(tc))
            throw new Error(`[engine] unhandled composite typeCode '${tc}' — refusing to pass it through unrewritten`);
        if (v.typeCode() === tt.typeCode()) return v;
        return V.Value.create(tt, V.Value.dumps(v));
    }

    // -- map a source attachment (a named Map<Key,Doc>) to its target
    attachment(a) { return this.attMap[a.runtimeId().representation()]; }
}


// -- addressing an attachment in a directive -------------------------------------
//    An attachment's identity is its `identifier()` — `NS::KeyConcept.name` — and that is what
//    the directive API names (`renameAttachment(oldId, ...)`, `dropAttachment(identifier)`).
//    The bare local name is accepted as a legacy key, but it is NOT an identity: two concepts in
//    one namespace may each carry an attachment of the same name (`N::Customer.orders` and
//    `N::Vendor.orders`), and a directive written that way addresses every homonym at once.
//    Prefer the identifier; a name-based consumer (a source codemod) can only mirror that one.
export function attKeys(a) {
    const identifier = a.identifier();
    return [identifier, identifier.slice(identifier.lastIndexOf('.') + 1)];
}

export function attGet(mapping, a, fallback = undefined) {
    for (const key of attKeys(a)) if (Object.hasOwn(mapping, key)) return mapping[key];
    return fallback;
}

export function attHit(container, a) {
    return attKeys(a).some((key) => container.has(key));
}


// -- an add_field default lives in a TARGET field but is authored against the SOURCE domain:
//    expressible only if it references no named (migrated) type — a primitive leaf or a container
//    of such. A default embedding a struct/enum/key/Any would carry stale source ids.
function defaultDomainFree(t) {
    const tc = t.typeCode();
    if (PRIMITIVES.has(tc)) return true;                            // scalar leaves (incl. vec/mat)
    if (tc === 'optional') return defaultDomainFree(V.TypeOptional.cast(t).elementType());
    if (tc === 'vector') return defaultDomainFree(V.TypeVector.cast(t).elementType());
    if (tc === 'set') return defaultDomainFree(V.TypeSet.cast(t).elementType());
    if (tc === 'map') { const m = V.TypeMap.cast(t); return defaultDomainFree(m.keyType()) && defaultDomainFree(m.elementType()); }
    if (tc === 'tuple') return V.TypeTuple.cast(t).types().every(defaultDomainFree);
    if (tc === 'variant') return V.TypeVariant.cast(t).types().every(defaultDomainFree);
    if (tc === 'xarray') return defaultDomainFree(V.TypeXArray.cast(t).elementType());
    return false;                                                  // struct / enum / key / any
}


// -- Vec/Mat dimension ops: derive the target type (element T read from the source) and validate
//    the field is a DIRECT Vec/Mat. A nested Vec/Mat is not yet addressable (needs a type-path
//    directive).
function resizedType(structRepr, field, spec) {
    const [kind, dims, fill] = spec;
    const t = field.type();
    if (kind === 'vec') {
        if (t.typeCode() !== 'vec')
            throw new Error(`[unsupported] resizeVecField on ${structRepr}.${field.name()}: its type is ${t.representation()}, not a direct Vec — a nested Vec/Mat is not yet addressable (needs a type-path directive)`);
        if (fill === 'identity')
            throw new Error(`[unsupported] resizeVecField fill='identity' on ${structRepr}.${field.name()}: identity is Mat-only; use 'zero' or a scalar`);
        return new V.TypeVec(V.TypeVec.cast(t).elementType(), dims[0]);
    }
    if (t.typeCode() !== 'mat')                                     // kind == 'mat'
        throw new Error(`[unsupported] resizeMatField on ${structRepr}.${field.name()}: its type is ${t.representation()}, not a direct Mat — a nested Vec/Mat is not yet addressable (needs a type-path directive)`);
    return new V.TypeMat(V.TypeMat.cast(t).elementType(), dims[0], dims[1]);
}

function transposedType(structRepr, field) {
    const t = field.type();
    if (t.typeCode() !== 'mat')
        throw new Error(`[unsupported] transposeMatField on ${structRepr}.${field.name()}: its type is ${t.representation()}, not a direct Mat`);
    const m = V.TypeMat.cast(t);
    return new V.TypeMat(m.elementType(), m.rows(), m.columns());   // Mat<c,r> -> Mat<r,c>
}

// Validate every resize/transpose directive up front (direct-Vec/Mat + fill coherence), before
// any target is built or data touched. Shared by both construction paths.
function validateDimensionOps(src, directives) {
    const byRepr = Object.fromEntries(src.structures().map((s) => [s.representation(), s]));
    for (const [srep, fields] of Object.entries(directives.resizedFields)) {
        const s = byRepr[srep];
        if (s !== undefined) for (const [fname, spec] of Object.entries(fields)) resizedType(srep, s.check(fname), spec);
    }
    for (const [srep, fset] of Object.entries(directives.transposedFields)) {
        const s = byRepr[srep];
        if (s !== undefined) for (const fname of fset) transposedType(srep, s.check(fname));
    }
}


// Accumulate EVERY surviving reference to a drop_type'd type into one legible report; return the
// report string, or null if the drops dangle nothing. A reference removed by another directive
// (drop_field / retype_field / transform_field) is exempt. Nothing references an attachment, so
// drop_attachment never appears here.
function formatDropReport(src, directives, refsDropped) {
    const droppedTypes = directives.droppedTypes;
    const droppedAtts = directives.droppedAttachments;
    const findings = [];                              // [referrer, detail, dropped type]

    for (const s of src.structures()) {
        if (droppedTypes.has(s.representation())) continue;
        const drops = directives.droppedFields[s.representation()] ?? new Set();
        const retypes = directives.retypedFields[s.representation()] ?? {};
        const transformed = directives.transformedFields[s.representation()] ?? {};
        for (const f of s.fields()) {
            if (drops.has(f.name()) || f.name() in retypes || f.name() in transformed) continue;
            const hit = refsDropped(f.type());
            if (hit) findings.push([s.representation(), `field '${f.name()}' : ${f.type().representation()}`, hit]);
        }
    }
    for (const c of src.concepts()) {
        if (droppedTypes.has(c.representation())) continue;
        const p = c.parent();
        if (p !== null && p !== undefined && droppedTypes.has(p.representation()))
            findings.push([c.representation(), `parent (isa ${p.representation()})`, p.representation()]);
    }
    for (const cl of src.clubs()) {
        if (droppedTypes.has(cl.representation())) continue;
        for (const m of cl.members())
            if (droppedTypes.has(m.representation())) findings.push([cl.representation(), `member ${m.representation()}`, m.representation()]);
    }
    for (const a of src.attachments()) {
        if (attHit(droppedAtts, a)) continue;
        for (const [label, tt] of [['key', a.keyType()], ['document', a.documentType()]]) {
            const hit = refsDropped(tt);
            if (hit) findings.push([`attachment ${a.identifier()}`, `${label} type : ${tt.representation()}`, hit]);
        }
    }

    if (!findings.length) return null;
    findings.sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : (x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0)));
    const lines = findings.map(([ref, detail, dropped]) => `  ${ref} — ${detail}  ->  dropped ${dropped}`).join('\n');
    return `[dropped-type-referenced] drop_type would leave ${findings.length} dangling reference(s) in surviving definitions:\n${lines}\nHandle each too — dropField / retypeField / transformField the field, dropType the referrer, or dropAttachment it — or keep the dropped type.`;
}


// ------------------------------------------- definitions => definitions (target)
export function buildTargetDefinitions(sourceDefs, directives) {
    for (const [, adds] of Object.entries(directives.addedFields))
        for (const [name, payload, derive] of adds) {
            if (derive !== null && derive !== undefined) continue;     // derived field: `payload` is the target Type
            if (!defaultDomainFree(payload.type()))
                throw new Error(`[unsupported] addField('${name}') default of type ${payload.type().representation()} references a named type — a composite default is not expressible across a migration (it would carry stale source ids); use a primitive-leaf default`);
        }

    const src = constDefs(sourceDefs);
    validateDimensionOps(src, directives);            // resize/transpose: direct-Vec/Mat + fill, up front
    const target = new V.Definitions();
    const tmap = {};

    const simple = (srcType) => {                     // target simple name after type rename
        const full = srcType.representation();
        return (directives.typeRenames[full] ?? full).split('::').pop();
    };
    const tgtNs = (srcType) => {                      // target namespace: name axis + uuid axis
        const ov = directives.typeNamespaces[srcType.representation()];
        if (ov !== undefined) return ov;              // per-definition move (split/precise-merge)
        const sns = srcType.typeName().nameSpace();
        const key = sns.uuid().representation();
        const newUuid = directives.namespaceUuids[key] ?? sns.uuid();
        const newName = directives.namespaceNames[key] ?? sns.name();
        return new V.NameSpace(newUuid, newName);
    };
    const attNs = (a) => {                            // attachment namespace: per-attachment move, else bulk
        const ov = attGet(directives.attachmentNamespaces, a);
        return ov !== undefined ? ov : tgtNs(a);
    };

    const ELEM = { optional: V.TypeOptional, vector: V.TypeVector, set: V.TypeSet, xarray: V.TypeXArray, key: V.TypeKey };
    const mapT = (t) => {
        const th = directives.transformedTypes[t.runtimeId().representation()];
        if (th !== undefined) return mapT(th[0]);     // global hook: substitute the new_type
        const tc = t.typeCode();
        if (['struct', 'enum', 'concept', 'club'].includes(tc)) return tmap[t.runtimeId().representation()];
        if (tc in ELEM) return new ELEM[tc](mapT(ELEM[tc].cast(t).elementType()));
        if (tc === 'map') { const m = V.TypeMap.cast(t); return new V.TypeMap(mapT(m.keyType()), mapT(m.elementType())); }
        if (tc === 'tuple') return new V.TypeTuple(V.TypeTuple.cast(t).types().map(mapT));
        if (tc === 'variant') return new V.TypeVariant(V.TypeVariant.cast(t).types().map(mapT));
        return t;
    };
    const ready = (t) => {
        const th = directives.transformedTypes[t.runtimeId().representation()];
        if (th !== undefined) return ready(th[0]);    // a hooked type is ready iff new_type is
        const tc = t.typeCode();
        if (['struct', 'enum', 'concept', 'club'].includes(tc)) return t.runtimeId().representation() in tmap;
        if (tc in ELEM) return ready(ELEM[tc].cast(t).elementType());
        if (tc === 'map') { const m = V.TypeMap.cast(t); return ready(m.keyType()) && ready(m.elementType()); }
        if (tc === 'tuple') return V.TypeTuple.cast(t).types().every(ready);
        if (tc === 'variant') return V.TypeVariant.cast(t).types().every(ready);
        return true;
    };
    const hooked = (t) => t.runtimeId().representation() in directives.transformedTypes;   // maps to new_type

    const droppedTypes = directives.droppedTypes;
    const droppedAtts = directives.droppedAttachments;
    const dropped = (t) => droppedTypes.has(t.representation());    // a named type removed by drop_type

    const refsDropped = (t) => {
        // The dropped type an effective target reference would dangle on, or null. Mirrors mapT.
        const th = directives.transformedTypes[t.runtimeId().representation()];
        if (th !== undefined) return refsDropped(th[0]);
        const tc = t.typeCode();
        if (['struct', 'enum', 'concept', 'club'].includes(tc)) return droppedTypes.has(t.representation()) ? t.representation() : null;
        if (tc in ELEM) return refsDropped(ELEM[tc].cast(t).elementType());
        if (tc === 'map') { const m = V.TypeMap.cast(t); return refsDropped(m.keyType()) || refsDropped(m.elementType()); }
        if (tc === 'tuple' || tc === 'variant') {
            const cls = tc === 'tuple' ? V.TypeTuple : V.TypeVariant;
            for (const x of cls.cast(t).types()) { const r = refsDropped(x); if (r) return r; }
        }
        return null;
    };

    // -- Upstream drop check: a dropped type must not stay referenced by a SURVIVING definition.
    //    Accumulate EVERY offending site and report them together — fail closed and early.
    if (droppedTypes.size) {
        const report = formatDropReport(src, directives, refsDropped);
        if (report) throw new Error(report);
    }

    // -- Upstream collision check: a namespace move / merge can land two definitions in the same
    //    target (namespace, name) slot. Detect ALL such clashes up front and report together.
    if (Object.keys(directives.typeNamespaces).length || Object.keys(directives.attachmentNamespaces).length
        || Object.keys(directives.namespaceNames).length || Object.keys(directives.namespaceUuids).length) {
        const slots = {};
        for (const t of [...src.structures(), ...src.enumerations(), ...src.concepts(), ...src.clubs()]) {
            if (hooked(t) || dropped(t)) continue;
            (slots[`${tgtNs(t).name()}::${simple(t)}`] ??= []).push(t.representation());
        }
        const clashes = Object.entries(slots).filter(([, s]) => s.length > 1).map(([rep, s]) => [rep, [...s].sort()]);
        if (clashes.length) {
            clashes.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
            const lines = clashes.map(([rep, s]) => `  ${rep}  <-  ${s.join(', ')}`).join('\n');
            throw new Error(`[namespace-collision] ${clashes.length} target name(s) claimed by more than one definition after the namespace move/merge:\n${lines}\nRename one side (renameType) or send them to distinct namespaces (moveType).`);
        }
    }

    // concepts — topological by parent
    let pending = [...src.concepts()].filter((c) => !hooked(c) && !dropped(c));
    while (pending.length) {
        const still = []; let progressed = false;
        for (const c of pending) {
            const p = c.parent();
            if (p === null || p === undefined || p.runtimeId().representation() in tmap) {
                const cdoc = directives.typeDocs[c.representation()] ?? c.documentation();
                const nc = (p === null || p === undefined)
                    ? target.createConcept(tgtNs(c), simple(c), cdoc)
                    : target.createConcept(tgtNs(c), simple(c), cdoc, tmap[p.runtimeId().representation()]);
                tmap[c.runtimeId().representation()] = nc; progressed = true;
            } else still.push(c);
        }
        if (!progressed && still.length) throw new Error('concept parent cycle');
        pending = still;
    }

    // clubs + memberships
    for (const cl of src.clubs()) {
        if (hooked(cl) || dropped(cl)) continue;
        const ncl = target.createClub(tgtNs(cl), simple(cl), directives.typeDocs[cl.representation()] ?? cl.documentation());
        tmap[cl.runtimeId().representation()] = ncl;
        for (const member of cl.members()) target.createMembership(ncl, tmap[member.runtimeId().representation()]);
    }

    // enumerations — cases renamed / removed / added / reordered
    for (const e of src.enumerations()) {
        if (hooked(e) || dropped(e)) continue;
        const cren = directives.caseRenames[e.representation()] ?? {};
        const removed = directives.removedCases[e.representation()] ?? {};
        let names = e.cases().map((c) => c.name()).filter((n) => !(n in removed)).map((n) => cren[n] ?? n);
        names = names.concat(directives.addedCases[e.representation()] ?? []);       // add at end
        // documentation (Class A): carried by TARGET case name, overridden by document_case
        // (named by SOURCE case name); added cases default to none.
        const authored = directives.caseDocs[e.representation()] ?? {};
        const caseDocs = {};
        for (const c of e.cases()) if (!(c.name() in removed)) caseDocs[cren[c.name()] ?? c.name()] = authored[c.name()] ?? c.documentation();
        const order = directives.caseOrder[e.representation()];
        if (order) {
            if (!sameSet(order, names)) throw new Error(`reorderCases(${e.representation()}) not a permutation of ${names}`);
            names = order;
        }
        const de = new V.TypeEnumerationDescriptor(simple(e), directives.typeDocs[e.representation()] ?? e.documentation());
        for (const name of names) de.addCase(name, caseDocs[name] ?? '');
        tmap[e.runtimeId().representation()] = target.createEnumeration(tgtNs(e), de);
    }

    // structures — topological by field-type dependencies, fields renamed
    pending = [...src.structures()].filter((s) => !hooked(s) && !dropped(s));
    while (pending.length) {
        const still = []; let progressed = false;
        for (const s of pending) {
            const retypes = directives.retypedFields[s.representation()] ?? {};
            const transformed = directives.transformedFields[s.representation()] ?? {};
            const adds = directives.addedFields[s.representation()] ?? [];
            const drops = directives.droppedFields[s.representation()] ?? new Set();
            // readiness follows the TARGET field type: a retype / transform / derived add to a
            // named type depends on that type being built.
            const dep = (f) => {
                if (f.name() in transformed) return transformed[f.name()][0];
                if (f.name() in retypes) return retypes[f.name()][0];
                return f.type();
            };
            if (s.fields().filter((f) => !drops.has(f.name())).every((f) => ready(dep(f)))
                && adds.filter(([, , derive]) => derive !== null && derive !== undefined).every(([, payload]) => ready(payload))) {
                const fren = directives.fieldRenames[s.representation()] ?? {};
                const resized = directives.resizedFields[s.representation()] ?? {};
                const transposed = directives.transposedFields[s.representation()] ?? new Set();
                const fdocs = directives.fieldDocs[s.representation()] ?? {};   // authored, by source name
                let fields = [];                                    // [target name, Type | default Value, doc]
                for (const f of s.fields()) {
                    if (drops.has(f.name())) continue;              // family 2: drop
                    let ftype;
                    if (f.name() in transformed) ftype = mapT(transformed[f.name()][0]);       // Class-C hook
                    else if (f.name() in resized) ftype = resizedType(s.representation(), f, resized[f.name()]);   // resize
                    else if (transposed.has(f.name())) ftype = transposedType(s.representation(), f);              // transpose
                    else if (f.name() in retypes) ftype = retypes[f.name()][0];                // retype
                    else {                                            // carried: keep the type, but carry a
                        const dflt = f.defaultValue();                // non-zero domain-free default (part of the
                        if (dflt !== null && dflt !== undefined && defaultDomainFree(f.type()))  // runtimeId, like a
                            ftype = V.Value.create(mapT(f.type()), dflt);  // doc) — under the MAPPED type, so a
                        else                                          // transform_type/remap of the default's own
                            ftype = mapT(f.type());                   // type flows through it, not just the field
                    }
                    fields.push([fren[f.name()] ?? f.name(), ftype, fdocs[f.name()] ?? f.documentation()]);
                }
                for (const [name, payload, derive] of adds)         // family 2: add (static or derived)
                    fields.push([name, (derive !== null && derive !== undefined) ? mapT(payload) : payload, fdocs[name] ?? '']);
                const order = directives.fieldOrder[s.representation()];
                if (order) {                                        // family 2: reorder
                    const byName = Object.fromEntries(fields.map(([n, t, d]) => [n, [n, t, d]]));
                    if (!sameSet(order, Object.keys(byName)))
                        throw new Error(`reorderFields(${s.representation()}) not a permutation of ${Object.keys(byName)}`);
                    fields = order.map((n) => byName[n]);
                }
                const ds = new V.TypeStructureDescriptor(simple(s), directives.typeDocs[s.representation()] ?? s.documentation());
                for (const [name, t, doc] of fields) ds.addField(name, t, doc);   // documentation carried (Class A)
                tmap[s.runtimeId().representation()] = target.createStructure(tgtNs(s), ds);
                progressed = true;
            } else still.push(s);
        }
        if (!progressed && still.length) throw new Error('structure dependency cycle');
        pending = still;
    }

    // attachments — a named Map<Key, Document>: remap key + document types, rename id
    const attMap = {};
    for (const a of src.attachments()) {
        if (attHit(droppedAtts, a)) continue;              // drop_attachment: not recreated
        const local = a.identifier().slice(a.identifier().lastIndexOf('.') + 1);
        const renamed = attGet(directives.attachmentRenames, a, local);
        const name = renamed.slice(renamed.lastIndexOf('.') + 1);   // a new id may be qualified
        const na = target.createAttachment(attNs(a), name, mapT(a.keyType()), mapT(a.documentType()),
            attGet(directives.attachmentDocs, a, a.documentation()));
        attMap[a.runtimeId().representation()] = na;
    }

    return [target, tmap, attMap];
}

function sameSet(a, b) {
    const sa = new Set(a); const sb = new Set(b);
    return sa.size === sb.size && [...sa].every((x) => sb.has(x));
}
