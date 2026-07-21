// Engine features — the remaining rewrite-engine surface not already covered by
// rewrite.test.mjs / family2.test.mjs / composite_retype.test.mjs / valueLevel.test.mjs.
// A port of the uncovered cases in the Python reference tests/test_rewrite.py, preserving
// the loss model and the total-or-explicit-refusal invariant. Values are round-tripped
// through the real codec against the TARGET registry (well-formed, not merely constructed).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import V from '../src/dsviper.mjs';
import { TransformationDirectives, DefinitionsRewriter, Unrepresentable } from '../src/rewrite/index.mjs';

const T = V.Type;
const NS = new V.NameSpace(new V.ValueUUId('6ba7b810-9dad-11d1-80b4-00c04fd430c8'), 'Demo');
const U2 = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const INST = '11111111-1111-1111-1111-111111111111';

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
const rt = (tr, target, value, sourceType) =>
    V.Value.decode(V.Value.encode(value), tr.mapType(sourceType), target.const());

// retype a single field `f`; returns [rewriter, source struct]
function mkField(srcT, tgtT, policy = null, collisions = null) {
    const src = new V.Definitions();
    const s = struct(src, 'S', [['f', srcT]]);
    const d = new TransformationDirectives();
    d.retypeField(s.representation(), 'f', tgtT, policy);
    if (collisions) d.resolveCollisions(collisions);
    const [rw] = DefinitionsRewriter.fromDirectives(src, d);
    return [rw, s];
}
// same, but also expose the built target (for round-tripping)
function mkFieldT(srcT, tgtT, policy = null) {
    const src = new V.Definitions();
    const s = struct(src, 'S', [['f', srcT]]);
    const d = new TransformationDirectives();
    d.retypeField(s.representation(), 'f', tgtT, policy);
    const [rw, target] = DefinitionsRewriter.fromDirectives(src, d);
    return [rw, target, s];
}

describe('family 1 — Any restamp + namespace axes', () => {
    it('Any restamped under a type rename', () => {
        const src = new V.Definitions();
        const s = struct(src, 'Address', [['x', T.INT32]]);
        const d = new TransformationDirectives();
        d.renameType(s.representation(), 'Demo::PostalAddress');
        const [tr] = DefinitionsRewriter.fromDirectives(src, d);
        const r = tr.value(new V.ValueAny(new V.ValueStructure(s, { x: 7 })));
        const inner = V.ValueAny.cast(r).unwrap(false);
        assert.equal(inner.type().representation(), 'Demo::PostalAddress');
        assert.equal(inner.at('x'), 7);
    });

    it('renameNamespace changes representation, not id', () => {
        const src = new V.Definitions();
        const c = src.createConcept(NS, 'Account');
        const d = new TransformationDirectives();
        d.renameNamespace(NS, 'DemoRenamed');
        const [tr] = DefinitionsRewriter.fromDirectives(src, d);
        assert.equal(tr.mapType(c).representation(), 'DemoRenamed::Account');
        assert.equal(tr.mapType(c).runtimeId().representation(), c.runtimeId().representation());
    });

    it('remapNamespace changes id, not representation', () => {
        const src = new V.Definitions();
        const c = src.createConcept(NS, 'Account');
        const d = new TransformationDirectives();
        d.remapNamespace(NS, new V.ValueUUId(U2));
        const [tr] = DefinitionsRewriter.fromDirectives(src, d);
        assert.equal(tr.mapType(c).representation(), 'Demo::Account');
        assert.notEqual(tr.mapType(c).runtimeId().representation(), c.runtimeId().representation());
        const rk = tr.value(V.ValueKey.create(c, new V.ValueUUId('44444444-4444-4444-4444-444444444444')));
        assert.equal(rk.typeConcept().representation(), 'Demo::Account');
    });

    it('the two namespace axes compose', () => {
        const src = new V.Definitions();
        const c = src.createConcept(NS, 'Account');
        const d = new TransformationDirectives();
        d.renameNamespace(NS, 'DemoV2');
        d.remapNamespace(NS, new V.ValueUUId(U2));
        const [tr] = DefinitionsRewriter.fromDirectives(src, d);
        assert.equal(tr.mapType(c).representation(), 'DemoV2::Account');
        assert.notEqual(tr.mapType(c).runtimeId().representation(), c.runtimeId().representation());
    });
});

describe('family 2 — Class A structural', () => {
    it('a type-zero (empty-string) default still seeds the field', () => {
        const src = new V.Definitions();
        const s = struct(src, 'Cfg', [['a', T.INT32]]);
        const d = new TransformationDirectives();
        d.addField(s.representation(), 'note', new V.ValueString(''));
        const [tr, target] = DefinitionsRewriter.fromDirectives(src, d);
        const back = V.ValueStructure.cast(rt(tr, target, tr.value(new V.ValueStructure(s, { a: 1 })), s));
        assert.equal(back.at('note'), '');
    });

    it('reorderFields permutes the target and preserves data', () => {
        const src = new V.Definitions();
        const s = struct(src, 'R', [['a', T.INT32], ['b', T.STRING], ['c', T.INT32]]);
        const d = new TransformationDirectives();
        d.reorderFields(s.representation(), ['c', 'b', 'a']);
        const [tr, target] = DefinitionsRewriter.fromDirectives(src, d);
        assert.deepEqual(target.const().structures()[0].fields().map((f) => f.name()), ['c', 'b', 'a']);
        const back = V.ValueStructure.cast(rt(tr, target, tr.value(new V.ValueStructure(s, { a: 1, b: 'x', c: 9 })), s));
        assert.equal(back.at('a'), 1);
        assert.equal(back.at('c'), 9);
    });

    it('Set -> Vector is Class A (order-canonical, no policy)', () => {
        const src = new V.Definitions();
        const s = struct(src, 'R', [['tags', new V.TypeSet(T.INT32)]]);
        const d = new TransformationDirectives();
        d.retypeField(s.representation(), 'tags', new V.TypeVector(T.INT32)); // NO policy
        const [tr, target] = DefinitionsRewriter.fromDirectives(src, d);
        const st = new V.ValueSet(new V.TypeSet(T.INT32));
        for (const x of [3, 1, 2]) st.add(x);
        const out = V.ValueStructure.cast(rt(tr, target, tr.value(new V.ValueStructure(s, { tags: st })), s));
        const vec = V.ValueVector.cast(out.at('tags', false));
        assert.equal(vec.size(), 3);
        const seen = [];
        for (let i = 0; i < vec.size(); i++) seen.push(vec.at(i));
        assert.deepEqual([...seen].sort((a, b) => a - b), [1, 2, 3]);
    });

    it('Vector -> XArray is Class A and DETERMINISTIC (verify-safe)', () => {
        const src = new V.Definitions();
        const s = struct(src, 'R', [['items', new V.TypeVector(T.INT32)]]);
        const d = new TransformationDirectives();
        d.retypeField(s.representation(), 'items', new V.TypeXArray(T.INT32)); // NO policy
        const [tr, target] = DefinitionsRewriter.fromDirectives(src, d);
        const vec = new V.ValueVector(new V.TypeVector(T.INT32));
        for (const x of [10, 20, 30]) vec.append(x);
        const doc = new V.ValueStructure(s, { items: vec });
        assert.deepEqual(V.Value.encode(tr.value(doc)), V.Value.encode(tr.value(doc))); // deterministic
        const back = V.ValueStructure.cast(rt(tr, target, tr.value(doc), s));
        const xa = V.ValueXArray.cast(back.at('items', false));
        const live = xa.toVector();
        const got = [];
        for (let i = 0; i < live.size(); i++) got.push(live.at(i));
        assert.deepEqual(got, [10, 20, 30]);
    });

    it('XArray -> Vector keeps live elements in position order (drops tombstones)', () => {
        const src = new V.Definitions();
        const s = struct(src, 'R', [['items', new V.TypeXArray(T.INT32)]]);
        const d = new TransformationDirectives();
        d.retypeField(s.representation(), 'items', new V.TypeVector(T.INT32)); // NO policy
        const [tr, target] = DefinitionsRewriter.fromDirectives(src, d);
        const xa = new V.ValueXArray(new V.TypeXArray(T.INT32));
        const p = xa.insert(V.ValueXArray.END, new V.ValueInt32(10), V.ValueXArray.createPosition());
        xa.insert(V.ValueXArray.END, new V.ValueInt32(20), V.ValueXArray.createPosition());
        xa.insert(V.ValueXArray.END, new V.ValueInt32(30), V.ValueXArray.createPosition());
        xa.disablePosition(p); // tombstone the first
        const back = V.ValueStructure.cast(rt(tr, target, tr.value(new V.ValueStructure(s, { items: xa })), s));
        const vec = V.ValueVector.cast(back.at('items', false));
        const got = [];
        for (let i = 0; i < vec.size(); i++) got.push(vec.at(i));
        assert.deepEqual(got, [20, 30]);
    });
});

