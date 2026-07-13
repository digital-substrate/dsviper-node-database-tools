// CommitDatabase faithful-replay — history preserved + commutation per commit (merges
// included) + intra-DAG commit_id remap. Port of the Python CommitDatabase-migration tests.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import V from '../src/dsviper.mjs';
import { TransformationDirectives } from '../src/directives.mjs';
import { DefinitionsTransformer, DropRecord } from '../src/rewrite.mjs';
import { migrateCommitDatabase } from '../src/commit_migrate.mjs';

const T = V.Type;
const NS = new V.NameSpace(new V.ValueUUId('6ba7b810-9dad-11d1-80b4-00c04fd430c8'), 'Demo');

function struct(defs, name, fields) {
    const d = new V.TypeStructureDescriptor(name);
    for (const [fn, ft] of fields) d.addField(fn, ft);
    return defs.createStructure(NS, d);
}

function snapshot(db, commitId, transformer) {
    const ag = V.CommitStateBuilder.state(db, commitId).attachmentGetting();
    const snap = {};
    for (const att of db.definitions().attachments()) {
        const keys = ag.keys(att);
        for (let i = 0; i < keys.size(); i++) {
            const key = keys.at(i, false);
            const doc = ag.get(att, key);
            if (doc.isNil()) continue;
            let val = doc.unwrap(false); let attLocal; let inst;
            if (transformer) {
                try { val = transformer.value(val); } catch (e) { if (e instanceof DropRecord) continue; throw e; }
                attLocal = transformer.attachment(att).identifier().split('.').pop();
                inst = transformer.value(key).instanceId().representation();
            } else {
                attLocal = att.identifier().split('.').pop();
                inst = key.instanceId().representation();
            }
            snap[`${attLocal}|${inst}`] = V.Value.dumps(val);
        }
    }
    return snap;
}

function renameQty(order) {
    const d = new TransformationDirectives();
    d.renameField(order.representation(), 'qty', 'count');
    return d;
}
function orderDb() {
    const src = V.CommitDatabase.createInMemory();
    const defs = new V.Definitions();
    const customer = defs.createConcept(NS, 'Customer');
    const order = struct(defs, 'Order', [['qty', T.INT32], ['label', T.STRING]]);
    defs.createAttachment(NS, 'Orders', customer, order);
    src.extendDefinitions(defs.const());
    return { src, order };
}
function prove(src, directives, commits) {
    const [transformer, targetDefs] = DefinitionsTransformer.fromDirectives(src.definitions(), directives);
    const tgt = V.CommitDatabase.createInMemory();
    tgt.extendDefinitions(targetDefs.const());
    const info = migrateCommitDatabase(src, transformer, tgt);
    assert.equal(tgt.commitIds().length, src.commitIds().length);       // history preserved
    for (const c of commits)
        assert.deepEqual(snapshot(src, c, transformer), snapshot(tgt, info.remap[c.representation()]));
    return { transformer, tgt, info };
}

describe('CommitDatabase replay', () => {
    it('linear Set + Update at a renamed field, commutes per commit', () => {
        const { src, order } = orderDb();
        const att = src.definitions().attachments()[0];
        const k1 = att.createKey(new V.ValueUUId('11111111-1111-1111-1111-111111111111'));
        const cms0 = new V.CommitMutableState(V.CommitStateBuilder.initialState(src));
        cms0.attachmentMutating().set(att, k1, new V.ValueStructure(order, { qty: 5, label: 'a' }));
        const c1 = src.commitMutations('set', cms0);
        const cms1 = new V.CommitMutableState(V.CommitStateBuilder.state(src, c1));
        cms1.attachmentMutating().update(att, k1, V.Path.fromField('qty').const(), 7);
        const c2 = src.commitMutations('update .qty', cms1);
        prove(src, renameQty(order), [c1, c2]);
    });

    it('merge of two divergent heads commutes', () => {
        const { src, order } = orderDb();
        const att = src.definitions().attachments()[0];
        const k1 = att.createKey(new V.ValueUUId('11111111-1111-1111-1111-111111111111'));
        const k2 = att.createKey(new V.ValueUUId('22222222-2222-2222-2222-222222222222'));
        const cms0 = new V.CommitMutableState(V.CommitStateBuilder.initialState(src));
        cms0.attachmentMutating().set(att, k1, new V.ValueStructure(order, { qty: 5, label: 'a' }));
        const c0 = src.commitMutations('base', cms0);
        const cmsA = new V.CommitMutableState(V.CommitStateBuilder.state(src, c0));
        cmsA.attachmentMutating().update(att, k1, V.Path.fromField('qty').const(), 7);
        const cA = src.commitMutations('A', cmsA);
        const cmsB = new V.CommitMutableState(V.CommitStateBuilder.state(src, c0));
        cmsB.attachmentMutating().set(att, k2, new V.ValueStructure(order, { qty: 9, label: 'b' }));
        const cB = src.commitMutations('B', cmsB);
        const cM = src.mergeCommit('merge A,B', cA, cB);
        prove(src, renameQty(order), [c0, cA, cB, cM]);
    });

    it('intra-DAG commit_id remapped, external kept', () => {
        const src = V.CommitDatabase.createInMemory();
        const defs = new V.Definitions();
        const concept = defs.createConcept(NS, 'C');
        const ref = struct(defs, 'Ref', [['note', T.STRING], ['prev', T.COMMIT_ID]]);
        defs.createAttachment(NS, 'Refs', concept, ref);
        src.extendDefinitions(defs.const());
        const att = src.definitions().attachments()[0];
        const k1 = att.createKey(new V.ValueUUId('11111111-1111-1111-1111-111111111111'));
        const k2 = att.createKey(new V.ValueUUId('22222222-2222-2222-2222-222222222222'));
        const external = V.ValueCommitId.tryParse('a'.repeat(40));
        const cms0 = new V.CommitMutableState(V.CommitStateBuilder.initialState(src));
        cms0.attachmentMutating().set(att, k1, new V.ValueStructure(ref, { note: 'a', prev: external }));
        const c1 = src.commitMutations('c1', cms0);
        const cms1 = new V.CommitMutableState(V.CommitStateBuilder.state(src, c1));
        cms1.attachmentMutating().set(att, k2, new V.ValueStructure(ref, { note: 'b', prev: c1 }));  // intra-DAG
        const c2 = src.commitMutations('c2', cms1);

        const d = new TransformationDirectives();
        d.renameField(ref.representation(), 'note', 'memo');
        const [transformer, targetDefs] = DefinitionsTransformer.fromDirectives(src.definitions(), d);
        const tgt = V.CommitDatabase.createInMemory();
        tgt.extendDefinitions(targetDefs.const());
        const remap = migrateCommitDatabase(src, transformer, tgt).remap;

        const ag = V.CommitStateBuilder.state(tgt, remap[c2.representation()]).attachmentGetting();
        const tatt = tgt.definitions().attachments()[0];
        const d1 = V.ValueStructure.cast(ag.get(tatt, k1).unwrap(false));
        const d2 = V.ValueStructure.cast(ag.get(tatt, k2).unwrap(false));
        assert.equal(d1.at('prev', false).representation(), external.representation());          // external kept
        assert.equal(d2.at('prev', false).representation(), remap[c1.representation()].representation());  // remapped
    });
});
