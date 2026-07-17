// The rest of the value-level surface: key flavours, Any, Tuple, Variant, XArray with
// tombstone, non-injective Set collapse, enum cases. Port of the Python engine tests.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import V from '../src/dsviper.mjs';
import { TransformationDirectives } from '../src/rewrite/index.mjs';
import { DefinitionsRewriter } from '../src/rewrite/index.mjs';

const T = V.Type;
const NS = new V.NameSpace(new V.ValueUUId('6ba7b810-9dad-11d1-80b4-00c04fd430c8'), 'Demo');
const INST = new V.ValueUUId('11111111-1111-1111-1111-111111111111');

function struct(defs, name, fields) {
    const d = new V.TypeStructureDescriptor(name);
    for (const [fn, ft] of fields) d.addField(fn, ft);
    return defs.createStructure(NS, d);
}
const rt = (tr, target, value, sourceType) =>
    V.Value.decode(V.Value.encode(value), tr.mapType(sourceType), target.const());
const flavor = (k) => {
    const tk = k.typeKey();
    return tk.isConcept() ? 'concept' : tk.isClub() ? 'club' : tk.isAnyConcept() ? 'any-concept' : '?';
};

describe('key flavours preserved under a concept rename', () => {
    const setup = () => {
        const src = new V.Definitions();
        const parent = src.createConcept(NS, 'Material');
        const concept = src.createConcept(NS, 'MaterialStandard', parent);
        const club = src.createClub(NS, 'Certified');
        src.createMembership(club, concept);
        const d = new TransformationDirectives();
        d.renameType('Demo::MaterialStandard', 'Demo::StandardMaterial');
        const [tr] = DefinitionsRewriter.fromDirectives(src, d);
        return { concept, club, tr };
    };
    it('concept key preserved + remapped', () => {
        const { concept, tr } = setup();
        const out = tr.value(V.ValueKey.create(concept, INST));
        assert.equal(flavor(out), 'concept');
        assert.equal(out.typeConcept().representation(), 'Demo::StandardMaterial');
    });
    it('any-concept key flavour preserved', () => {
        const { concept, tr } = setup();
        const out = tr.value(V.ValueKey.create(concept, INST).toAnyConceptKey());
        assert.equal(flavor(out), 'any-concept');
    });
    it('club key flavour preserved', () => {
        const { concept, club, tr } = setup();
        const out = tr.value(V.ValueKey.create(concept, INST).toClubKey(club));
        assert.equal(flavor(out), 'club');
    });
});

describe('Any / Tuple / Variant', () => {
    it('Any inner-type migration (shape change) by recursion', () => {
        const src = new V.Definitions();
        const s = struct(src, 'Payload', [['keep', T.INT32], ['legacy', T.STRING]]);
        const d = new TransformationDirectives();
        d.dropField(s.representation(), 'legacy');
        const [tr] = DefinitionsRewriter.fromDirectives(src, d);
        const out = tr.value(new V.ValueAny(new V.ValueStructure(s, { keep: 7, legacy: 'gone' })));
        const inner = V.ValueStructure.cast(V.ValueAny.cast(out).unwrap(false));
        assert.deepEqual(inner.typeStructure().fields().map((f) => f.name()), ['keep']);
        assert.equal(inner.at('keep'), 7);
    });

    it('Tuple + Variant under a field rename', () => {
        const src = new V.Definitions();
        const sEl = struct(src, 'P', [['x', T.INT32]]);
        const sRt = struct(src, 'Rt', [['t', new V.TypeTuple([T.INT32, sEl])],
            ['var', new V.TypeVariant([T.INT32, sEl])]]);
        const d = new TransformationDirectives();
        d.renameField(sEl.representation(), 'x', 'xx');
        const [tr] = DefinitionsRewriter.fromDirectives(src, d);
        const tup = new V.ValueTuple(new V.TypeTuple([T.INT32, sEl]), [5, new V.ValueStructure(sEl, { x: 7 })]);
        const varr = new V.ValueVariant(new V.TypeVariant([T.INT32, sEl]));
        varr.wrap(new V.ValueStructure(sEl, { x: 9 }), sEl);
        const r = tr.value(new V.ValueStructure(sRt, { t: tup, var: varr }));
        const rtup = V.ValueTuple.cast(r.at('t', false));
        assert.equal(rtup.at(0), 5);
        assert.equal(V.ValueStructure.cast(rtup.at(1, false)).at('xx'), 7);
        const rvar = V.ValueVariant.cast(r.at('var', false));
        assert.equal(V.ValueStructure.cast(rvar.unwrap(false)).at('xx'), 9);
    });
});