describe('Class-B policies — remaining leaves', () => {
    it('unpolicied narrowing is refused at build time', () => {
        const src = new V.Definitions();
        const s = struct(src, 'W', [['n', T.INT64]]);
        const d = new TransformationDirectives();
        d.retypeField(s.representation(), 'n', T.INT32); // no policy
        assert.throws(() => DefinitionsRewriter.fromDirectives(src, d), /policy/);
    });

    it('remove_case with map-case remaps the removed case', () => {
        const src = new V.Definitions();
        const ed = new V.TypeEnumerationDescriptor('Mode');
        ed.addCase('Old'); ed.addCase('New');
        const e = src.createEnumeration(NS, ed);
        const s = struct(src, 'R', [['m', e]]);
        const d = new TransformationDirectives();
        d.removeCase(e.representation(), 'Old', ['map-case', 'New']);
        const [tr] = DefinitionsRewriter.fromDirectives(src, d);
        const mv = tr.value(new V.ValueStructure(s, { m: new V.ValueEnumeration(e, 'Old') })).at('m', false);
        assert.equal(V.ValueEnumeration.cast(mv).name(), 'New');
    });

    // SKIP: blocked by an engine map bug — `_mapElements`' map branch reads values with
    // `vm.items(false)`, which yields NATIVE (non-Value) values for primitive element types,
    // so `value()`/`_retypeElement` throw `v.type is not a function`. (Python's `items()`
    // returns Values.) Even a pure rename of a map<_, primitive> fails. Un-skip once fixed.
    it('map key collision — fail aborts; a winner discriminates', () => {
        const setup = (winner) => {
            const src = new V.Definitions();
            const ed = new V.TypeEnumerationDescriptor('Mode');
            ed.addCase('Old'); ed.addCase('New');
            const e = src.createEnumeration(NS, ed);
            const s = struct(src, 'R', [['cfgs', new V.TypeMap(e, T.INT32)]]);
            const d = new TransformationDirectives();
            d.removeCase(e.representation(), 'Old', ['map-case', 'New']);
            if (winner) d.resolveCollisions(winner);
            const [tr, target] = DefinitionsRewriter.fromDirectives(src, d);
            const mv = new V.ValueMap(new V.TypeMap(e, T.INT32));
            mv.set(new V.ValueEnumeration(e, 'Old'), 1);
            mv.set(new V.ValueEnumeration(e, 'New'), 2);
            return [tr, target, s, mv];
        };
        const [trF, , sF, mvF] = setup(null);
        assert.throws(() => trF.value(new V.ValueStructure(sF, { cfgs: mvF }))); // fail (default) aborts

        const survivor = (winner) => {
            const [tr, target, s, mv] = setup(winner);
            const om = V.ValueMap.cast(tr.value(new V.ValueStructure(s, { cfgs: mv })).at('cfgs', false));
            assert.equal(om.size(), 1);
            const tgtEnum = target.const().enumerations()[0];
            return om.at(new V.ValueEnumeration(tgtEnum, 'New'));
        };
        assert.deepEqual(new Set([survivor('first'), survivor('last')]), new Set([1, 2]));
    });
});

describe('Class-B policy composition (unwrap + narrow/parse)', () => {
    const optRetype = (tgt, policy, srcElem) => {
        const src = new V.Definitions();
        const s = struct(src, 'W', [['x', new V.TypeOptional(srcElem)]]);
        const d = new TransformationDirectives();
        d.retypeField(s.representation(), 'x', tgt, policy);
        const [rw] = DefinitionsRewriter.fromDirectives(src, d);
        return [rw, s];
    };
    const run = (rw, s, srcElem, n) => {
        const ot = new V.TypeOptional(srcElem);
        return rw.value(new V.ValueStructure(s, { x: new V.ValueOptional(ot, n) })).at('x');
    };

    it('unwrap then narrow (saturate)', () => {
        const [rw, s] = optRetype(T.INT32, 'saturate', T.INT64);
        assert.equal(run(rw, s, T.INT64, 2n ** 40n), 2 ** 31 - 1);
    });
    it('unwrap then narrow (default)', () => {
        const [rw, s] = optRetype(T.INT32, ['default', new V.ValueInt32(-1)], T.INT64);
        assert.equal(run(rw, s, T.INT64, 2n ** 40n), -1);
    });
    it('unwrap + narrow in range is exact', () => {
        const [rw, s] = optRetype(T.INT32, 'saturate', T.INT64);
        assert.equal(run(rw, s, T.INT64, 100n), 100);
    });
    it('unwrap then parse (default)', () => {
        const [rw, s] = optRetype(T.INT32, ['default', new V.ValueInt32(-1)], T.STRING);
        assert.equal(run(rw, s, T.STRING, 'abc'), -1);
        assert.equal(run(rw, s, T.STRING, '7'), 7);
    });
    it('unwrap then widen is exact (nil policy, inner widening lossless)', () => {
        const [rw, s] = optRetype(T.INT64, 'fail', T.INT32);
        assert.equal(run(rw, s, T.INT32, 5), 5n);
    });
});

describe('float -> int (Class B: truncate toward zero, then policy)', () => {
    const mk = (policy) => {
        const src = new V.Definitions();
        const s = struct(src, 'M', [['d', T.DOUBLE]]);
        const d = new TransformationDirectives();
        d.retypeField(s.representation(), 'd', T.INT32, policy);
        const [r] = DefinitionsRewriter.fromDirectives(src, d);
        return [r, s];
    };
    const go = (r, s, v) => r.value(new V.ValueStructure(s, { d: v })).at('d');

    it('truncates toward zero (in range: policy never fires)', () => {
        const [r, s] = mk('fail');
        assert.equal(go(r, s, 3.7), 3);
        assert.equal(go(r, s, -3.7), -3);
    });
    it('saturate clamps by the total order', () => {
        const [r, s] = mk('saturate');
        assert.equal(go(r, s, 1e300), 2 ** 31 - 1);        // finite out of range -> hi
        assert.equal(go(r, s, Infinity), 2 ** 31 - 1);
        assert.equal(go(r, s, -Infinity), -(2 ** 31));
        assert.equal(go(r, s, NaN), -(2 ** 31));           // NaN is the order's low end -> lo
    });
    it('non-finite under fail raises (loud, not a silent int-max)', () => {
        const [r, s] = mk('fail');
        assert.throws(() => go(r, s, NaN));
    });
    it('non-finite under default', () => {
        const [r, s] = mk(['default', new V.ValueInt32(-1)]);
        assert.equal(go(r, s, NaN), -1);
    });
    it('non-finite under drop-record', () => {
        const [r, s] = mk('drop-record');
        assert.throws(() => go(r, s, NaN), Unrepresentable);
    });
});

describe('guards & by-construction proof', () => {
    it('external target with an added field is refused (shape guard)', () => {
        const src = new V.Definitions();
        const tgt = new V.Definitions();
        struct(src, 'Rec', [['a', T.INT32]]);
        struct(tgt, 'Rec', [['a', T.INT32], ['b', T.STRING]]);
        assert.throws(() => new DefinitionsRewriter(src, tgt, new TransformationDirectives()));
    });
    it('P1 — a missing target is refused', () => {
        const src = new V.Definitions();
        struct(src, 'A', [['x', T.INT32]]);
        struct(src, 'B', [['y', T.INT32]]);
        const tgt = new V.Definitions();
        struct(tgt, 'A', [['x', T.INT32]]);               // no target for B
        assert.throws(() => new DefinitionsRewriter(src, tgt, new TransformationDirectives()), /P1/);
    });
    it('P2 — a field-count change is refused', () => {
        const src = new V.Definitions();
        struct(src, 'A', [['x', T.INT32], ['y', T.INT32]]);
        const tgt = new V.Definitions();
        struct(tgt, 'A', [['x', T.INT32]]);
        assert.throws(() => new DefinitionsRewriter(src, tgt, new TransformationDirectives()), /P2/);
    });
    it('P2 — a field reorder (external target) is refused', () => {
        const src = new V.Definitions();
        struct(src, 'A', [['x', T.INT32], ['y', T.INT32]]);
        const tgt = new V.Definitions();
        struct(tgt, 'A', [['y', T.INT32], ['x', T.INT32]]);
        assert.throws(() => new DefinitionsRewriter(src, tgt, new TransformationDirectives()), /P2/);
    });
    it('P2 — a vanished case is refused', () => {
        const src = new V.Definitions();
        enumT(src, 'E', ['A', 'B']);
        const tgt = new V.Definitions();
        enumT(tgt, 'E', ['A']);
        assert.throws(() => new DefinitionsRewriter(src, tgt, new TransformationDirectives()), /P2/);
    });
    it('reorderFields must be a permutation', () => {
        const src = new V.Definitions();
        const s = struct(src, 'S', [['a', T.INT32], ['b', T.INT32]]);
        const d = new TransformationDirectives();
        d.reorderFields(s.representation(), ['a', 'c']);   // "c" is not a field
        assert.throws(() => DefinitionsRewriter.fromDirectives(src, d), /permutation/);
    });
    it('reorderCases must be a permutation', () => {
        const src = new V.Definitions();
        const e = enumT(src, 'E', ['A', 'B']);
        const d = new TransformationDirectives();
        d.reorderCases(e.representation(), ['A', 'Z']);    // "Z" is not a case
        assert.throws(() => DefinitionsRewriter.fromDirectives(src, d), /permutation/);
    });
    it('commit_id remap: intra remapped, external kept verbatim', () => {
        const [tr] = DefinitionsRewriter.fromDirectives(new V.Definitions(), new TransformationDirectives());
        const internal = new V.ValueCommitId('a'.repeat(40));
        const reissued = new V.ValueCommitId('b'.repeat(40));
        const external = new V.ValueCommitId('c'.repeat(40));
        tr._commitIdRemap = { [internal.representation()]: reissued };
        assert.equal(tr.value(internal).representation(), reissued.representation());
        assert.equal(tr.value(external).representation(), external.representation());
    });
});

