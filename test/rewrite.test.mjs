// Engine tests — the target-directed rewrite over dsviper. Values are rewritten and
// round-tripped through the real codec against the target registry (well-formed in the
// new registry, not merely constructed). A port of the Python engine tests.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import V from '../src/dsviper.mjs';
import { TransformationDirectives } from '../src/rewrite/index.mjs';
import { DefinitionsRewriter } from '../src/rewrite/index.mjs';

const T = V.Type;
const NS = new V.NameSpace(new V.ValueUUId('6ba7b810-9dad-11d1-80b4-00c04fd430c8'), 'Demo');

function struct(defs, name, fields) {
    const d = new V.TypeStructureDescriptor(name);
    for (const [fn, ft] of fields) d.addField(fn, ft);
    return defs.createStructure(NS, d);
}
const rt = (tr, target, value, sourceType) =>
    V.Value.decode(V.Value.encode(value), tr.mapType(sourceType), target.const());

describe('engine — family 1 (renames)', () => {
    it('renameField moves the id, keeps the data', () => {
        const src = new V.Definitions();
        const s = struct(src, 'Order', [['amount', T.INT32], ['note', T.STRING]]);
        const d = new TransformationDirectives();
        d.renameField(s.representation(), 'amount', 'total');
        const [tr, target] = DefinitionsRewriter.fromDirectives(src, d);
        const r = tr.value(new V.ValueStructure(s, { amount: 42, note: 'x' }));
        const back = V.ValueStructure.cast(rt(tr, target, r, s));
        assert.equal(back.at('total'), 42);
        assert.equal(back.at('note'), 'x');
        assert.notEqual(s.runtimeId().representation(), back.type().runtimeId().representation());
    });

    it('renameType restamps a key', () => {
        const src = new V.Definitions();
        const c = src.createConcept(NS, 'Account');
        const d = new TransformationDirectives();
        d.renameType(c.representation(), 'Demo::UserAccount');
        const [tr] = DefinitionsRewriter.fromDirectives(src, d);
        const rk = tr.value(V.ValueKey.create(c, new V.ValueUUId('11111111-1111-1111-1111-111111111111')));
        assert.equal(rk.typeConcept().representation(), 'Demo::UserAccount');
    });

    it('nested vector<optional<struct>> under a field rename', () => {
        const src = new V.Definitions();
        const item = struct(src, 'Item', [['qty', T.INT32]]);
        const d = new TransformationDirectives();
        d.renameField(item.representation(), 'qty', 'count');
        const [tr] = DefinitionsRewriter.fromDirectives(src, d);
        const vecT = new V.TypeVector(new V.TypeOptional(item));
        const vec = new V.ValueVector(vecT);
        vec.append(new V.ValueOptional(new V.TypeOptional(item), new V.ValueStructure(item, { qty: 3 })));
        vec.append(new V.ValueOptional(new V.TypeOptional(item)));
        const r = V.ValueVector.cast(tr.value(vec));
        const got = V.ValueOptional.cast(r.at(0, false)).unwrap(false);
        assert.equal(got.at('count'), 3);
        assert.ok(V.ValueOptional.cast(r.at(1, false)).isNil());
    });
});
