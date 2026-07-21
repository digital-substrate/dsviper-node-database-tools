// CommitDatabase faithful-replay — history preserved + commutation per commit (merges
// included) + intra-DAG commit_id remap. Port of the Python CommitDatabase-migration tests.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import V from '../src/dsviper.mjs';
import { TransformationDirectives } from '../src/rewrite/index.mjs';
import { DefinitionsRewriter, Unrepresentable } from '../src/rewrite/index.mjs';
import * as migrateCommitDatabase from '../src/migrate_commit_database.mjs';

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
                try { val = transformer.value(val); } catch (e) { if (e instanceof Unrepresentable) continue; throw e; }
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
function orderDb(qtyType = T.INT32) {
    const src = V.CommitDatabase.createInMemory();
    const defs = new V.Definitions();
    const customer = defs.createConcept(NS, 'Customer');
    const order = struct(defs, 'Order', [['qty', qtyType], ['label', T.STRING],
        ['tags', new V.TypeSet(T.STRING)],
        ['attrs', new V.TypeMap(T.STRING, T.INT32)],
        ['lines', new V.TypeXArray(T.INT32)]]);
    defs.createAttachment(NS, 'Orders', customer, order);
    src.extendDefinitions(defs.const());
    return { src, order };
}
function prove(src, directives, commits) {
    const [transformer, targetDefs] = DefinitionsRewriter.fromDirectives(src.definitions(), directives);
    const tgt = V.CommitDatabase.createInMemory();
    tgt.extendDefinitions(targetDefs.const());
    const info = migrateCommitDatabase.migrate(src, transformer, tgt);
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
        const [transformer, targetDefs] = DefinitionsRewriter.fromDirectives(src.definitions(), d);
        const tgt = V.CommitDatabase.createInMemory();
        tgt.extendDefinitions(targetDefs.const());
        const remap = migrateCommitDatabase.migrate(src, transformer, tgt).remap;

        const ag = V.CommitStateBuilder.state(tgt, remap[c2.representation()]).attachmentGetting();
        const tatt = tgt.definitions().attachments()[0];
        const d1 = V.ValueStructure.cast(ag.get(tatt, k1).unwrap(false));
        const d2 = V.ValueStructure.cast(ag.get(tatt, k2).unwrap(false));
        assert.equal(d1.at('prev', false).representation(), external.representation());          // external kept
        assert.equal(d2.at('prev', false).representation(), remap[c1.representation()].representation());  // remapped
    });
});

// Retype-at-path: a Document_Update whose value lands on a retyped field is routed through that
// field's Class-B policy (widen is automatic; narrow needs one). commutes per commit.
describe('CommitDatabase replay — retype at path', () => {
    function runRetype(newType, values, policy, srcQty = T.INT32) {
        const { src, order } = orderDb(srcQty);
        const att = src.definitions().attachments()[0];
        const k1 = att.createKey(new V.ValueUUId('11111111-1111-1111-1111-111111111111'));
        const cms0 = new V.CommitMutableState(V.CommitStateBuilder.initialState(src));
        cms0.attachmentMutating().set(att, k1, new V.ValueStructure(order, { qty: values[0], label: 'a' }));
        const c1 = src.commitMutations('set', cms0);
        const cms1 = new V.CommitMutableState(V.CommitStateBuilder.state(src, c1));
        cms1.attachmentMutating().update(att, k1, V.Path.fromField('qty').const(), values[1]);
        const c2 = src.commitMutations('update .qty', cms1);
        const d = new TransformationDirectives();
        d.retypeField(order.representation(), 'qty', newType, policy);
        prove(src, d, [c1, c2]);
    }

    it('widening int32->int64 at path', () => {
        runRetype(T.INT64, [5, 7], null);
    });

    it('narrowing int64->int32 saturates an out-of-range update', () => {
        runRetype(T.INT32, [100, 2 ** 40], 'saturate', T.INT64);
    });
});

