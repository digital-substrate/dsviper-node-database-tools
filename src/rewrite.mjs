// Definitions-directed document rewriting — the engine. A 1:1 port of the Python
// engine: `DefinitionsTransformer.fromDirectives(sourceDefs, directives)` builds
// the target `Definitions` from source + edit script, and rewrites any value from the
// source domain to the target with ONE target-directed engine (`value()`) spanning both
// families (renames, and add/drop/reorder/retype). See ARCHITECTURE.md.

import V from './dsviper.mjs';

// representationally-lossless leaf widenings — automatic (Class A)
const WIDENING = new Set([
    'int8>int16', 'int8>int32', 'int8>int64', 'int16>int32', 'int16>int64', 'int32>int64',
    'int32>double', 'int16>double', 'int8>double',
    'uint8>uint16', 'uint8>uint32', 'uint8>uint64', 'uint16>uint32', 'uint16>uint64', 'uint32>uint64',
    'float>double',
]);
const PRIMITIVES = new Set(['void', 'bool', 'uint8', 'uint16', 'uint32', 'uint64',
    'int8', 'int16', 'int32', 'int64', 'float', 'double',
    'blob_id', 'commit_id', 'uuid', 'string', 'blob', 'vec', 'mat']);
const INT_RANGE = {          // BigInt bounds (JS int64/uint64 are bigint)
    int8: [-128n, 127n], int16: [-32768n, 32767n],
    int32: [-2147483648n, 2147483647n], int64: [-(2n ** 63n), 2n ** 63n - 1n],
    uint8: [0n, 255n], uint16: [0n, 65535n], uint32: [0n, 4294967295n], uint64: [0n, 2n ** 64n - 1n],
};
const IS64 = (tc) => tc === 'int64' || tc === 'uint64';
const coerce = (tc, n) => IS64(tc) ? n : Number(n);            // bigint for 64-bit, else number

export class DropRecord extends Error {}                       // loop-level "skip this document" signal

const constDefs = (defs) => (typeof defs.const === 'function' ? defs.const() : defs);

export class DefinitionsTransformer {
    _commitIdRemap = null;       // { src commit repr -> new ValueCommitId }, set during a DAG replay

    constructor(sourceDefs, targetDefs, directives) {
        this.source = constDefs(sourceDefs);
        this.target = constDefs(targetDefs);
        this.d = directives;
        this.attMap = {};
        this._buildMaps();
        this._shapeGuard();
        this._policyCompleteness();
    }