describe('containers verbatim + attachments + key instance id', () => {
    it('Vec/Mat carried verbatim under a sibling rename', () => {
        const src = new V.Definitions();
        const s = struct(src, 'Sample', [['p', new V.TypeVec(T.FLOAT, 3)],
            ['m', new V.TypeMat(T.DOUBLE, 2, 2)], ['label', T.STRING]]);
        const d = new TransformationDirectives();
        d.renameField(s.representation(), 'label', 'name');
        const [tr, target] = DefinitionsRewriter.fromDirectives(src, d);
        const doc = new V.ValueStructure(s, {
            p: new V.ValueVec(new V.TypeVec(T.FLOAT, 3), [1, 2, 3]),
            m: new V.ValueMat(new V.TypeMat(T.DOUBLE, 2, 2), [[1, 2], [3, 4]]),
            label: 'x',
        });
        const back = V.ValueStructure.cast(rt(tr, target, tr.value(doc), s));
        assert.deepEqual(V.Value.dumps(back.at('p', false)), [1, 2, 3]);
        assert.deepEqual(V.Value.dumps(back.at('m', false)), [[1, 2], [3, 4]]);
    });

    it('attachment created and renamed; runtimeId matches, data migrates', () => {
        const src = new V.Definitions();
        const c = src.createConcept(NS, 'Customer');
        const sDoc = struct(src, 'Order', [['qty', T.INT32]]);
        const att = src.createAttachment(NS, 'Orders', c, sDoc);
        const d = new TransformationDirectives();
        d.renameField(sDoc.representation(), 'qty', 'count');
        d.renameAttachment('Orders', 'OrderLog');
        const [tr, target] = DefinitionsRewriter.fromDirectives(src, d);
        const tatt = target.const().attachments()[0];
        assert.equal(tatt.identifier().split('.').pop(), 'OrderLog');
        assert.equal(tatt.runtimeId().representation(), tr.attachment(att).runtimeId().representation());
        const r = tr.value(new V.ValueStructure(sDoc, { qty: 5 }));
        assert.equal(r.at('count'), 5);
    });

    it('attachment directives address it by identifier', () => {
        // An attachment's identity is its `identifier()` — `NS::KeyConcept.name` — which is what
        // the directive parameters name (`oldId`, `identifier`). The bare local name still works
        // (legacy), but it is not an identity: two concepts in one namespace may each carry an
        // attachment of the same name, and a local-name directive then hits every homonym.
        const src = new V.Definitions();
        const customer = src.createConcept(NS, 'Customer');
        const vendor = src.createConcept(NS, 'Vendor');
        const order = struct(src, 'Order', [['qty', T.INT32]]);
        src.createAttachment(NS, 'orders', customer, order, 'by customer');
        src.createAttachment(NS, 'orders', vendor, order);
        assert.deepEqual(new Set(src.const().attachments().map((a) => a.identifier())),
            new Set([`${NS.name()}::Customer.orders`, `${NS.name()}::Vendor.orders`]));

        const d = new TransformationDirectives();
        d.renameAttachment(`${NS.name()}::Vendor.orders`, 'supplierOrders');   // ONE of the two
        d.documentAttachment(`${NS.name()}::Customer.orders`, 'kept, re-documented');
        const [, target] = DefinitionsRewriter.fromDirectives(src, d);
        const byId = new Map(target.const().attachments().map((a) => [a.identifier(), a]));
        assert.deepEqual(new Set(byId.keys()),
            new Set([`${NS.name()}::Customer.orders`, `${NS.name()}::Vendor.supplierOrders`]));
        assert.equal(byId.get(`${NS.name()}::Customer.orders`).documentation(), 'kept, re-documented');

        const legacy = new TransformationDirectives();
        legacy.renameAttachment('orders', 'everyOne');      // the local name: ambiguous, hits both
        const [, everyone] = DefinitionsRewriter.fromDirectives(src, legacy);
        assert.deepEqual(new Set(everyone.const().attachments().map((a) => a.identifier())),
            new Set([`${NS.name()}::Customer.everyOne`, `${NS.name()}::Vendor.everyOne`]));
    });

    it('key instance id is stable under a concept rename', () => {
        const src = new V.Definitions();
        const concept = src.createConcept(NS, 'Material');
        const d = new TransformationDirectives();
        d.renameType('Demo::Material', 'Demo::Stuff');
        const [tr] = DefinitionsRewriter.fromDirectives(src, d);
        const out = tr.value(V.ValueKey.create(concept, new V.ValueUUId(INST)));
        assert.equal(out.instanceId().representation(), INST);
    });
});

describe('value-level robustness — Set injective rename', () => {
    it('an injective case rename over a Set needs no collision policy', () => {
        const src = new V.Definitions();
        const ed = new V.TypeEnumerationDescriptor('Mode');
        ed.addCase('A'); ed.addCase('B');
        const e = src.createEnumeration(NS, ed);
        const s = struct(src, 'R', [['modes', new V.TypeSet(e)]]);
        const d = new TransformationDirectives();
        d.renameCase(e.representation(), 'A', 'Alpha');        // no collision policy
        const [tr] = DefinitionsRewriter.fromDirectives(src, d);
        const st = new V.ValueSet(new V.TypeSet(e));
        st.add(new V.ValueEnumeration(e, 'A'));
        st.add(new V.ValueEnumeration(e, 'B'));
        const out = V.ValueSet.cast(tr.value(new V.ValueStructure(s, { modes: st })).at('modes', false));
        assert.equal(out.size(), 2);
    });
});

describe('Vec/Mat element retype (fixed dims)', () => {
    it('Vec element widening is lossless (Class A)', () => {
        const [rw, target, s] = mkFieldT(new V.TypeVec(T.INT32, 3), new V.TypeVec(T.INT64, 3));
        const doc = new V.ValueStructure(s, { f: new V.ValueVec(new V.TypeVec(T.INT32, 3), [1, 2, 3]) });
        const back = V.ValueStructure.cast(rt(rw, target, rw.value(doc), s));
        assert.deepEqual(V.Value.dumps(back.at('f', false)), [1n, 2n, 3n]);
        assert.equal(back.at('f', false).type().representation(), 'vec<int64, 3>');
    });
    it('Mat element widening is lossless (Class A)', () => {
        const [rw, target, s] = mkFieldT(new V.TypeMat(T.FLOAT, 2, 2), new V.TypeMat(T.DOUBLE, 2, 2));
        const doc = new V.ValueStructure(s, { f: new V.ValueMat(new V.TypeMat(T.FLOAT, 2, 2), [[1, 2], [3, 4]]) });
        const back = V.ValueStructure.cast(rt(rw, target, rw.value(doc), s));
        assert.deepEqual(V.Value.dumps(back.at('f', false)), [[1, 2], [3, 4]]);
    });
    it('Vec element narrowing saturates per element', () => {
        const [rw, target, s] = mkFieldT(new V.TypeVec(T.INT64, 3), new V.TypeVec(T.INT32, 3), 'saturate');
        const doc = new V.ValueStructure(s, { f: new V.ValueVec(new V.TypeVec(T.INT64, 3), [2n ** 40n, 5n, -(2n ** 40n)]) });
        const back = V.ValueStructure.cast(rt(rw, target, rw.value(doc), s));
        assert.deepEqual(V.Value.dumps(back.at('f', false)), [2 ** 31 - 1, 5, -(2 ** 31)]);
    });
    it('Vec element narrowing needs a policy', () => {
        assert.throws(() => mkFieldT(new V.TypeVec(T.INT64, 3), new V.TypeVec(T.INT32, 3)), /policy/);
    });
    it('a Vec dimension change is refused (needs a resize directive)', () => {
        assert.throws(() => mkFieldT(new V.TypeVec(T.INT32, 3), new V.TypeVec(T.INT32, 4), 'saturate'), /dimension change/);
    });
    it('Vec -> Mat is refused', () => {
        assert.throws(() => mkFieldT(new V.TypeVec(T.INT32, 4), new V.TypeMat(T.INT32, 2, 2), 'saturate'), /not supported/);
    });
    it('rename (not retype) carries a Vec verbatim', () => {
        const src = new V.Definitions();
        const s = struct(src, 'S', [['p', new V.TypeVec(T.FLOAT, 3)], ['label', T.STRING]]);
        const d = new TransformationDirectives();
        d.renameField(s.representation(), 'label', 'name');
        const [tr] = DefinitionsRewriter.fromDirectives(src, d);
        const doc = new V.ValueStructure(s, { p: new V.ValueVec(new V.TypeVec(T.FLOAT, 3), [1, 2, 3]), label: 'x' });
        assert.deepEqual(V.Value.dumps(tr.value(doc).at('p', false)), [1, 2, 3]);
    });
});