describe('XArray + Set collapse + enum', () => {
    it('XArray with a tombstone, elements re-mapped', () => {
        const src = new V.Definitions();
        const sEl = struct(src, 'Node', [['v', T.INT32]]);
        const s = struct(src, 'R', [['nodes', new V.TypeXArray(sEl)]]);
        const d = new TransformationDirectives();
        d.renameField(sEl.representation(), 'v', 'val');
        const [tr, target] = DefinitionsRewriter.fromDirectives(src, d);
        const xa = new V.ValueXArray(new V.TypeXArray(sEl));
        xa.insert(V.ValueXArray.END, new V.ValueStructure(sEl, { v: 10 }), V.ValueXArray.createPosition());
        const p1 = xa.insert(V.ValueXArray.END, new V.ValueStructure(sEl, { v: 20 }), V.ValueXArray.createPosition());
        xa.insert(V.ValueXArray.END, new V.ValueStructure(sEl, { v: 30 }), V.ValueXArray.createPosition());
        xa.disablePosition(p1);
        const back = V.ValueStructure.cast(rt(tr, target, tr.value(new V.ValueStructure(s, { nodes: xa })), s));
        const rx = V.ValueXArray.cast(back.at('nodes', false));
        assert.deepEqual(rx.items(false).map(([, v]) => V.ValueStructure.cast(v).at('val')), [10, 30]);
    });

    it('Set element collapse under a non-injective enum merge: refused, then policied', () => {
        const mk = (winner) => {
            const src = new V.Definitions();
            const ed = new V.TypeEnumerationDescriptor('Mode');
            ed.addCase('Old'); ed.addCase('New');
            const e = src.createEnumeration(NS, ed);
            const s = struct(src, 'R', [['modes', new V.TypeSet(e)]]);
            const d = new TransformationDirectives();
            d.removeCase(e.representation(), 'Old', ['map-case', 'New']);
            if (winner) d.resolveCollisions(winner);
            const [tr] = DefinitionsRewriter.fromDirectives(src, d);
            const st = new V.ValueSet(new V.TypeSet(e));
            st.add(new V.ValueEnumeration(e, 'Old'));
            st.add(new V.ValueEnumeration(e, 'New'));
            return [tr, s, st];
        };
        const [trF, sF, stF] = mk(null);
        assert.throws(() => trF.value(new V.ValueStructure(sF, { modes: stF })));
        const [trL, sL, stL] = mk('last');
        const out = V.ValueSet.cast(trL.value(new V.ValueStructure(sL, { modes: stL })).at('modes', false));
        assert.equal(out.size(), 1);
        assert.equal(V.ValueEnumeration.cast(out.at(0, false)).name(), 'New');
    });

    it('enum add + reorder cases', () => {
        const src = new V.Definitions();
        const ed = new V.TypeEnumerationDescriptor('E');
        for (const x of ['A', 'B', 'C']) ed.addCase(x);
        const e = src.createEnumeration(NS, ed);
        const s = struct(src, 'R', [['m', e]]);
        const d = new TransformationDirectives();
        d.addCase(e.representation(), 'D');
        d.reorderCases(e.representation(), ['D', 'C', 'A', 'B']);
        const [tr, target] = DefinitionsRewriter.fromDirectives(src, d);
        assert.deepEqual(target.const().enumerations()[0].cases().map((c) => c.name()), ['D', 'C', 'A', 'B']);
        const back = V.ValueStructure.cast(rt(tr, target, tr.value(new V.ValueStructure(s, { m: new V.ValueEnumeration(e, 'A') })), s));
        assert.equal(V.ValueEnumeration.cast(back.at('m', false)).name(), 'A');
    });
});