// Container verbs (Set/Map/XArray) re-issued under a field rename, commuting per commit.
describe('CommitDatabase replay — container verbs', () => {
    it('Set/Map verbs under a rename', () => {
        const { src, order } = orderDb();
        const att = src.definitions().attachments()[0];
        const k1 = att.createKey(new V.ValueUUId('11111111-1111-1111-1111-111111111111'));
        const p = (f) => V.Path.fromField(f).const();
        const cms0 = new V.CommitMutableState(V.CommitStateBuilder.initialState(src));
        cms0.attachmentMutating().set(att, k1, new V.ValueStructure(
            order, { qty: 1, label: 'a', tags: ['a'], attrs: [['x', 1]] }));
        const c1 = src.commitMutations('set', cms0);
        const cms1 = new V.CommitMutableState(V.CommitStateBuilder.state(src, c1));
        const am = cms1.attachmentMutating();
        am.unionInSet(att, k1, p('tags'), new V.ValueSet(new V.TypeSet(T.STRING), ['b', 'c']));
        am.subtractInSet(att, k1, p('tags'), new V.ValueSet(new V.TypeSet(T.STRING), ['a']));
        am.unionInMap(att, k1, p('attrs'), new V.ValueMap(new V.TypeMap(T.STRING, T.INT32), [['y', 2]]));
        am.updateInMap(att, k1, p('attrs'), new V.ValueMap(new V.TypeMap(T.STRING, T.INT32), [['x', 9]]));
        am.subtractInMap(att, k1, p('attrs'), new V.ValueSet(new V.TypeSet(T.STRING), ['x']));
        const c2 = src.commitMutations('set/map ops', cms1);
        prove(src, renameQty(order), [c1, c2]);
    });

    it('XArray verbs (insert pair / update / remove) under a rename', () => {
        const { src, order } = orderDb();
        const att = src.definitions().attachments()[0];
        const k1 = att.createKey(new V.ValueUUId('11111111-1111-1111-1111-111111111111'));
        const pl = V.Path.fromField('lines').const();
        const p1 = new V.ValueUUId('aaaaaaaa-0000-0000-0000-000000000001');
        const p2 = new V.ValueUUId('aaaaaaaa-0000-0000-0000-000000000002');
        const cms0 = new V.CommitMutableState(V.CommitStateBuilder.initialState(src));
        cms0.attachmentMutating().set(att, k1, new V.ValueStructure(order, { qty: 1, label: 'a' }));
        const c1 = src.commitMutations('set', cms0);
        const cms1 = new V.CommitMutableState(V.CommitStateBuilder.state(src, c1));
        const am = cms1.attachmentMutating();
        am.insertInXarray(att, k1, pl, V.ValueXArray.END, p1, new V.ValueInt32(10));
        am.insertInXarray(att, k1, pl, V.ValueXArray.END, p2, new V.ValueInt32(20));
        am.updateInXarray(att, k1, pl, p1, new V.ValueInt32(11));
        am.removeInXarray(att, k1, pl, p2);
        const c2 = src.commitMutations('xarray ops', cms1);
        prove(src, renameQty(order), [c1, c2]);
    });
});

// The `run` entry point on a real file: open source read-only, replay to a fresh target file,
// history preserved, the update carried at the renamed field.
describe('CommitDatabase run — on disk', () => {
    it('real-file commit migration carries the update at a renamed field', () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cdbmig-'));
        const srcPath = path.join(tmp, 'src.cdb');
        const tgtPath = path.join(tmp, 'tgt.cdb');
        try {
            const src = V.CommitDatabase.create(srcPath);
            const defs = new V.Definitions();
            const customer = defs.createConcept(NS, 'Customer');
            const order = struct(defs, 'Order', [['qty', T.INT32]]);
            defs.createAttachment(NS, 'Orders', customer, order);
            src.extendDefinitions(defs.const());
            const att = src.definitions().attachments()[0];
            const k1 = att.createKey(new V.ValueUUId('11111111-1111-1111-1111-111111111111'));
            const cms0 = new V.CommitMutableState(V.CommitStateBuilder.initialState(src));
            cms0.attachmentMutating().set(att, k1, new V.ValueStructure(order, { qty: 5 }));
            const c1 = src.commitMutations('set', cms0);
            const cms1 = new V.CommitMutableState(V.CommitStateBuilder.state(src, c1));
            cms1.attachmentMutating().update(att, k1, V.Path.fromField('qty').const(), 7);
            src.commitMutations('update .qty', cms1);
            src.close();

            const buildDirectives = (_defs) => {
                const d = new TransformationDirectives();
                d.renameField('Demo::Order', 'qty', 'count');
                return d;
            };

            const info = migrateCommitDatabase.run(srcPath, buildDirectives, tgtPath);
            assert.deepEqual(info, { commits: 2, blobs: 0 });      // operator summary, history preserved

            const tgt = V.CommitDatabase.open(tgtPath, true);
            const state = V.CommitStateBuilder.state(tgt, tgt.lastCommitId());
            const tatt = tgt.definitions().attachments()[0];
            const key = state.attachmentGetting().keys(tatt).at(0, false);
            const doc = V.ValueStructure.cast(state.attachmentGetting().get(tatt, key).unwrap(false));
            assert.equal(doc.at('count', true), 7);                // update carried, field renamed
            tgt.close();
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });
});