describe('the Vector bridge', () => {
    it('Vec -> Vector flatten (Class A)', () => {
        const [rw, target, s] = mkFieldT(new V.TypeVec(T.INT32, 4), new V.TypeVector(T.INT32));
        const doc = new V.ValueStructure(s, { f: new V.ValueVec(new V.TypeVec(T.INT32, 4), [10, 20, 30, 40]) });
        const back = V.ValueStructure.cast(rt(rw, target, rw.value(doc), s));
        assert.deepEqual(V.Value.dumps(back.at('f', false)), [10, 20, 30, 40]);
    });
    it('Mat -> Vector flatten is column-major', () => {
        const [rw, target, s] = mkFieldT(new V.TypeMat(T.INT32, 2, 3), new V.TypeVector(T.INT32));
        const mat = new V.ValueMat(new V.TypeMat(T.INT32, 2, 3));
        let n = 0;
        for (let c = 0; c < 2; c++) for (let r = 0; r < 3; r++) mat.set(c, r, n++);
        const back = V.ValueStructure.cast(rt(rw, target, rw.value(new V.ValueStructure(s, { f: mat })), s));
        assert.deepEqual(V.Value.dumps(back.at('f', false)), [0, 1, 2, 3, 4, 5]);
    });
    const vectorToVec = (policy) => mkField(new V.TypeVector(T.INT32), new V.TypeVec(T.INT32, 4), policy);
    const vvecOf = (...xs) => {
        const v = new V.ValueVector(new V.TypeVector(T.INT32));
        for (const x of xs) v.append(x);
        return v;
    };
    it('Vector -> Vec at exact length', () => {
        const [rw, s] = vectorToVec('fail');
        const out = rw.value(new V.ValueStructure(s, { f: vvecOf(1, 2, 3, 4) }));
        assert.deepEqual(V.Value.dumps(out.at('f', false)), [1, 2, 3, 4]);
    });
    it('Vector -> Vec fit pads short and truncates long', () => {
        const [rw, s] = vectorToVec(['fit', 0]);
        const short = rw.value(new V.ValueStructure(s, { f: vvecOf(1, 2) }));
        assert.deepEqual(V.Value.dumps(short.at('f', false)), [1, 2, 0, 0]);
        const long = rw.value(new V.ValueStructure(s, { f: vvecOf(1, 2, 3, 4, 5, 6) }));
        assert.deepEqual(V.Value.dumps(long.at('f', false)), [1, 2, 3, 4]);
    });
    it('Vector -> Vec fail on a length mismatch', () => {
        const [rw, s] = vectorToVec('fail');
        assert.throws(() => rw.value(new V.ValueStructure(s, { f: vvecOf(1, 2, 3) })));
    });
    it('Vector -> Vec drop-record on a length mismatch', () => {
        const [rw, s] = vectorToVec('drop-record');
        assert.throws(() => rw.value(new V.ValueStructure(s, { f: vvecOf(1, 2, 3) })), Unrepresentable);
    });
    it('Vector -> Vec needs a policy', () => {
        assert.throws(() => vectorToVec(null), /policy/);
    });
    it('Vector -> Mat is refused (un-flatten ambiguous)', () => {
        assert.throws(() => mkField(new V.TypeVector(T.INT32), new V.TypeMat(T.INT32, 2, 2), 'fail'), /un-flatten/);
    });
    it('a flatten that also changes the element type is refused', () => {
        assert.throws(() => mkField(new V.TypeVec(T.INT32, 4), new V.TypeVector(T.INT64)), /preserves T/);
    });
});

describe('add_field defaults — domain-free gate', () => {
    it('a composite default (references a named type) is refused', () => {
        const src = new V.Definitions();
        const inner = struct(src, 'Inner', [['x', T.INT32]]);
        const host = struct(src, 'Host', [['a', T.INT32]]);
        const d = new TransformationDirectives();
        d.renameType(inner.representation(), 'Demo::InnerV2');
        d.addField(host.representation(), 'cfg', new V.ValueStructure(inner, { x: 9 }));
        assert.throws(() => DefinitionsRewriter.fromDirectives(src, d), /addField|named type/);
    });
    it('a primitive-leaf default is accepted', () => {
        const src = new V.Definitions();
        const host = struct(src, 'Host', [['a', T.INT32]]);
        const d = new TransformationDirectives();
        d.addField(host.representation(), 'note', new V.ValueString('hi'));
        const [tr, target] = DefinitionsRewriter.fromDirectives(src, d);
        const back = V.ValueStructure.cast(rt(tr, target, tr.value(new V.ValueStructure(host, { a: 1 })), host));
        assert.equal(back.at('note'), 'hi');
    });
    it('an xarray-of-primitive default is domain-free (accepted)', () => {
        const src = new V.Definitions();
        const host = struct(src, 'Host', [['a', T.INT32]]);
        const d = new TransformationDirectives();
        d.addField(host.representation(), 'tags', new V.ValueXArray(new V.TypeXArray(T.INT32)));
        DefinitionsRewriter.fromDirectives(src, d);           // must not throw
    });
    it('a container default whose element is a named type is refused (xarray & variant recurse)', () => {
        for (const kind of ['xarray', 'variant']) {
            const src = new V.Definitions();
            const inner = struct(src, 'Inner', [['x', T.INT32]]);
            const host = struct(src, 'Host', [['a', T.INT32]]);
            let dflt;
            if (kind === 'xarray') {
                dflt = new V.ValueXArray(new V.TypeXArray(inner));
            } else {
                dflt = new V.ValueVariant(new V.TypeVariant([T.INT32, inner]));
                dflt.wrap(new V.ValueInt32(1), T.INT32);
            }
            const d = new TransformationDirectives();
            d.addField(host.representation(), 'extra', dflt);
            assert.throws(() => DefinitionsRewriter.fromDirectives(src, d), /named type/);
        }
    });
});