    // -- build the target Definitions from source + directives, then wire the
    //    transformer against it. Returns [tr, target].
    static fromDirectives(sourceDefs, directives) {
        const [target, tmap, attMap] = buildTargetDefinitions(sourceDefs, directives);
        const self = Object.create(DefinitionsTransformer.prototype);
        self.source = constDefs(sourceDefs);
        self.target = target.const();
        self.d = directives;
        self.typeMap = { ...tmap };        // src rid repr -> target named Type
        self.attMap = { ...attMap };       // src attachment rid repr -> target Attachment
        self._policyCompleteness();        // Class-B policies still required
        return [self, target];
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

    // -- (policy-completeness) refuse a lossy retype / removed case with no policy
    _policyCompleteness() {
        for (const s of this.source.structures()) {
            const retypes = this.d.retypedFields[s.representation()] ?? {};
            for (const [fname, [newType]] of Object.entries(retypes)) {
                const sc = s.check(fname).type().typeCode();
                const tc = newType.typeCode();
                const policy = retypes[fname][1];
                if ((['vec', 'mat'].includes(sc) || ['vec', 'mat'].includes(tc)) &&
                    newType.representation() !== s.check(fname).type().representation())
                    throw new Error(`[unsupported] Vec/Mat retype on ${s.representation()}.${fname} (${sc}->${tc}) is not supported — carry it verbatim (no directive) or model the change as a new field`);
                const classA = WIDENING.has(`${sc}>${tc}`) || tc === 'string';
                if (!classA && policy === null)
                    throw new Error(`[policy-completeness] ${sc}->${tc} on ${s.representation()}.${fname} needs a decreed policy`);
            }
        }
        for (const e of this.source.enumerations()) {
            for (const [caseName, policy] of Object.entries(this.d.removedCases[e.representation()] ?? {}))
                if (policy === null)
                    throw new Error(`[policy-completeness] removed case ${e.representation()}.${caseName} needs a decreed policy`);
        }
    }

    // -- type => type
    mapType(t) {
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

    // -- retype dispatcher: structural (unwrap, Vector->Set) + leaf (widen/narrow/format/parse)
    _retype(sv, tt, policy) {
        const sc = sv.typeCode(); const tc = tt.typeCode();

        // -- structural
        if (sc === 'optional' && tc !== 'optional') {                 // unwrap Optional<A> -> A
            const vo = V.ValueOptional.cast(sv);
            if (vo.isNil()) return this._onMissing(tt, policy, 'nil-unwrap');
            return this.value(vo.unwrap(false), tt);
        }
        if (sc === 'vector' && tc === 'set') {                        // Vector -> Set (collapse)
            const et = V.TypeSet.cast(tt).elementType();
            const out = new V.ValueSet(tt); const vv = V.ValueVector.cast(sv);
            for (let i = 0; i < vv.size(); i++) out.add(this.value(vv.at(i, false), et));
            return out;
        }

        // -- leaf
        if (WIDENING.has(`${sc}>${tc}`)) return V.Value.create(tt, coerce(tc, BigInt(V.Value.dumps(sv))));  // A: widen
        if (tc === 'string') return new V.ValueString(String(V.Value.dumps(sv)));    // A: format (total)
        if (sc === 'string') return this._parse(sv, tt, policy);                     // B: parse
        const [lo, hi] = INT_RANGE[tc] ?? [null, null];                              // numeric narrowing
        if (lo !== null) {
            const n = BigInt(V.Value.dumps(sv));
            if (lo <= n && n <= hi) return V.Value.create(tt, coerce(tc, n));        // in range -> exact
            if (policy === null || policy === 'fail')
                throw new Error(`[Class-B] ${sc}->${tc} out of range: ${n}`);
            if (policy === 'saturate') return V.Value.create(tt, coerce(tc, n < lo ? lo : hi));
            if (Array.isArray(policy) && policy[0] === 'default') return policy[1];
            throw new Error(`unknown policy ${JSON.stringify(policy)}`);
        }
        if (policy === null || policy === 'fail') throw new Error(`[Class-B] ${sc}->${tc} unsupported`);
        if (Array.isArray(policy) && policy[0] === 'default') return policy[1];
        throw new Error(`unknown policy ${JSON.stringify(policy)}`);
    }

    _onMissing(tt, policy, kind) {                       // nil-unwrap / parse-fail
        if (policy === null || policy === 'fail') throw new Error(`[Class-B] ${kind}: absent value; decree a policy`);
        if (policy === 'drop-record') throw new DropRecord(kind);
        if (Array.isArray(policy) && policy[0] === 'default') return policy[1];
        throw new Error(`unknown policy ${JSON.stringify(policy)}`);
    }

    _parse(sv, tt, policy) {
        const s = V.Value.dumps(sv); const tc = tt.typeCode();
        try {
            if (tc in INT_RANGE) {
                const n = BigInt(s);                                 // throws on non-integer text
                const [lo, hi] = INT_RANGE[tc];
                if (!(lo <= n && n <= hi)) throw new Error('range');
                return V.Value.create(tt, coerce(tc, n));
            }
            const f = Number(s);
            if (Number.isNaN(f)) throw new Error('parse');
            return V.Value.create(tt, f);
        } catch {
            return this._onMissing(tt, policy, 'parse');
        }
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

    // -- value => value, TARGET-DIRECTED. `tt` = target type (derived if undefined).
    value(v, tt = undefined) {
        if (tt === undefined) tt = this.mapType(v.type());
        const tc = v.typeCode();

        if (tc === 'struct') {
            const vs = V.ValueStructure.cast(v);
            const src = vs.typeStructure(); const tgt = V.TypeStructure.cast(tt);
            const fsrc = this._fieldSource(src, tgt);
            const retypes = this.d.retypedFields[src.representation()] ?? {};
            const adds = Object.fromEntries(this.d.addedFields[src.representation()] ?? []);
            const out = {};
            for (const f of tgt.fields()) {
                const sn = fsrc[f.name()];
                if (sn === null) {                                    // added -> directive seed
                    out[f.name()] = f.name() in adds ? adds[f.name()] : f.defaultValue();
                } else if (sn in retypes) {                           // family 2: retype
                    const [newType, policy] = retypes[sn];
                    out[f.name()] = this._retype(vs.at(sn, false), newType, policy);
                } else {                                              // kept/renamed -> recurse
                    out[f.name()] = this.value(vs.at(sn, false), f.type());
                }
            }
            return new V.ValueStructure(tgt, out);
        }

        if (tc === 'key') {
            const vk = V.ValueKey.cast(v);
            const base = V.ValueKey.create(this._mapNamed(vk.typeConcept()), vk.instanceId());
            return base.toKey(V.TypeKey.cast(tt));       // preserve the Key<X> flavour
        }

        if (tc === 'any') {
            const va = V.ValueAny.cast(v);
            return va.isNil() ? new V.ValueAny() : new V.ValueAny(this.value(va.unwrap(false)));
        }

        if (tc === 'enum') {
            const ve = V.ValueEnumeration.cast(v);
            const erepr = ve.typeEnumeration().representation();
            let name = ve.name();
            const removed = this.d.removedCases[erepr] ?? {};
            if (name in removed) {                                    // Class B: removed case populated
                const policy = removed[name];
                if (Array.isArray(policy) && policy[0] === 'map-case') name = policy[1];
                else if (policy === 'drop-record') throw new DropRecord('remove-case');
                else throw new Error(`[Class-B] removed case populated: ${name}`);
            } else {
                name = (this.d.caseRenames[erepr] ?? {})[name] ?? name;
            }
            return new V.ValueEnumeration(V.TypeEnumeration.cast(tt), name);
        }

        if (tc === 'optional') {
            const vo = V.ValueOptional.cast(v);
            const et = V.TypeOptional.cast(tt).elementType();
            if (vo.isNil()) return new V.ValueOptional(tt);
            return new V.ValueOptional(tt, this.value(vo.unwrap(false), et));
        }

        if (tc === 'vector') {
            const vv = V.ValueVector.cast(v);
            const et = V.TypeVector.cast(tt).elementType();
            const out = new V.ValueVector(tt);
            for (let i = 0; i < vv.size(); i++) out.append(this.value(vv.at(i, false), et));
            return out;
        }

        if (tc === 'set') {
            const vs = V.ValueSet.cast(v);
            const et = V.TypeSet.cast(tt).elementType();
            const out = new V.ValueSet(tt); const seen = new Set();   // ValueSet has no has()/contains()
            for (let i = 0; i < vs.size(); i++) {
                const ne = this.value(vs.at(i, false), et);
                if (seen.has(ne.representation())) {                  // Class B: element collapse
                    if (this.d.collisionPolicy === 'fail')
                        throw new Error(`[Class-B] set element collapse: ${ne.representation()} — a non-injective element migration would silently drop a member; decree resolveCollisions('first'|'last')`);
                    continue;                                         // first/last both = collapse to one
                }
                seen.add(ne.representation()); out.add(ne);
            }
            return out;
        }

        if (tc === 'map') {
            const vm = V.ValueMap.cast(v);
            const mt = V.TypeMap.cast(tt);
            const kt = mt.keyType(); const et = mt.elementType();
            const out = new V.ValueMap(tt);
            for (const [k, val] of vm.items(false)) {
                const nk = this.value(k, kt); const nv = this.value(val, et);
                if (out.contains(nk)) {                               // Class B: key collision
                    const pol = this.d.collisionPolicy;
                    if (pol === 'last') out.set(nk, nv);
                    else if (pol === 'first') { /* keep existing */ }
                    else throw new Error(`[Class-B] map key collision: ${nk.representation()}`);
                } else out.set(nk, nv);
            }
            return out;
        }

        if (tc === 'tuple') {
            const vt = V.ValueTuple.cast(v);
            const ets = V.TypeTuple.cast(tt).types();
            const parts = [];
            for (let i = 0; i < vt.size(); i++) parts.push(this.value(vt.at(i, false), ets[i]));
            return new V.ValueTuple(tt, parts);
        }

        if (tc === 'variant') {
            const vv = V.ValueVariant.cast(v);
            const inner = this.value(vv.unwrap(false));
            const out = new V.ValueVariant(tt);
            out.wrap(inner, inner.type());
            return out;
        }

        if (tc === 'xarray') {
            const vx = V.ValueXArray.cast(v);
            const et = V.TypeXArray.cast(tt).elementType();
            const out = new V.ValueXArray(tt);
            out.rebuildFrom(vx, vx.items(false).map(([pos, val]) => [pos, this.value(val, et)]));
            return out;
        }

        if (tc === 'commit_id' && this._commitIdRemap !== null)       // DAG replay: intra remapped, external kept
            return this._commitIdRemap[v.representation()] ?? v;

        // primitive leaf. GUARD: an unhandled composite must not pass through verbatim.
        if (!PRIMITIVES.has(tc))
            throw new Error(`[engine] unhandled composite typeCode '${tc}' — refusing to pass it through unrewritten`);
        if (v.typeCode() === tt.typeCode()) return v;
        return V.Value.create(tt, V.Value.dumps(v));
    }

    // -- map a source attachment to its target
    attachment(a) { return this.attMap[a.runtimeId().representation()]; }
}


// -- an add_field default lives in a TARGET field but is authored against the SOURCE
//    domain: expressible only if it references no named (migrated) type.
function defaultDomainFree(t) {
    const tc = t.typeCode();
    if (PRIMITIVES.has(tc)) return true;
    if (tc === 'optional') return defaultDomainFree(V.TypeOptional.cast(t).elementType());
    if (tc === 'vector') return defaultDomainFree(V.TypeVector.cast(t).elementType());
    if (tc === 'set') return defaultDomainFree(V.TypeSet.cast(t).elementType());
    if (tc === 'map') { const m = V.TypeMap.cast(t); return defaultDomainFree(m.keyType()) && defaultDomainFree(m.elementType()); }
    if (tc === 'tuple') return V.TypeTuple.cast(t).types().every(defaultDomainFree);
    if (tc === 'variant') return V.TypeVariant.cast(t).types().every(defaultDomainFree);
    if (tc === 'xarray') return defaultDomainFree(V.TypeXArray.cast(t).elementType());
    return false;                                               // struct / enum / key / any
}


// ------------------------------------------- definitions => definitions (target)
export function buildTargetDefinitions(sourceDefs, directives) {
    for (const [, adds] of Object.entries(directives.addedFields))
        for (const [name, defaultValue] of adds)
            if (!defaultDomainFree(defaultValue.type()))
                throw new Error(`[unsupported] addField('${name}') default of type ${defaultValue.type().representation()} references a named type — a composite default is not expressible across a migration; use a primitive-leaf default`);

    const src = constDefs(sourceDefs);
    const target = new V.Definitions();
    const tmap = {};

    const simple = (srcType) => {
        const full = srcType.representation();
        return (directives.typeRenames[full] ?? full).split('::').pop();
    };
    const tgtNs = (srcType) => {
        const sns = srcType.typeName().nameSpace();
        const key = sns.uuid().representation();
        const newUuid = directives.namespaceUuids[key] ?? sns.uuid();
        const newName = directives.namespaceNames[key] ?? sns.name();
        return new V.NameSpace(newUuid, newName);
    };

    const ELEM = { optional: V.TypeOptional, vector: V.TypeVector, set: V.TypeSet, xarray: V.TypeXArray, key: V.TypeKey };
    const mapT = (t) => {
        const tc = t.typeCode();
        if (['struct', 'enum', 'concept', 'club'].includes(tc)) return tmap[t.runtimeId().representation()];
        if (tc in ELEM) return new ELEM[tc](mapT(ELEM[tc].cast(t).elementType()));
        if (tc === 'map') { const m = V.TypeMap.cast(t); return new V.TypeMap(mapT(m.keyType()), mapT(m.elementType())); }
        if (tc === 'tuple') return new V.TypeTuple(V.TypeTuple.cast(t).types().map(mapT));
        if (tc === 'variant') return new V.TypeVariant(V.TypeVariant.cast(t).types().map(mapT));
        return t;
    };
    const ready = (t) => {
        const tc = t.typeCode();
        if (['struct', 'enum', 'concept', 'club'].includes(tc)) return t.runtimeId().representation() in tmap;
        if (tc in ELEM) return ready(ELEM[tc].cast(t).elementType());
        if (tc === 'map') { const m = V.TypeMap.cast(t); return ready(m.keyType()) && ready(m.elementType()); }
        if (tc === 'tuple') return V.TypeTuple.cast(t).types().every(ready);
        if (tc === 'variant') return V.TypeVariant.cast(t).types().every(ready);
        return true;
    };

    // concepts — topological by parent
    let pending = [...src.concepts()];
    while (pending.length) {
        const still = []; let progressed = false;
        for (const c of pending) {
            const p = c.parent();
            if (p === null || p === undefined || p.runtimeId().representation() in tmap) {
                const nc = (p === null || p === undefined)
                    ? target.createConcept(tgtNs(c), simple(c))
                    : target.createConcept(tgtNs(c), simple(c), tmap[p.runtimeId().representation()]);
                tmap[c.runtimeId().representation()] = nc; progressed = true;
            } else still.push(c);
        }
        if (!progressed && still.length) throw new Error('concept parent cycle');
        pending = still;
    }

    // clubs + memberships
    for (const cl of src.clubs()) {
        const ncl = target.createClub(tgtNs(cl), simple(cl));
        tmap[cl.runtimeId().representation()] = ncl;
        for (const member of cl.members()) target.createMembership(ncl, tmap[member.runtimeId().representation()]);
    }

    // enumerations — cases renamed / removed / added / reordered
    for (const e of src.enumerations()) {
        const cren = directives.caseRenames[e.representation()] ?? {};
        const removed = directives.removedCases[e.representation()] ?? {};
        let names = e.cases().map((c) => c.name()).filter((n) => !(n in removed)).map((n) => cren[n] ?? n);
        names = names.concat(directives.addedCases[e.representation()] ?? []);       // add at end
        const order = directives.caseOrder[e.representation()];
        if (order) {
            if (!sameSet(order, names)) throw new Error(`reorderCases(${e.representation()}) not a permutation of ${names}`);
            names = order;
        }
        const de = new V.TypeEnumerationDescriptor(simple(e));
        for (const name of names) de.addCase(name);
        tmap[e.runtimeId().representation()] = target.createEnumeration(tgtNs(e), de);
    }

    // structures — topological by field-type dependencies, fields renamed
    pending = [...src.structures()];
    while (pending.length) {
        const still = []; let progressed = false;
        for (const s of pending) {
            if (s.fields().every((f) => ready(f.type()))) {
                const fren = directives.fieldRenames[s.representation()] ?? {};
                const drops = directives.droppedFields[s.representation()] ?? new Set();
                const retypes = directives.retypedFields[s.representation()] ?? {};
                const adds = directives.addedFields[s.representation()] ?? [];
                let fields = [];                                    // [targetName, Type | default Value]
                for (const f of s.fields()) {
                    if (drops.has(f.name())) continue;              // family 2: drop
                    const entry = retypes[f.name()];                // family 2: retype
                    const ftype = entry ? entry[0] : mapT(f.type());
                    fields.push([fren[f.name()] ?? f.name(), ftype]);
                }
                for (const [name, defaultValue] of adds) fields.push([name, defaultValue]);
                const order = directives.fieldOrder[s.representation()];
                if (order) {                                        // family 2: reorder
                    const byName = Object.fromEntries(fields.map(([n, t]) => [n, [n, t]]));
                    if (!sameSet(order, Object.keys(byName)))
                        throw new Error(`reorderFields(${s.representation()}) not a permutation of ${Object.keys(byName)}`);
                    fields = order.map((n) => byName[n]);
                }
                const ds = new V.TypeStructureDescriptor(simple(s));
                for (const [name, t] of fields) ds.addField(name, t);
                tmap[s.runtimeId().representation()] = target.createStructure(tgtNs(s), ds);
                progressed = true;
            } else still.push(s);
        }
        if (!progressed && still.length) throw new Error('structure dependency cycle');
        pending = still;
    }

    // attachments — remap key + document types, rename id
    const attMap = {};
    for (const a of src.attachments()) {
        const local = a.identifier().split('.').pop();
        const name = directives.attachmentRenames[local] ?? local;
        const na = target.createAttachment(tgtNs(a), name, mapT(a.keyType()), mapT(a.documentType()));
        attMap[a.runtimeId().representation()] = na;
    }

    return [target, tmap, attMap];
}

function sameSet(a, b) {
    const sa = new Set(a); const sb = new Set(b);
    return sa.size === sb.size && [...sa].every((x) => sb.has(x));
}
