// Optional/Tuple element retype + the fail-closed composite guard — a port of the Python
// TestHolderElementRetype / TestCompositeRetypeGuard.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import V from '../src/dsviper.mjs';
import { TransformationDirectives, DefinitionsRewriter } from '../src/rewrite/index.mjs';

const T = V.Type;
const NS = new V.NameSpace(new V.ValueUUId('6ba7b810-9dad-11d1-80b4-00c04fd430c8'), 'Demo');
function struct(defs, name, fields) {
    const d = new V.TypeStructureDescriptor(name);
    for (const [fn, ft] of fields) d.addField(fn, ft);
    return defs.createStructure(NS, d);
}
function enumT(defs, name, cases) {
    const d = new V.TypeEnumerationDescriptor(name);
    for (const c of cases) d.addCase(c);
    return defs.createEnumeration(NS, d);
}
function mk(srcT, tgtT, policy = null) {
    const src = new V.Definitions();
    const s = struct(src, 'S', [['f', srcT]]);
    const d = new TransformationDirectives();
    d.retypeField(s.representation(), 'f', tgtT, policy);
    const [rw] = DefinitionsRewriter.fromDirectives(src, d);
    return [rw, s];
}

describe('Optional / Tuple element retype', () => {
    it('optional widen int32->int64 is Class A (no policy)', () => {
        const O32 = new V.TypeOptional(T.INT32); const O64 = new V.TypeOptional(T.INT64);
        const [rw, s] = mk(O32, O64);
        const out = rw.value(new V.ValueStructure(s, { f: new V.ValueOptional(O32, V.Value.create(T.INT32, 7)) }));
        assert.equal(out.at('f', false).unwrap(true), 7n);
    });

    it('optional narrow int64->int32 saturate + nil preserved', () => {
        const O64 = new V.TypeOptional(T.INT64); const O32 = new V.TypeOptional(T.INT32);
        const [rw, s] = mk(O64, O32, 'saturate');
        const out = rw.value(new V.ValueStructure(s, { f: new V.ValueOptional(O64, V.Value.create(T.INT64, 2n ** 40n)) }));
        assert.equal(out.at('f', false).unwrap(true), 2147483647);            // saturated to int32 max
        const nout = rw.value(new V.ValueStructure(s, { f: new V.ValueOptional(O64) }));
        assert.ok(nout.at('f', false).isNil());                               // nil stays nil
    });

    it('optional narrow without policy is refused', () => {
        assert.throws(() => mk(new V.TypeOptional(T.INT64), new V.TypeOptional(T.INT32)), /narrowing/);
    });

    it('tuple per-position widen and narrow', () => {
        const [rw, s] = mk(new V.TypeTuple([T.INT32, T.STRING]), new V.TypeTuple([T.INT64, T.STRING]));  // widen A
        const out = rw.value(new V.ValueStructure(s, {
            f: new V.ValueTuple(new V.TypeTuple([T.INT32, T.STRING]), [V.Value.create(T.INT32, 5), new V.ValueString('a')]),
        }));
        assert.equal(out.at('f', false).at(0, true), 5n);
        assert.equal(out.at('f', false).at(1, true), 'a');
        const [rw2, s2] = mk(new V.TypeTuple([T.INT64, T.STRING]), new V.TypeTuple([T.INT32, T.STRING]), 'saturate');  // narrow B
        const out2 = rw2.value(new V.ValueStructure(s2, {
            f: new V.ValueTuple(new V.TypeTuple([T.INT64, T.STRING]), [V.Value.create(T.INT64, 2n ** 40n), new V.ValueString('b')]),
        }));
        assert.equal(out2.at('f', false).at(0, true), 2147483647);
        assert.equal(out2.at('f', false).at(1, true), 'b');
    });

    it('nested vector<optional<int64>> narrow policied, nil preserved', () => {
        const O64 = new V.TypeOptional(T.INT64); const O32 = new V.TypeOptional(T.INT32);
        const [rw, s] = mk(new V.TypeVector(O64), new V.TypeVector(O32), 'saturate');
        const vv = new V.ValueVector(new V.TypeVector(O64));
        vv.append(new V.ValueOptional(O64, V.Value.create(T.INT64, 2n ** 40n)));
        vv.append(new V.ValueOptional(O64));                                  // a nil element
        const out = rw.value(new V.ValueStructure(s, { f: vv }));
        const r = V.ValueVector.cast(out.at('f', false));
        assert.equal(V.ValueOptional.cast(r.at(0, false)).unwrap(true), 2147483647);
        assert.ok(V.ValueOptional.cast(r.at(1, false)).isNil());
    });
});

describe('Composite retype guard (fail-closed)', () => {
    function apply(mkFn) {
        const src = new V.Definitions();
        const [holder, tgtType, makeVal] = mkFn(src);
        const d = new TransformationDirectives();
        d.retypeField(holder.representation(), 'f', tgtType, 'saturate');
        const [rw] = DefinitionsRewriter.fromDirectives(src, d);
        rw.value(new V.ValueStructure(holder, { f: makeVal() }));
    }

    it('struct->struct refused', () => {
        assert.throws(() => apply((src) => {
            const s1 = struct(src, 'S1', [['a', T.INT32]]); const s2 = struct(src, 'S2', [['b', T.INT32]]);
            return [struct(src, 'H', [['f', s1]]), s2, () => new V.ValueStructure(s1, { a: 5 })];
        }), /no conversion branch/);
    });

    it('enum->enum refused', () => {
        assert.throws(() => apply((src) => {
            const e1 = enumT(src, 'E1', ['a']); const e2 = enumT(src, 'E2', ['b']);
            return [struct(src, 'HE', [['f', e1]]), e2, () => new V.ValueEnumeration(e1, 'a')];
        }), /no conversion branch/);
    });

    it('key->key refused', () => {
        assert.throws(() => apply((src) => {
            const ca = src.createConcept(NS, 'CA'); const cb = src.createConcept(NS, 'CB');
            return [struct(src, 'HK', [['f', new V.TypeKey(ca)]]), new V.TypeKey(cb),
                () => V.ValueKey.create(ca, new V.ValueUUId('11111111-1111-1111-1111-111111111111'))];
        }), /no conversion branch/);
    });
});