describe('Vec/Mat dimension directives', () => {
    const vecOf = (...xs) => {
        const v = new V.ValueVec(new V.TypeVec(T.INT32, xs.length));
        xs.forEach((x, i) => v.set(i, x));
        return v;
    };
    const matOf = (cols) => {
        const m = new V.ValueMat(new V.TypeMat(T.INT32, cols.length, cols[0].length));
        cols.forEach((col, c) => col.forEach((x, r) => m.set(c, r, x)));
        return m;
    };
    const run = (srcT, build, value) => {
        const src = new V.Definitions();
        const s = struct(src, 'S', [['f', srcT]]);
        const d = new TransformationDirectives();
        build(d, s.representation());
        const [rw, target] = DefinitionsRewriter.fromDirectives(src, d);
        const back = V.ValueStructure.cast(rt(rw, target, rw.value(new V.ValueStructure(s, { f: value })), s));
        return V.Value.dumps(back.at('f', false));
    };

    it('resize Vec grow: zero-fill and scalar-fill', () => {
        assert.deepEqual(run(new V.TypeVec(T.INT32, 3), (d, s) => d.resizeVecField(s, 'f', 5), vecOf(1, 2, 3)),
            [1, 2, 3, 0, 0]);
        assert.deepEqual(run(new V.TypeVec(T.INT32, 3), (d, s) => d.resizeVecField(s, 'f', 5, { fill: 9 }), vecOf(1, 2, 3)),
            [1, 2, 3, 9, 9]);
    });
    it('resize Vec shrink: fail vs accept', () => {
        assert.throws(() => run(new V.TypeVec(T.INT32, 5), (d, s) => d.resizeVecField(s, 'f', 3), vecOf(1, 2, 3, 4, 5)));
        assert.deepEqual(run(new V.TypeVec(T.INT32, 5), (d, s) => d.resizeVecField(s, 'f', 3, { onShrink: 'accept' }), vecOf(1, 2, 3, 4, 5)),
            [1, 2, 3]);
    });
    it('resize Mat grow: identity extends the diagonal', () => {
        assert.deepEqual(run(new V.TypeMat(T.INT32, 2, 2), (d, s) => d.resizeMatField(s, 'f', 3, 3), matOf([[1, 2], [3, 4]])),
            [[1, 2, 0], [3, 4, 0], [0, 0, 1]]);
    });
    it('resize Mat grow: zero-fill', () => {
        assert.deepEqual(run(new V.TypeMat(T.INT32, 2, 2), (d, s) => d.resizeMatField(s, 'f', 3, 3, { fill: 'zero' }), matOf([[1, 2], [3, 4]])),
            [[1, 2, 0], [3, 4, 0], [0, 0, 0]]);
    });
    it('resize Mat shrink needs accept', () => {
        assert.throws(() => run(new V.TypeMat(T.INT32, 2, 3), (d, s) => d.resizeMatField(s, 'f', 3, 2), matOf([[0, 1, 2], [3, 4, 5]])));
    });
    it('transpose permutes [i,j] -> [j,i]', () => {
        assert.deepEqual(run(new V.TypeMat(T.INT32, 2, 3), (d, s) => d.transposeMatField(s, 'f'), matOf([[0, 1, 2], [3, 4, 5]])),
            [[0, 3], [1, 4], [2, 5]]);
    });
    it('resize vs transpose to the same shape differ (why intent must be named)', () => {
        const resized = run(new V.TypeMat(T.INT32, 2, 3), (d, s) => d.resizeMatField(s, 'f', 3, 2, { onShrink: 'accept' }), matOf([[0, 1, 2], [3, 4, 5]]));
        const transposed = run(new V.TypeMat(T.INT32, 2, 3), (d, s) => d.transposeMatField(s, 'f'), matOf([[0, 1, 2], [3, 4, 5]]));
        assert.deepEqual(resized, [[0, 1], [3, 4], [0, 0]]);
        assert.deepEqual(transposed, [[0, 3], [1, 4], [2, 5]]);
        assert.notDeepEqual(resized, transposed);
    });
    it('resize Vec fill=identity is refused (Mat-only)', () => {
        const src = new V.Definitions();
        const s = struct(src, 'S', [['f', new V.TypeVec(T.INT32, 3)]]);
        const d = new TransformationDirectives();
        d.resizeVecField(s.representation(), 'f', 5, { fill: 'identity' });
        assert.throws(() => DefinitionsRewriter.fromDirectives(src, d), /identity is Mat-only/);
    });
    it('resize a Vec buried in a Vector is refused (not addressable)', () => {
        const src = new V.Definitions();
        const s = struct(src, 'S', [['f', new V.TypeVector(new V.TypeVec(T.INT32, 3))]]);
        const d = new TransformationDirectives();
        d.resizeVecField(s.representation(), 'f', 5);
        assert.throws(() => DefinitionsRewriter.fromDirectives(src, d), /not a direct Vec/);
    });
    it('transpose on a non-Mat is refused', () => {
        const src = new V.Definitions();
        const s = struct(src, 'S', [['f', new V.TypeVec(T.INT32, 4)]]);
        const d = new TransformationDirectives();
        d.transposeMatField(s.representation(), 'f');
        assert.throws(() => DefinitionsRewriter.fromDirectives(src, d), /not a direct Mat/);
    });
});

describe('variant arm-set via retypeField', () => {
    const IS = () => new V.TypeVariant([T.INT32, T.STRING]);
    const ISD = () => new V.TypeVariant([T.INT32, T.STRING, T.DOUBLE]);
    const wrapV = (vt, val) => { const vv = new V.ValueVariant(vt); vv.wrap(val); return vv; };
    const mk = (srcV, tgtV, policy = null) => {
        const src = new V.Definitions();
        const s = struct(src, 'S', [['v', srcV]]);
        const d = new TransformationDirectives();
        d.retypeField(s.representation(), 'v', tgtV, policy);
        const [rw, target] = DefinitionsRewriter.fromDirectives(src, d);
        return [rw, target, s];
    };

    it('adding an arm is lossless (Class A)', () => {
        const [rw, target, s] = mk(IS(), ISD());
        const doc = new V.ValueStructure(s, { v: wrapV(IS(), new V.ValueInt32(42)) });
        const back = V.ValueStructure.cast(rt(rw, target, rw.value(doc), s));
        const out = V.ValueVariant.cast(back.at('v', false));
        assert.equal(V.Value.dumps(out.unwrap(false)), 42);
        assert.equal(out.type().representation(), 'int32|string|double');
    });
    it('reordering arms preserves the value (index-safe)', () => {
        const [rw, target, s] = mk(IS(), new V.TypeVariant([T.STRING, T.INT32]));
        const doc = new V.ValueStructure(s, { v: wrapV(IS(), new V.ValueString('hi')) });
        const back = V.ValueStructure.cast(rt(rw, target, rw.value(doc), s));
        const out = V.ValueVariant.cast(back.at('v', false));
        assert.equal(V.Value.dumps(out.unwrap(false)), 'hi');
        assert.equal(out.type().representation(), 'string|int32');
    });
    it('removing an arm needs a policy', () => {
        assert.throws(() => mk(ISD(), IS()), /arm removal/);
    });
    it('remove-arm drop-record skips the offender, keeps survivors', () => {
        const [rw, , s] = mk(ISD(), IS(), 'drop-record');
        assert.throws(() => rw.value(new V.ValueStructure(s, { v: wrapV(ISD(), new V.ValueDouble(1.5)) })), Unrepresentable);
        const surv = rw.value(new V.ValueStructure(s, { v: wrapV(ISD(), new V.ValueInt32(7)) }));
        assert.equal(V.Value.dumps(V.ValueVariant.cast(surv.at('v', false)).unwrap(false)), 7);
    });
    it('remove-arm default replaces the offender', () => {
        const dflt = wrapV(IS(), new V.ValueString('n/a'));
        const [rw, , s] = mk(ISD(), IS(), ['default', dflt]);
        const out = rw.value(new V.ValueStructure(s, { v: wrapV(ISD(), new V.ValueDouble(1.5)) }));
        assert.equal(V.Value.dumps(V.ValueVariant.cast(out.at('v', false)).unwrap(false)), 'n/a');
    });
    it('variant -> non-variant is refused', () => {
        assert.throws(() => mk(IS(), T.INT32, 'fail'), /variant/);
    });
});

describe('Class-C hooks — transformField (struct-scoped)', () => {
    it('hook primitive retype', () => {
        const src = new V.Definitions();
        const s = struct(src, 'S', [['n', T.INT32]]);
        const d = new TransformationDirectives();
        d.transformField(s.representation(), 'n', T.STRING, (st, f) => new V.ValueString('#' + st.at(f)));
        const [tr, target] = DefinitionsRewriter.fromDirectives(src, d);
        const back = V.ValueStructure.cast(rt(tr, target, tr.value(new V.ValueStructure(s, { n: 42 })), s));
        assert.equal(back.at('n'), '#42');
    });
    it('hook cross-field correction (from a sibling)', () => {
        const src = new V.Definitions();
        const s = struct(src, 'Money', [['amount', T.INT32], ['scale', T.INT32]]);
        const d = new TransformationDirectives();
        d.transformField(s.representation(), 'amount', T.INT32, (st, f) => new V.ValueInt32(st.at(f) * st.at('scale')));
        const [tr] = DefinitionsRewriter.fromDirectives(src, d);
        const out = tr.value(new V.ValueStructure(s, { amount: 3, scale: 100 }));
        assert.equal(out.at('amount'), 300);
    });
    it('one fn reused across fields via the field name', () => {
        const src = new V.Definitions();
        const s = struct(src, 'S', [['a', T.INT32], ['b', T.INT32]]);
        const tag = (st, f) => new V.ValueString(f + '=' + st.at(f));
        const d = new TransformationDirectives();
        d.transformField(s.representation(), 'a', T.STRING, tag);
        d.transformField(s.representation(), 'b', T.STRING, tag);
        const [tr] = DefinitionsRewriter.fromDirectives(src, d);
        const out = tr.value(new V.ValueStructure(s, { a: 1, b: 2 }));
        assert.equal(out.at('a'), 'a=1');
        assert.equal(out.at('b'), 'b=2');
    });
    it('hook to an unrelated named type (SG7)', () => {
        const src = new V.Definitions();
        const foo = struct(src, 'Foo', [['a', T.INT32]]);
        const bar = struct(src, 'Bar', [['label', T.STRING]]);
        const host = struct(src, 'Host', [['meta', foo]]);
        const fooToBar = (st, f, barT) => {
            const a = V.ValueStructure.cast(st.at(f, false)).at('a');
            return new V.ValueStructure(V.TypeStructure.cast(barT), { label: `a=${a}` });
        };
        const d = new TransformationDirectives();
        d.transformField(host.representation(), 'meta', bar, fooToBar);
        const [tr, target] = DefinitionsRewriter.fromDirectives(src, d);
        const doc = new V.ValueStructure(host, { meta: new V.ValueStructure(foo, { a: 7 }) });
        const back = V.ValueStructure.cast(rt(tr, target, tr.value(doc), host));
        const out = V.ValueStructure.cast(back.at('meta', false));
        assert.equal(out.type().representation(), 'Demo::Bar');
        assert.equal(out.at('label'), 'a=7');
    });
    it('a wrong-typed hook output is refused', () => {
        const src = new V.Definitions();
        const s = struct(src, 'S', [['n', T.INT32]]);
        const d = new TransformationDirectives();
        d.transformField(s.representation(), 'n', T.STRING, () => new V.ValueInt32(1));  // not a string
        const [tr] = DefinitionsRewriter.fromDirectives(src, d);
        assert.throws(() => tr.value(new V.ValueStructure(s, { n: 42 })), /hook/);
    });
    it('a non-Value hook output is refused', () => {
        const src = new V.Definitions();
        const s = struct(src, 'S', [['n', T.INT32]]);
        const d = new TransformationDirectives();
        d.transformField(s.representation(), 'n', T.STRING, () => 'raw js str');
        const [tr] = DefinitionsRewriter.fromDirectives(src, d);
        assert.throws(() => tr.value(new V.ValueStructure(s, { n: 42 })), /must return a Value/);
    });
    it('a hook may drop the record', () => {
        const src = new V.Definitions();
        const s = struct(src, 'S', [['n', T.INT32]]);
        const d = new TransformationDirectives();
        d.transformField(s.representation(), 'n', T.STRING, () => { throw new Unrepresentable('author drop'); });
        const [tr] = DefinitionsRewriter.fromDirectives(src, d);
        assert.throws(() => tr.value(new V.ValueStructure(s, { n: 42 })), Unrepresentable);
    });
});

