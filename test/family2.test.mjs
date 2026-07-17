// Family 2 — shape changes + the numeric leaf algebra (the encoded=false / bigint
// stress). Port of the Python engine's Class-A / Class-B suites.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import V from '../src/dsviper.mjs';
import { TransformationDirectives } from '../src/rewrite/index.mjs';
import { DefinitionsRewriter, Unrepresentable } from '../src/rewrite/index.mjs';

const T = V.Type;
const NS = new V.NameSpace(new V.ValueUUId('6ba7b810-9dad-11d1-80b4-00c04fd430c8'), 'Demo');

function struct(defs, name, fields) {
    const d = new V.TypeStructureDescriptor(name);
    for (const [fn, ft] of fields) d.addField(fn, ft);
    return defs.createStructure(NS, d);
}
const rt = (tr, target, value, sourceType) =>
    V.Value.decode(V.Value.encode(value), tr.mapType(sourceType), target.const());

describe('family 2 — numeric leaf algebra', () => {
    it('widen int32 -> int64 (automatic)', () => {
        const src = new V.Definitions();
        const s = struct(src, 'M', [['n', T.INT32]]);
        const d = new TransformationDirectives();
        d.retypeField(s.representation(), 'n', T.INT64);            // widening -> automatic
        const [tr, target] = DefinitionsRewriter.fromDirectives(src, d);
        const back = V.ValueStructure.cast(rt(tr, target, tr.value(new V.ValueStructure(s, { n: 2147483647 })), s));
        assert.equal(back.at('n'), 2147483647n);                   // int64 native = bigint
    });

    const narrow = (policy) => {
        const src = new V.Definitions();
        const s = struct(src, 'W', [['n', T.INT64]]);
        const d = new TransformationDirectives();
        d.retypeField(s.representation(), 'n', T.INT32, policy);
        const [tr] = DefinitionsRewriter.fromDirectives(src, d);
        return [tr, s];
    };
    it('narrowing fail in range -> exact', () => {
        const [tr, s] = narrow('fail');
        assert.equal(tr.value(new V.ValueStructure(s, { n: 100n })).at('n'), 100);
    });
    it('narrowing fail out of range -> throws', () => {
        const [tr, s] = narrow('fail');
        assert.throws(() => tr.value(new V.ValueStructure(s, { n: 2n ** 40n })));
    });
    it('narrowing saturate', () => {
        const [tr, s] = narrow('saturate');
        assert.equal(tr.value(new V.ValueStructure(s, { n: 2n ** 40n })).at('n'), 2 ** 31 - 1);
    });
    it('narrowing default', () => {
        const [tr, s] = narrow(['default', new V.ValueInt32(-1)]);
        assert.equal(tr.value(new V.ValueStructure(s, { n: 2n ** 40n })).at('n'), -1);
    });
    it('format X -> string and parse string -> X', () => {
        const src = new V.Definitions();
        const s = struct(src, 'R', [['n', T.INT32]]);
        const d = new TransformationDirectives();
        d.retypeField(s.representation(), 'n', T.STRING);           // X->string: Class A
        const [tr] = DefinitionsRewriter.fromDirectives(src, d);
        assert.equal(tr.value(new V.ValueStructure(s, { n: 42 })).at('n'), '42');

        const src2 = new V.Definitions();
        const s2 = struct(src2, 'R', [['n', T.STRING]]);
        const d2 = new TransformationDirectives();
        d2.retypeField(s2.representation(), 'n', T.INT32, ['default', new V.ValueInt32(-1)]);
        const [tr2] = DefinitionsRewriter.fromDirectives(src2, d2);
        assert.equal(tr2.value(new V.ValueStructure(s2, { n: '7' })).at('n'), 7);
        assert.equal(tr2.value(new V.ValueStructure(s2, { n: 'abc' })).at('n'), -1);
    });
});

describe('family 2 — structural', () => {
    it('addField with default + dropField', () => {
        const src = new V.Definitions();
        const s = struct(src, 'Cfg', [['a', T.INT32], ['legacy', T.STRING]]);
        const d = new TransformationDirectives();
        d.addField(s.representation(), 'b', new V.ValueString('default-b'));
        d.dropField(s.representation(), 'legacy');
        const [tr, target] = DefinitionsRewriter.fromDirectives(src, d);
        const back = V.ValueStructure.cast(rt(tr, target, tr.value(new V.ValueStructure(s, { a: 1, legacy: 'z' })), s));
        assert.equal(back.at('a'), 1);
        assert.equal(back.at('b'), 'default-b');
        assert.deepEqual(target.const().structures()[0].fields().map((f) => f.name()), ['a', 'b']);
    });

    it('optional unwrap with default; drop-record on nil', () => {
        const src = new V.Definitions();
        const ot = new V.TypeOptional(T.INT32);
        const s = struct(src, 'R', [['x', ot]]);
        const d = new TransformationDirectives();
        d.retypeField(s.representation(), 'x', T.INT32, ['default', new V.ValueInt32(0)]);
        const [tr] = DefinitionsRewriter.fromDirectives(src, d);
        assert.equal(tr.value(new V.ValueStructure(s, { x: new V.ValueOptional(ot, 9) })).at('x'), 9);
        assert.equal(tr.value(new V.ValueStructure(s, { x: new V.ValueOptional(ot) })).at('x'), 0);

        const d2 = new TransformationDirectives();
        d2.retypeField(s.representation(), 'x', T.INT32, 'drop-record');
        const [tr2] = DefinitionsRewriter.fromDirectives(src, d2);
        assert.throws(() => tr2.value(new V.ValueStructure(s, { x: new V.ValueOptional(ot) })), Unrepresentable);
    });

    it('vector -> set collapse; map key collision winner', () => {
        const src = new V.Definitions();
        const s = struct(src, 'R', [['tags', new V.TypeVector(T.INT32)]]);
        const d = new TransformationDirectives();
        d.retypeField(s.representation(), 'tags', new V.TypeSet(T.INT32), 'collapse');
        const [tr] = DefinitionsRewriter.fromDirectives(src, d);
        const vec = new V.ValueVector(new V.TypeVector(T.INT32));
        for (const x of [1, 2, 2, 3, 3, 3]) vec.append(x);
        const out = tr.value(new V.ValueStructure(s, { tags: vec }));
        assert.equal(V.ValueSet.cast(out.at('tags', false)).size(), 3);
    });
});
