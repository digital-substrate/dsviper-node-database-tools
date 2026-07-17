// Temporary smoke test for the freshly-ported engine. Run: node test/_smoke.mjs
import assert from 'node:assert/strict';
import V from '../src/dsviper.mjs';
import { TransformationDirectives } from '../src/rewrite/directives.mjs';
import { DefinitionsRewriter } from '../src/rewrite/engine.mjs';

const T = V.Type;
const NS = new V.NameSpace(new V.ValueUUId('6ba7b810-9dad-11d1-80b4-00c04fd430c8'), 'Demo');

function struct(defs, name, fields) {
    const d = new V.TypeStructureDescriptor(name);
    for (const [fn, ft] of fields) d.addField(fn, ft);
    return defs.createStructure(NS, d);
}
const rt = (tr, target, value, sourceType) =>
    V.Value.decode(V.Value.encode(value), tr.mapType(sourceType), target.const());

import { it } from 'node:test';
const check = (name, fn) => it(name, fn);

// 1. family 1 — rename field
check('renameField keeps data, remints id', () => {
    const src = new V.Definitions();
    const s = struct(src, 'Order', [['amount', T.INT32], ['note', T.STRING]]);
    const d = new TransformationDirectives();
    d.renameField(s.representation(), 'amount', 'total');
    const [tr, target] = DefinitionsRewriter.fromDirectives(src, d);
    const back = V.ValueStructure.cast(rt(tr, target, tr.value(new V.ValueStructure(s, { amount: 42, note: 'x' })), s));
    assert.equal(back.at('total'), 42);
    assert.equal(back.at('note'), 'x');
});

// 2. add_field with a static default
check('addField seeds a default', () => {
    const src = new V.Definitions();
    const s = struct(src, 'Cust', [['name', T.STRING]]);
    const d = new TransformationDirectives();
    d.addField(s.representation(), 'age', V.Value.create(T.INT32, 0));
    const [tr, target] = DefinitionsRewriter.fromDirectives(src, d);
    const back = V.ValueStructure.cast(rt(tr, target, tr.value(new V.ValueStructure(s, { name: 'a' })), s));
    assert.equal(back.at('name'), 'a');
    assert.equal(back.at('age'), 0);
});

// 3. retype widening (Class A)
check('retype int32->int64 widening', () => {
    const src = new V.Definitions();
    const s = struct(src, 'Row', [['n', T.INT32]]);
    const d = new TransformationDirectives();
    d.retypeField(s.representation(), 'n', T.INT64);
    const [tr, target] = DefinitionsRewriter.fromDirectives(src, d);
    const back = V.ValueStructure.cast(rt(tr, target, tr.value(new V.ValueStructure(s, { n: 7 })), s));
    assert.equal(back.at('n'), 7n);
});

// 4. NEW: container element retype Set<int32> -> Set<int64> (Class A)
check('container element retype Set<int32>->Set<int64>', () => {
    const src = new V.Definitions();
    const s = struct(src, 'Bag', [['tags', new V.TypeSet(T.INT32)]]);
    const d = new TransformationDirectives();
    d.retypeField(s.representation(), 'tags', new V.TypeSet(T.INT64));
    const [tr, target] = DefinitionsRewriter.fromDirectives(src, d);
    const set = new V.ValueSet(new V.TypeSet(T.INT32));
    set.add(1); set.add(2);
    const back = V.ValueStructure.cast(rt(tr, target, tr.value(new V.ValueStructure(s, { tags: set })), s));
    const outSet = V.ValueSet.cast(back.at('tags', false));
    assert.equal(outSet.size(), 2);
});

// 5. NEW: Vec element widening Vec<int32,3> -> Vec<int64,3> (Class A)
check('Vec element widening', () => {
    const src = new V.Definitions();
    const s = struct(src, 'Pt', [['v', new V.TypeVec(T.INT32, 3)]]);
    const d = new TransformationDirectives();
    d.retypeField(s.representation(), 'v', new V.TypeVec(T.INT64, 3));
    const [tr, target] = DefinitionsRewriter.fromDirectives(src, d);
    const vec = new V.ValueVec(new V.TypeVec(T.INT32, 3), [1, 2, 3]);
    const back = V.ValueStructure.cast(rt(tr, target, tr.value(new V.ValueStructure(s, { v: vec })), s));
    const outVec = V.ValueVec.cast(back.at('v', false));
    assert.equal(outVec.at(2), 3n);
});

// 6. NEW: retype narrowing needs a policy; saturate governs the offender
check('narrow int32->int16 saturate', () => {
    const src = new V.Definitions();
    const s = struct(src, 'Q', [['q', T.INT32]]);
    const d = new TransformationDirectives();
    d.retypeField(s.representation(), 'q', T.INT16, 'saturate');
    const [tr, target] = DefinitionsRewriter.fromDirectives(src, d);
    const back = V.ValueStructure.cast(rt(tr, target, tr.value(new V.ValueStructure(s, { q: 99999 })), s));
    assert.equal(back.at('q'), 32767);
});