describe('Class-C hooks — addField derive (struct-scoped)', () => {
    it('merge two fields into one (SG4)', () => {
        const src = new V.Definitions();
        const p = struct(src, 'P', [['first', T.STRING], ['last', T.STRING]]);
        const d = new TransformationDirectives();
        d.dropField(p.representation(), 'first');
        d.dropField(p.representation(), 'last');
        d.addField(p.representation(), 'full', T.STRING, (st) => new V.ValueString(st.at('first') + ' ' + st.at('last')));
        const [tr, target] = DefinitionsRewriter.fromDirectives(src, d);
        const back = V.ValueStructure.cast(rt(tr, target, tr.value(new V.ValueStructure(p, { first: 'Ada', last: 'L' })), p));
        assert.equal(back.at('full'), 'Ada L');
        assert.deepEqual(back.typeStructure().fields().map((f) => f.name()), ['full']);
    });
    it('the static-default 3-arg form still works', () => {
        const src = new V.Definitions();
        const host = struct(src, 'Host', [['a', T.INT32]]);
        const d = new TransformationDirectives();
        d.addField(host.representation(), 'note', new V.ValueString('hi'));
        const [tr, target] = DefinitionsRewriter.fromDirectives(src, d);
        const back = V.ValueStructure.cast(rt(tr, target, tr.value(new V.ValueStructure(host, { a: 1 })), host));
        assert.equal(back.at('note'), 'hi');
    });
    it('a wrong-typed derived field is refused', () => {
        const src = new V.Definitions();
        const p = struct(src, 'P', [['x', T.INT32]]);
        const d = new TransformationDirectives();
        d.addField(p.representation(), 'y', T.STRING, () => new V.ValueInt32(1));  // not a string
        const [tr] = DefinitionsRewriter.fromDirectives(src, d);
        assert.throws(() => tr.value(new V.ValueStructure(p, { x: 1 })));
    });
});

describe('Class-C hooks — transformType (global, value-scoped)', () => {
    const fooDefs = () => {
        const src = new V.Definitions();
        const foo = struct(src, 'Foo', [['a', T.INT32]]);
        return [src, foo];
    };
    const fooToStr = (v) => new V.ValueString('a=' + V.ValueStructure.cast(v).at('a'));

    it('one directive transforms every occurrence of the type', () => {
        const [src, foo] = fooDefs();
        const host = struct(src, 'Host', [['x', foo], ['y', foo]]);
        const d = new TransformationDirectives();
        d.transformType(foo, T.STRING, fooToStr);
        const [tr, target] = DefinitionsRewriter.fromDirectives(src, d);
        const out = tr.value(new V.ValueStructure(host, { x: new V.ValueStructure(foo, { a: 1 }), y: new V.ValueStructure(foo, { a: 2 }) }));
        assert.equal(out.at('x'), 'a=1');
        assert.equal(out.at('y'), 'a=2');
        assert.ok(!target.const().structures().map((s) => s.representation()).includes('Demo::Foo'));
    });
    it('reaches a nested occurrence for free', () => {
        const [src, foo] = fooDefs();
        const host = struct(src, 'H', [['items', new V.TypeVector(foo)]]);
        const d = new TransformationDirectives();
        d.transformType(foo, T.STRING, fooToStr);
        const [tr, target] = DefinitionsRewriter.fromDirectives(src, d);
        const vec = new V.ValueVector(new V.TypeVector(foo));
        for (const i of [10, 20]) vec.append(new V.ValueStructure(foo, { a: i }));
        const back = V.ValueStructure.cast(rt(tr, target, tr.value(new V.ValueStructure(host, { items: vec })), host));
        const out = V.ValueVector.cast(back.at('items', false));
        const got = [];
        for (let i = 0; i < out.size(); i++) got.push(out.at(i));
        assert.deepEqual(got, ['a=10', 'a=20']);
        assert.equal(out.type().representation(), 'vector<string>');
    });
    it('a field hook overrides the type hook (field > type)', () => {
        const [src, foo] = fooDefs();
        const host = struct(src, 'Host', [['x', foo], ['y', foo]]);
        const d = new TransformationDirectives();
        d.transformType(foo, T.STRING, fooToStr);
        d.transformField(host.representation(), 'x', T.INT32, () => new V.ValueInt32(999));
        const [tr] = DefinitionsRewriter.fromDirectives(src, d);
        const out = tr.value(new V.ValueStructure(host, { x: new V.ValueStructure(foo, { a: 1 }), y: new V.ValueStructure(foo, { a: 2 }) }));
        assert.equal(out.at('x'), 999);       // field hook wins
        assert.equal(out.at('y'), 'a=2');      // type hook fallback
    });
    it('transformType to a named target (SG7, globally)', () => {
        const [src, foo] = fooDefs();
        const bar = struct(src, 'Bar', [['label', T.STRING]]);
        const host = struct(src, 'Host', [['m', foo]]);
        const fooToBar = (v, barT) => {
            const a = V.ValueStructure.cast(v).at('a');
            return new V.ValueStructure(V.TypeStructure.cast(barT), { label: `a=${a}` });
        };
        const d = new TransformationDirectives();
        d.transformType(foo, bar, fooToBar);
        const [tr] = DefinitionsRewriter.fromDirectives(src, d);
        const out = V.ValueStructure.cast(tr.value(new V.ValueStructure(host, { m: new V.ValueStructure(foo, { a: 7 }) })).at('m', false));
        assert.equal(out.type().representation(), 'Demo::Bar');
        assert.equal(out.at('label'), 'a=7');
    });
});

