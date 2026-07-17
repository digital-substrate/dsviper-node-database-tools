// Smoke test for migrate_commit_database.mjs. Run: node test/_smoke5.mjs
import assert from 'node:assert/strict';
import V from '../src/dsviper.mjs';
import { TransformationDirectives, DefinitionsRewriter } from '../src/rewrite/index.mjs';
import * as mcd from '../src/migrate_commit_database.mjs';

const T = V.Type;
const NS = new V.NameSpace(new V.ValueUUId('6ba7b810-9dad-11d1-80b4-00c04fd430c8'), 'Demo');
function struct(defs, name, fields) {
    const d = new V.TypeStructureDescriptor(name);
    for (const [fn, ft] of fields) d.addField(fn, ft);
    return defs.createStructure(NS, d);
}
import { it } from 'node:test';
const check = (name, fn) => it(name, fn);

function orderDb() {
    const src = V.CommitDatabase.createInMemory();
    const defs = new V.Definitions();
    const customer = defs.createConcept(NS, 'Customer');
    const order = struct(defs, 'Order', [['qty', T.INT32], ['label', T.STRING]]);
    defs.createAttachment(NS, 'Orders', customer, order);
    src.extendDefinitions(defs.const());
    return { src, order };
}
function migrateWith(src, d) {
    const [rewriter, targetDefs] = DefinitionsRewriter.fromDirectives(src.definitions(), d);
    const tgt = V.CommitDatabase.createInMemory();
    tgt.extendDefinitions(targetDefs.const());
    const info = mcd.migrate(src, rewriter, tgt);
    return { rewriter, tgt, info };
}

check('linear Set+Update replay + opcode-level verify', () => {
    const { src, order } = orderDb();
    const att = src.definitions().attachments()[0];
    const k1 = att.createKey(new V.ValueUUId('11111111-1111-1111-1111-111111111111'));
    const cms0 = new V.CommitMutableState(V.CommitStateBuilder.initialState(src));
    cms0.attachmentMutating().set(att, k1, new V.ValueStructure(order, { qty: 5, label: 'a' }));
    src.commitMutations('set', cms0);
    const cms1 = new V.CommitMutableState(V.CommitStateBuilder.state(src, src.commitIds()[src.commitIds().length - 1]));
    cms1.attachmentMutating().update(att, k1, V.Path.fromField('qty').const(), 7);
    src.commitMutations('update', cms1);

    const d = new TransformationDirectives();
    d.renameField(order.representation(), 'qty', 'count');
    const { rewriter, tgt, info } = migrateWith(src, d);
    assert.equal(info.commits, 2);
    assert.equal(tgt.commitIds().length, 2);
    const v = mcd.verify(src, rewriter, tgt, info.remap);      // opcode-level + topology
    assert.equal(v.commits, 2);
    assert.ok(v.checked >= 2);
});

check('merge of two divergent heads: verify passes (topology preserved)', () => {
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
    src.mergeCommit('merge', cA, cB);

    const d = new TransformationDirectives();
    d.renameField(order.representation(), 'qty', 'count');
    const { rewriter, tgt, info } = migrateWith(src, d);
    assert.equal(info.commits, 4);
    const v = mcd.verify(src, rewriter, tgt, info.remap);
    assert.equal(v.commits, 4);
});

check('dryRun previews opcodes without writing', () => {
    const { src, order } = orderDb();
    const att = src.definitions().attachments()[0];
    const k1 = att.createKey(new V.ValueUUId('11111111-1111-1111-1111-111111111111'));
    const cms0 = new V.CommitMutableState(V.CommitStateBuilder.initialState(src));
    cms0.attachmentMutating().set(att, k1, new V.ValueStructure(order, { qty: 5, label: 'a' }));
    src.commitMutations('set', cms0);
    const d = new TransformationDirectives();
    d.renameField(order.representation(), 'qty', 'count');
    const [rewriter] = DefinitionsRewriter.fromDirectives(src.definitions(), d);
    const rep = mcd.dryRun(src, rewriter);
    assert.equal(rep.commits, 1);
    assert.ok(rep.opcodes >= 1);
    assert.deepEqual(rep.unrepresentable, []);
});

check('drop-record refused up front on a CommitDatabase', () => {
    const { src, order } = orderDb();
    const d = new TransformationDirectives();
    d.retypeField(order.representation(), 'label', T.INT32, 'drop-record');   // record-scoped -> refused
    const [rewriter, targetDefs] = DefinitionsRewriter.fromDirectives(src.definitions(), d);
    const tgt = V.CommitDatabase.createInMemory();
    tgt.extendDefinitions(targetDefs.const());
    assert.throws(() => mcd.migrate(src, rewriter, tgt), /drop-record/);
});