describe('documentation carry & authoring (Class A, outside runtimeId)', () => {
    const docDefs = () => {
        const defs = new V.Definitions();
        const cust = defs.createConcept(NS, 'Customer', 'a customer');
        const ed = new V.TypeEnumerationDescriptor('Mode', 'the mode');
        ed.addCase('A', 'case A doc');
        ed.addCase('B', 'case B doc');
        const en = defs.createEnumeration(NS, ed);
        const sd = new V.TypeStructureDescriptor('Order', 'an order');
        sd.addField('qty', T.INT32, 'the quantity');
        sd.addField('label', T.STRING, 'the label');
        sd.addField('mode', en, 'the mode field');
        const od = defs.createStructure(NS, sd);
        defs.createAttachment(NS, 'Orders', cust, od, 'the orders');
        return [defs, en, od];
    };
    const pick = (list, suffix) => list.find((x) => x.representation().endsWith(suffix));

    it('a rename carries documentation everywhere', () => {
        const [defs, en, od] = docDefs();
        const d = new TransformationDirectives();
        d.renameField(od.representation(), 'qty', 'count');
        d.renameCase(en.representation(), 'A', 'Alpha');
        const [, tgt] = DefinitionsRewriter.fromDirectives(defs.const(), d);
        const tc = tgt.const();
        const st = V.TypeStructure.cast(pick(tc.structures(), 'Order'));
        const em = V.TypeEnumeration.cast(pick(tc.enumerations(), 'Mode'));
        const cc = pick(tc.concepts(), 'Customer');
        assert.equal(st.documentation(), 'an order');
        assert.deepEqual(Object.fromEntries(st.fields().map((f) => [f.name(), f.documentation()])),
            { count: 'the quantity', label: 'the label', mode: 'the mode field' });
        assert.equal(em.documentation(), 'the mode');
        assert.deepEqual(Object.fromEntries(em.cases().map((c) => [c.name(), c.documentation()])),
            { Alpha: 'case A doc', B: 'case B doc' });
        assert.equal(cc.documentation(), 'a customer');
        assert.equal(tc.attachments()[0].documentation(), 'the orders');
    });

    it('documentation is outside the runtimeId (a doc change does not re-id)', () => {
        const a = new V.Definitions();
        const sa = new V.TypeStructureDescriptor('Order'); sa.addField('qty', T.INT32, 'doc A');
        const oa = a.createStructure(NS, sa);
        const b = new V.Definitions();
        const sb = new V.TypeStructureDescriptor('Order'); sb.addField('qty', T.INT32, 'totally different');
        const ob = b.createStructure(NS, sb);
        assert.equal(oa.runtimeId().representation(), ob.runtimeId().representation());
    });

    it('document_* directives override / add / clear (members by source name)', () => {
        const defs = new V.Definitions();
        const cust = defs.createConcept(NS, 'Customer', 'old customer');
        const ed = new V.TypeEnumerationDescriptor('Mode', 'old mode');
        ed.addCase('A', 'old A'); ed.addCase('B', 'keep B');
        const en = defs.createEnumeration(NS, ed);
        const sd = new V.TypeStructureDescriptor('Order', 'old order');
        sd.addField('qty', T.INT32, 'old qty'); sd.addField('label', T.STRING, 'keep label');
        const od = defs.createStructure(NS, sd);
        defs.createAttachment(NS, 'Orders', cust, od, 'old orders');

        const d = new TransformationDirectives();
        d.renameField(od.representation(), 'qty', 'count');
        d.documentType(od.representation(), 'A customer order.');
        d.documentField(od.representation(), 'qty', 'Units ordered.');
        d.documentField(od.representation(), 'label', '');
        d.addField(od.representation(), 'note', new V.ValueString('n/a'));
        d.documentField(od.representation(), 'note', 'Free-text note.');
        d.documentType(cust.representation(), 'A registered customer.');
        d.documentType(en.representation(), 'Order lifecycle mode.');
        d.documentCase(en.representation(), 'A', 'The A case.');
        d.documentAttachment('Orders', 'Orders keyed by customer.');

        const [, tgt] = DefinitionsRewriter.fromDirectives(defs.const(), d);
        const tc = tgt.const();
        const st = V.TypeStructure.cast(pick(tc.structures(), 'Order'));
        const em = V.TypeEnumeration.cast(pick(tc.enumerations(), 'Mode'));
        const cc = pick(tc.concepts(), 'Customer');
        assert.equal(st.documentation(), 'A customer order.');
        assert.deepEqual(Object.fromEntries(st.fields().map((f) => [f.name(), f.documentation()])),
            { count: 'Units ordered.', label: '', note: 'Free-text note.' });
        assert.equal(em.documentation(), 'Order lifecycle mode.');
        assert.deepEqual(Object.fromEntries(em.cases().map((c) => [c.name(), c.documentation()])),
            { A: 'The A case.', B: 'keep B' });
        assert.equal(cc.documentation(), 'A registered customer.');
        assert.equal(tc.attachments()[0].documentation(), 'Orders keyed by customer.');
    });
});

describe('definition-level drops', () => {
    const dropDefs = () => {
        const defs = new V.Definitions();
        const cust = defs.createConcept(NS, 'Customer');
        const li = new V.TypeStructureDescriptor('LineItem'); li.addField('sku', T.STRING);
        const lineitem = defs.createStructure(NS, li);
        const iv = new V.TypeStructureDescriptor('Invoice'); iv.addField('line', lineitem);
        const inv = defs.createStructure(NS, iv);
        const od = new V.TypeStructureDescriptor('Order');
        od.addField('items', new V.TypeVector(lineitem)); od.addField('best', lineitem);
        const order = defs.createStructure(NS, od);
        defs.createAttachment(NS, 'Orders', cust, order);
        return [defs, lineitem, inv, order];
    };
    const names = (defs) => new Set(defs.const().structures().map((s) => s.representation().split('::').pop()));

    it('an unreferenced dropped type is omitted', () => {
        const [defs] = dropDefs();
        const free = new V.TypeStructureDescriptor('Scratch'); free.addField('n', T.INT32);
        const scratch = defs.createStructure(NS, free);
        const d = new TransformationDirectives(); d.dropType(scratch.representation());
        const [, tgt] = DefinitionsRewriter.fromDirectives(defs.const(), d);
        assert.ok(!names(tgt).has('Scratch'));
    });
    it('a referenced drop reports every dangling site at once', () => {
        const [defs, lineitem] = dropDefs();
        const d = new TransformationDirectives(); d.dropType(lineitem.representation());
        assert.throws(() => DefinitionsRewriter.fromDirectives(defs.const(), d), (e) => {
            assert.match(e.message, /dropped-type-referenced/);
            assert.match(e.message, /3 dangling/);
            assert.match(e.message, /Demo::Invoice/);
            assert.match(e.message, /Demo::Order/);
            return true;
        });
    });
    it('handled referrers let the drop through', () => {
        const [defs, lineitem, inv, order] = dropDefs();
        const d = new TransformationDirectives();
        d.dropType(lineitem.representation());
        d.dropType(inv.representation());
        d.dropField(order.representation(), 'items');
        d.retypeField(order.representation(), 'best', T.STRING);
        const [, tgt] = DefinitionsRewriter.fromDirectives(defs.const(), d);
        assert.deepEqual(names(tgt), new Set(['Order']));
    });
    it('dropType is polymorphic over enums', () => {
        const defs = new V.Definitions();
        const ed = new V.TypeEnumerationDescriptor('Mode'); ed.addCase('A'); ed.addCase('B');
        const en = defs.createEnumeration(NS, ed);
        const sd = new V.TypeStructureDescriptor('Keep'); sd.addField('x', T.INT32);
        defs.createStructure(NS, sd);
        const d = new TransformationDirectives(); d.dropType(en.representation());
        const [, tgt] = DefinitionsRewriter.fromDirectives(defs.const(), d);
        assert.equal(tgt.const().enumerations().length, 0);
    });
    it('dropAttachment omits it', () => {
        const [defs] = dropDefs();
        const d = new TransformationDirectives(); d.dropAttachment('Orders');
        const [, tgt] = DefinitionsRewriter.fromDirectives(defs.const(), d);
        assert.equal(tgt.const().attachments().length, 0);
    });
});

describe('namespace move / split / merge', () => {
    const SHOP = new V.NameSpace(new V.ValueUUId('11111111-1111-1111-1111-111111111111'), 'Shop');
    const ORDERS = new V.NameSpace(new V.ValueUUId('44444444-4444-4444-4444-444444444444'), 'Orders');
    const PRODUCTS = new V.NameSpace(new V.ValueUUId('55555555-5555-5555-5555-555555555555'), 'Products');

    it('split one namespace into two', () => {
        const defs = new V.Definitions();
        const s1 = new V.TypeStructureDescriptor('Order'); s1.addField('q', T.INT32);
        const o = defs.createStructure(SHOP, s1);
        const s2 = new V.TypeStructureDescriptor('Product'); s2.addField('sku', T.STRING);
        const p = defs.createStructure(SHOP, s2);
        const dr = new TransformationDirectives();
        dr.moveType(o.representation(), ORDERS);
        dr.moveType(p.representation(), PRODUCTS);
        const [, tgt] = DefinitionsRewriter.fromDirectives(defs.const(), dr);
        assert.deepEqual(tgt.const().structures().map((s) => s.representation()).sort(),
            ['Orders::Order', 'Products::Product']);
    });
    it('a reference follows the move', () => {
        const defs = new V.Definitions();
        const s1 = new V.TypeStructureDescriptor('Order'); s1.addField('q', T.INT32);
        const o = defs.createStructure(SHOP, s1);
        const iv = new V.TypeStructureDescriptor('Invoice'); iv.addField('line', o);
        defs.createStructure(SHOP, iv);
        const dr = new TransformationDirectives(); dr.moveType(o.representation(), ORDERS);
        const [, tgt] = DefinitionsRewriter.fromDirectives(defs.const(), dr);
        const inv = V.TypeStructure.cast(tgt.const().structures().find((s) => s.representation().endsWith('Invoice')));
        const line = inv.fields().find((f) => f.name() === 'line');
        assert.equal(line.type().representation(), 'Orders::Order');
    });
    it('a collision is reported', () => {
        const defs = new V.Definitions();
        const a = new V.TypeStructureDescriptor('Order'); a.addField('q', T.INT32);
        const oa = defs.createStructure(SHOP, a);
        const b = new V.TypeStructureDescriptor('Receipt'); b.addField('n', T.STRING);
        const ob = defs.createStructure(SHOP, b);
        const dr = new TransformationDirectives();
        dr.moveType(oa.representation(), ORDERS);
        dr.moveType(ob.representation(), ORDERS);
        dr.renameType(ob.representation(), 'Shop::Order');
        assert.throws(() => DefinitionsRewriter.fromDirectives(defs.const(), dr), (e) => {
            assert.match(e.message, /namespace-collision/);
            assert.match(e.message, /Orders::Order/);
            assert.match(e.message, /Shop::Order/);
            assert.match(e.message, /Shop::Receipt/);
            return true;
        });
    });
});

describe('container element retype (Set/Vector/Map/XArray<A> -> <B>)', () => {
    it('Set element widening is Class A (no policy)', () => {
        const [rw, s] = mkField(new V.TypeSet(T.INT32), new V.TypeSet(T.INT64));
        const set = new V.ValueSet(new V.TypeSet(T.INT32)); set.add(1); set.add(2);
        const out = V.ValueSet.cast(rw.value(new V.ValueStructure(s, { f: set })).at('f', false));
        assert.deepEqual(V.Value.dumps(out).map(BigInt).sort((a, b) => Number(a - b)), [1n, 2n]);
    });
    it('Vector element narrowing saturates per element', () => {
        const [rw, s] = mkField(new V.TypeVector(T.INT64), new V.TypeVector(T.INT32), 'saturate');
        const vec = new V.ValueVector(new V.TypeVector(T.INT64)); vec.append(1n); vec.append(2n ** 40n);
        const out = V.ValueVector.cast(rw.value(new V.ValueStructure(s, { f: vec })).at('f', false));
        assert.deepEqual(V.Value.dumps(out), [1, 2 ** 31 - 1]);
    });
    // SKIP: same engine map bug as above — a map<_, primitive> migration reads native values
    // from items(false) and crashes in _retypeElement. Un-skip once the engine reads Values.
    it('Map value narrowing saturates', () => {
        const [rw, s] = mkField(new V.TypeMap(T.STRING, T.INT64), new V.TypeMap(T.STRING, T.INT32), 'saturate');
        const mp = new V.ValueMap(new V.TypeMap(T.STRING, T.INT64)); mp.set('a', 2n ** 40n); mp.set('b', 3n);
        const out = V.ValueMap.cast(rw.value(new V.ValueStructure(s, { f: mp })).at('f', false));
        assert.equal(out.at('a'), 2 ** 31 - 1);
        assert.equal(out.at('b'), 3);
    });
    it('XArray element narrowing preserves positions', () => {
        const [rw, s] = mkField(new V.TypeXArray(T.INT64), new V.TypeXArray(T.INT32), 'saturate');
        const x = new V.ValueXArray(new V.TypeXArray(T.INT64));
        x.insert(V.ValueXArray.END, 5n, new V.ValueUUId('00000001-0000-0000-0000-000000000001'));
        x.insert(V.ValueXArray.END, 2n ** 40n, new V.ValueUUId('00000001-0000-0000-0000-000000000002'));
        const out = V.ValueXArray.cast(rw.value(new V.ValueStructure(s, { f: x })).at('f', false)).toVector();
        assert.deepEqual(V.Value.dumps(out), [5, 2 ** 31 - 1]);
    });
    it('element narrowing without a policy is refused', () => {
        assert.throws(() => mkField(new V.TypeSet(T.INT64), new V.TypeSet(T.INT32)), /element narrowing/);
    });
    it('a set-collapsing element migration needs a collision policy', () => {
        const [rw, s] = mkField(new V.TypeSet(T.INT64), new V.TypeSet(T.INT32), 'saturate');
        const set = new V.ValueSet(new V.TypeSet(T.INT64)); set.add(2n ** 40n); set.add(2n ** 41n);
        assert.throws(() => rw.value(new V.ValueStructure(s, { f: set })), /collapse/);
    });
    it('a set collapse resolves with a winner', () => {
        const [rw, s] = mkField(new V.TypeSet(T.INT64), new V.TypeSet(T.INT32), 'saturate', 'first');
        const set = new V.ValueSet(new V.TypeSet(T.INT64)); set.add(2n ** 40n); set.add(2n ** 41n);
        const out = V.ValueSet.cast(rw.value(new V.ValueStructure(s, { f: set })).at('f', false));
        assert.deepEqual(V.Value.dumps(out), [2 ** 31 - 1]);
    });
    it('a nested-container narrowing is policied through the recursion', () => {
        const sv = new V.TypeSet(new V.TypeVector(T.INT64));
        const tv = new V.TypeSet(new V.TypeVector(T.INT32));
        const [rw, s] = mkField(sv, tv, 'saturate');
        const inner = new V.ValueSet(sv);
        const iv = new V.ValueVector(new V.TypeVector(T.INT64)); iv.append(1n); iv.append(2n ** 40n);
        inner.add(iv);
        const out = V.ValueSet.cast(rw.value(new V.ValueStructure(s, { f: inner })).at('f', false));
        assert.deepEqual(V.Value.dumps(out), [[1, 2 ** 31 - 1]]);
    });
    it('a nested-container narrowing without a policy is refused', () => {
        const sv = new V.TypeSet(new V.TypeVector(T.INT64));
        const tv = new V.TypeSet(new V.TypeVector(T.INT32));
        assert.throws(() => mkField(sv, tv), /element narrowing/);
    });
});

describe('property-based (fuzzed) totality', () => {
    const SEED = 20260714;
    const N = 200;
    const richSource = () => {
        const src = new V.Definitions();
        const concept = src.createConcept(NS, 'Thing');
        const ed = new V.TypeEnumerationDescriptor('Mode');
        for (const c of ['A', 'B', 'C']) ed.addCase(c);
        const mode = src.createEnumeration(NS, ed);
        const inner = struct(src, 'Inner', [['x', T.INT32]]);
        const rich = struct(src, 'Rich', [
            ['n', T.INT32], ['s', T.STRING], ['opt', new V.TypeOptional(T.INT32)],
            ['vec', new V.TypeVector(T.INT32)], ['st', new V.TypeSet(T.STRING)],
            ['mp', new V.TypeMap(T.STRING, T.INT32)],
            ['tup', new V.TypeTuple([T.INT32, T.STRING])],
            ['var', new V.TypeVariant([T.INT32, T.STRING])], ['xa', new V.TypeXArray(T.INT32)],
            ['mode', mode], ['ref', new V.TypeKey(concept)], ['nested', inner],
            ['amt', T.DOUBLE]]);
        src.createAttachment(NS, 'Things', concept, rich);
        return [src, rich];
    };

    it('rename-only is TOTAL over fuzzed docs (round-trips in the target)', () => {
        const [src, rich] = richSource();
        const d = new TransformationDirectives();
        d.renameField(rich.representation(), 'n', 'num');
        d.renameType('Demo::Inner', 'Demo::InnerV2');
        const [tr, target] = DefinitionsRewriter.fromDirectives(src, d);
        const fuzzer = new V.Fuzzer(src.const(), SEED);
        for (let i = 0; i < N; i++) {
            const doc = fuzzer.fuzz(rich);
            rt(tr, target, tr.value(doc), rich);              // must not throw
        }
    });

    it('family 2 is rewrite-or-decreed-drop over fuzzed docs', () => {
        const [src, rich] = richSource();
        const d = new TransformationDirectives();
        d.retypeField(rich.representation(), 'n', T.INT16, 'saturate');      // narrow
        d.retypeField(rich.representation(), 'opt', T.INT32, 'drop-record'); // unwrap-or-drop
        d.retypeField(rich.representation(), 'amt', T.INT32, 'saturate');    // float->int
        const [tr, target] = DefinitionsRewriter.fromDirectives(src, d);
        const fuzzer = new V.Fuzzer(src.const(), SEED);
        let kept = 0; let drops = 0;
        for (let i = 0; i < N; i++) {
            const doc = fuzzer.fuzz(rich);
            let out;
            try {
                out = tr.value(doc);
            } catch (e) {
                if (e instanceof Unrepresentable) { drops++; continue; }
                throw e;
            }
            rt(tr, target, out, rich);                        // must round-trip in target
            kept++;
        }
        assert.equal(kept + drops, N);
    });
});
