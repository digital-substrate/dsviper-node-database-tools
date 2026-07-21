// Round-trip verifier — it must PASS on a faithful migration and FAIL loudly on any
// divergence (value drift, dangling blob, a dropped record left behind, a broken DAG
// topology, an opcode-value mismatch). Port of the two Python reference modules:
//   tests/test_verify_database.py       (8 cases)
//   tests/test_verify_commit_database.py (10 cases)
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import V from '../src/dsviper.mjs';
import { TransformationDirectives, DefinitionsRewriter, VerificationError } from '../src/index.mjs';
import * as migrateDatabase from '../src/migrate_database.mjs';
import * as migrateCommitDatabase from '../src/migrate_commit_database.mjs';

const T = V.Type;
const NS = new V.NameSpace(new V.ValueUUId('6ba7b810-9dad-11d1-80b4-00c04fd430c8'), 'Demo');

function struct(defs, name, fields) {
    const d = new V.TypeStructureDescriptor(name);
    for (const [fn, ft] of fields) d.addField(fn, ft);
    return defs.createStructure(NS, d);
}

function assertRaisesVerification(fn, needle) {
    try {
        fn();
    } catch (e) {
        assert.ok(e instanceof VerificationError, `expected VerificationError, got ${e}`);
        assert.ok(String(e.message).includes(needle), `"${e.message}" should include "${needle}"`);
        return;
    }
    assert.fail('expected VerificationError to be thrown');
}


// ---------------------------------------------------------------------------
// silo 2 — Database verify
// ---------------------------------------------------------------------------

function sourceWithBlob() {
    const src = V.Database.createInMemory();
    const defs = new V.Definitions();
    const item = defs.createConcept(NS, 'Item');
    const docT = struct(defs, 'Doc', [['name', T.STRING], ['thumb', T.BLOB_ID], ['old', T.BLOB_ID]]);
    defs.createAttachment(NS, 'Items', item, docT);
    src.extendDefinitions(defs.const());
    const layout = new V.BlobLayout('uchar', 1);
    src.beginTransaction();
    const kept = src.createBlob(layout, new V.ValueBlob(Buffer.from([1, 2, 3, 4])));
    const orphan = src.createBlob(layout, new V.ValueBlob(Buffer.from([9, 9, 9])));
    const att = src.definitions().attachments()[0];
    const key = att.createKey(new V.ValueUUId('22222222-2222-2222-2222-222222222222'));
    src.set(att, key, new V.ValueStructure(docT, { name: 'x', thumb: kept, old: orphan }));
    src.commit();
    return { src, docT };
}

function migrateDb(src, directives) {
    const [rewriter, targetDefs] = DefinitionsRewriter.fromDirectives(src.definitions(), directives);
    const tgt = V.Database.createInMemory();
    tgt.extendDefinitions(targetDefs.const());
    migrateDatabase.migrate(src, rewriter, tgt);
    return { rewriter, tgt };
}

function renameAndDrop(docT) {
    const d = new TransformationDirectives();
    d.renameField(docT.representation(), 'name', 'title');
    d.dropField(docT.representation(), 'old');
    return d;
}

describe('Database verify', () => {
    it('passes on a faithful rename + blob', () => {
        const { src, docT } = sourceWithBlob();
        const { rewriter, tgt } = migrateDb(src, renameAndDrop(docT));
        const info = migrateDatabase.verify(src, rewriter, tgt);
        assert.deepEqual(info, { checked: 1, dropped: 0, referencedBlobs: 1 });
    });

    it('passes on drop-record (counts the dropped doc)', () => {
        const src = V.Database.createInMemory();
        const defs = new V.Definitions();
        const concept = defs.createConcept(NS, 'R');
        const docT = struct(defs, 'Rec', [['x', new V.TypeOptional(T.INT32)]]);
        defs.createAttachment(NS, 'Recs', concept, docT);
        src.extendDefinitions(defs.const());
        const att = src.definitions().attachments()[0];
        const ot = new V.TypeOptional(T.INT32);
        src.beginTransaction();
        src.set(att, att.createKey(new V.ValueUUId('44444444-4444-4444-4444-444444444444')),
            new V.ValueStructure(docT, { x: new V.ValueOptional(ot, 9) }));
        src.set(att, att.createKey(new V.ValueUUId('55555555-5555-5555-5555-555555555555')),
            new V.ValueStructure(docT, { x: new V.ValueOptional(ot) }));
        src.commit();
        const d = new TransformationDirectives();
        d.retypeField(docT.representation(), 'x', T.INT32, 'drop-record');
        d.acceptDocumentDrops();                       // explicit sign-off: drops may delete docs
        const { rewriter, tgt } = migrateDb(src, d);
        const info = migrateDatabase.verify(src, rewriter, tgt);
        assert.equal(info.checked, 1);
        assert.equal(info.dropped, 1);
    });

    it('fails on value drift', () => {
        const { src, docT } = sourceWithBlob();
        const { rewriter, tgt } = migrateDb(src, renameAndDrop(docT));
        // tamper with the target document after a faithful migration
        const tgtAtt = tgt.definitions().attachments()[0];
        const tk = tgt.keys(tgtAtt).at(0, false);
        const tdoc = V.ValueStructure.cast(tgt.get(tgtAtt, tk).unwrap(false));
        const tampered = new V.ValueStructure(tdoc.typeStructure(),
            { title: 'DRIFTED', thumb: tdoc.at('thumb', false) });
        tgt.beginTransaction(); tgt.set(tgtAtt, tk, tampered); tgt.commit();
        assertRaisesVerification(() => migrateDatabase.verify(src, rewriter, tgt), 'value mismatch');
    });

    it('fails on a dangling blob', () => {
        const { src, docT } = sourceWithBlob();
        const { rewriter, tgt } = migrateDb(src, renameAndDrop(docT));
        // delete the referenced blob out from under the document
        const tgtAtt = tgt.definitions().attachments()[0];
        const thumb = V.ValueStructure.cast(
            tgt.get(tgtAtt, tgt.keys(tgtAtt).at(0, false)).unwrap(false)).at('thumb', false);
        tgt.beginTransaction(); tgt.delBlob(thumb); tgt.commit();
        assertRaisesVerification(() => migrateDatabase.verify(src, rewriter, tgt), 'blob');
    });

    it('fails on a spurious document', () => {
        const { src, docT } = sourceWithBlob();
        const { rewriter, tgt } = migrateDb(src, renameAndDrop(docT));
        const tgtAtt = tgt.definitions().attachments()[0];
        const extra = tgtAtt.createKey(new V.ValueUUId('66666666-6666-6666-6666-666666666666'));
        const existing = V.ValueStructure.cast(
            tgt.get(tgtAtt, tgt.keys(tgtAtt).at(0, false)).unwrap(false));
        tgt.beginTransaction(); tgt.set(tgtAtt, extra, existing); tgt.commit();
        assertRaisesVerification(() => migrateDatabase.verify(src, rewriter, tgt), 'documents');
    });
});

// `verify` must re-derive the expected target through the SAME engine wiring `migrate` uses
// (source view for non-local hooks, self key for aggregate hooks), or a valid such migration
// self-verifies with a raw error; and a dropped attachment must be skipped, not crash.
describe('Database verify mirrors migrate', () => {
    function orderShop() {
        const src = V.Database.createInMemory();
        const defs = new V.Definitions();
        const cust = defs.createConcept(NS, 'Customer');
        const custDoc = struct(defs, 'CustomerDoc', [['name', T.STRING]]);
        const custs = defs.createAttachment(NS, 'Customers', cust, custDoc);
        const order = defs.createConcept(NS, 'Order');
        const orderDoc = struct(defs, 'OrderDoc', [['custRef', custs.typeKey()], ['amount', T.INT32]]);
        const orders = defs.createAttachment(NS, 'Orders', order, orderDoc);
        src.extendDefinitions(defs.const());
        const atts = {};
        for (const a of src.definitions().attachments()) atts[a.identifier().split('.').pop()] = a;
        const ck = atts.Customers.createKey(new V.ValueUUId('11111111-1111-1111-1111-111111111111'));
        const ok = atts.Orders.createKey(new V.ValueUUId('22222222-2222-2222-2222-222222222222'));
        src.beginTransaction();
        src.set(atts.Customers, ck, new V.ValueStructure(custDoc, { name: 'Ada' }));
        src.set(atts.Orders, ok, new V.ValueStructure(orderDoc, { custRef: ck, amount: 7 }));
        src.commit();
        return { src, custs, custDoc, orderDoc };
    }

    it('verify passes with a non-local hook', () => {
        const { src, custs, orderDoc } = orderShop();

        function deriveName(sourceStruct, fieldName, targetType, ctx) {
            const c = ctx.attachmentGetting.get(custs, sourceStruct.at('custRef', false));
            return new V.ValueString(V.ValueStructure.cast(c.unwrap(false)).at('name', false));
        }

        const d = new TransformationDirectives();
        d.addField(orderDoc.representation(), 'customerName', T.STRING, deriveName);
        const { rewriter, tgt } = migrateDb(src, d);
        const info = migrateDatabase.verify(src, rewriter, tgt);          // must NOT raise
        assert.equal(info.checked, 2);
    });

    it('verify passes with an aggregate hook (self key wired)', () => {
        const { src, custDoc } = orderShop();
        const seen = [];

        function needsSelfKey(sourceStruct, fieldName, targetType, ctx) {
            seen.push(ctx.selfKey.instanceId().representation());   // reads selfKey
            return new V.ValueInt32(0);
        }

        const d = new TransformationDirectives();
        d.addField(custDoc.representation(), 'tag', T.INT32, needsSelfKey);
        const { rewriter, tgt } = migrateDb(src, d);
        seen.length = 0;
        const info = migrateDatabase.verify(src, rewriter, tgt);          // must NOT raise
        assert.equal(info.checked, 2);
        assert.ok(seen.length > 0);                                       // the hook ran under verify
    });

    it('verify skips a dropped attachment', () => {
        const { src } = orderShop();
        const d = new TransformationDirectives();
        d.dropAttachment('Orders');
        d.acceptAttachmentDrops();
        const { rewriter, tgt } = migrateDb(src, d);
        const info = migrateDatabase.verify(src, rewriter, tgt);          // must NOT crash
        assert.equal(info.checked, 1);                                   // only the Customer survives
    });
});


// ---------------------------------------------------------------------------
// silo 3 — CommitDatabase verify
// ---------------------------------------------------------------------------

function orderDb() {
    const src = V.CommitDatabase.createInMemory();
    const defs = new V.Definitions();
    const customer = defs.createConcept(NS, 'Customer');
    const order = struct(defs, 'Order', [['qty', T.INT32], ['label', T.STRING]]);
    defs.createAttachment(NS, 'Orders', customer, order);
    src.extendDefinitions(defs.const());
    return { src, order };
}

function renameQty(order) {
    const d = new TransformationDirectives();
    d.renameField(order.representation(), 'qty', 'count');
    return d;
}

function migrateCommit(src, directives) {
    const [rewriter, targetDefs] = DefinitionsRewriter.fromDirectives(src.definitions(), directives);
    const tgt = V.CommitDatabase.createInMemory();
    tgt.extendDefinitions(targetDefs.const());
    const info = migrateCommitDatabase.migrate(src, rewriter, tgt);
    return { rewriter, tgt, info };
}

function linear() {
    const { src, order } = orderDb();
    const att = src.definitions().attachments()[0];
    const k1 = att.createKey(new V.ValueUUId('11111111-1111-1111-1111-111111111111'));
    const cms0 = new V.CommitMutableState(V.CommitStateBuilder.initialState(src));
    cms0.attachmentMutating().set(att, k1, new V.ValueStructure(order, { qty: 5, label: 'a' }));
    const c1 = src.commitMutations('set', cms0);
    const cms1 = new V.CommitMutableState(V.CommitStateBuilder.state(src, c1));
    cms1.attachmentMutating().update(att, k1, V.Path.fromField('qty').const(), 7);
    const c2 = src.commitMutations('update .qty', cms1);
    return { src, order, c1, c2 };
}

describe('CommitDatabase verify', () => {
    it('passes on a faithful linear replay', () => {
        const { src, order } = linear();
        const { rewriter, tgt, info } = migrateCommit(src, renameQty(order));
        const result = migrateCommitDatabase.verify(src, rewriter, tgt, info.remap);
        assert.equal(result.commits, 2);
        // c1 carries one Document_Set, c2 one Document_Update -> two opcodes verified
        assert.equal(result.checked, 2);
    });

    it('passes on a faithful merge', () => {
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
        src.mergeCommit('merge A,B', cA, cB);                  // merges the two divergent heads
        const { rewriter, tgt, info } = migrateCommit(src, renameQty(order));
        const result = migrateCommitDatabase.verify(src, rewriter, tgt, info.remap);
        assert.equal(result.commits, src.commitIds().length);
        assert.equal(result.commits, 4);                      // base, A, B, merge
    });

    it('passes with an intra-DAG commit_id remap (and clears the remap hook)', () => {
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
        cms1.attachmentMutating().set(att, k2, new V.ValueStructure(ref, { note: 'b', prev: c1 }));
        src.commitMutations('c2', cms1);

        const d = new TransformationDirectives();
        d.renameField(ref.representation(), 'note', 'memo');
        const { rewriter, tgt, info } = migrateCommit(src, d);
        const result = migrateCommitDatabase.verify(src, rewriter, tgt, info.remap);
        assert.equal(result.commits, 2);
        // verifier left the rewriter's remap hook cleared
        assert.equal(rewriter._commitIdRemap, null);
    });

    it('passes with a carried blob', () => {
        const src = V.CommitDatabase.createInMemory();
        const blob = src.createBlobFromBuffer(Buffer.from('receipt bytes'));
        const defs = new V.Definitions();
        const customer = defs.createConcept(NS, 'Customer');
        const order = struct(defs, 'Order', [['qty', T.INT32], ['receipt', T.BLOB_ID]]);
        defs.createAttachment(NS, 'Orders', customer, order);
        src.extendDefinitions(defs.const());
        const att = src.definitions().attachments()[0];
        const k1 = att.createKey(new V.ValueUUId('11111111-1111-1111-1111-111111111111'));
        const cms0 = new V.CommitMutableState(V.CommitStateBuilder.initialState(src));
        cms0.attachmentMutating().set(att, k1, new V.ValueStructure(order, { qty: 5, receipt: blob }));
        src.commitMutations('set', cms0);
        const { rewriter, tgt, info } = migrateCommit(src, renameQty(order));
        const result = migrateCommitDatabase.verify(src, rewriter, tgt, info.remap);
        assert.equal(result.referencedBlobs, 1);
    });

    it('fails when a commit was not re-issued', () => {
        const { src, order, c1 } = linear();
        const { rewriter, tgt, info } = migrateCommit(src, renameQty(order));
        const broken = { ...info.remap };
        delete broken[c1.representation()];                   // pretend c1 was lost
        assertRaisesVerification(
            () => migrateCommitDatabase.verify(src, rewriter, tgt, broken), 're-issued');
    });

    it('fails when a wrong remap lands the wrong state (broken parent link)', () => {
        // swap the two commits' target ids: source@c1 (a root Set) now maps to the image of
        // c2 (a child Update) -> the broken parent link is caught.
        const { src, order, c1, c2 } = linear();
        const { rewriter, tgt, info } = migrateCommit(src, renameQty(order));
        const swapped = { ...info.remap };
        [swapped[c1.representation()], swapped[c2.representation()]] =
            [info.remap[c2.representation()], info.remap[c1.representation()]];
        assertRaisesVerification(
            () => migrateCommitDatabase.verify(src, rewriter, tgt, swapped), 'parent link');
    });

    it('fails on opcode value drift', () => {
        // verify against a DIFFERENT rewriter than migrate used (renames to another field) — the
        // topology is intact, so the opcode-value check is what must catch the drift.
        const { src, order } = linear();
        const { tgt, info } = migrateCommit(src, renameQty(order));       // migrated qty -> count
        const other = new TransformationDirectives();
        other.renameField(order.representation(), 'qty', 'tally');        // a divergent rewrite
        const [wrong] = DefinitionsRewriter.fromDirectives(src.definitions(), other);
        assertRaisesVerification(
            () => migrateCommitDatabase.verify(src, wrong, tgt, info.remap), 'mismatch');
    });

    it('fails on broken topology with identical opcodes', () => {
        // two Mutations commits with IDENTICAL opcodes (same key + value) but different parents
        // (one a root, one its child). Swapping their remap keeps every opcode matching -> only
        // the parent link differs; verify must catch the broken topology, not just the opcodes.
        const { src, order } = orderDb();
        const att = src.definitions().attachments()[0];
        const k1 = att.createKey(new V.ValueUUId('11111111-1111-1111-1111-111111111111'));
        const cms0 = new V.CommitMutableState(V.CommitStateBuilder.initialState(src));
        cms0.attachmentMutating().set(att, k1, new V.ValueStructure(order, { qty: 5, label: 'a' }));
        const c1 = src.commitMutations('set', cms0);                        // root
        const cms1 = new V.CommitMutableState(V.CommitStateBuilder.state(src, c1));
        cms1.attachmentMutating().set(att, k1, new V.ValueStructure(order, { qty: 5, label: 'a' }));
        const c2 = src.commitMutations('set again', cms1);                  // child of c1, identical opcode
        const { rewriter, tgt, info } = migrateCommit(src, renameQty(order));
        const swapped = { ...info.remap };
        [swapped[c1.representation()], swapped[c2.representation()]] =
            [info.remap[c2.representation()], info.remap[c1.representation()]];
        assertRaisesVerification(
            () => migrateCommitDatabase.verify(src, rewriter, tgt, swapped), 'parent link');
    });
});

// `verify` checks that each *opcode* was correctly rewritten, not that every materialised
// document re-derives from every commit's snapshot. So a non-local hook whose input varies
// across the history no longer false-fails.
describe('CommitDatabase verify is opcode-faithful', () => {
    function custOrderSchema() {
        const src = V.CommitDatabase.createInMemory();
        const defs = new V.Definitions();
        const customer = defs.createConcept(NS, 'Customer');
        const custDoc = struct(defs, 'CustomerDoc', [['name', T.STRING]]);
        const custs = defs.createAttachment(NS, 'Customers', customer, custDoc);
        const order = defs.createConcept(NS, 'Order');
        const orderDoc = struct(defs, 'OrderDoc', [['custRef', custs.typeKey()], ['qty', T.INT32]]);
        const orders = defs.createAttachment(NS, 'Orders', order, orderDoc);
        src.extendDefinitions(defs.const());
        return { src, custDoc, orderDoc, custs, orders };
    }

    it('aggregate over a growing DAG verifies', () => {
        // Customer.orderCount folds an INCOMING reference; the set grows commit to commit. migrate
        // freezes it at each write; verify checks the write opcode, not a re-fold -> no false fail.
        const { src, custDoc, custs, orders } = custOrderSchema();
        const ck = custs.createKey(new V.ValueUUId('11111111-1111-1111-1111-111111111111'));
        const o1 = orders.createKey(new V.ValueUUId('22222222-2222-2222-2222-222222222222'));
        const o2 = orders.createKey(new V.ValueUUId('33333333-3333-3333-3333-333333333333'));
        const odt = orders.documentType();
        const cms0 = new V.CommitMutableState(V.CommitStateBuilder.initialState(src));
        const am = cms0.attachmentMutating();
        am.set(custs, ck, new V.ValueStructure(custDoc, { name: 'Ada' }));
        am.set(orders, o1, new V.ValueStructure(odt, { custRef: ck, qty: 7 }));
        const c0 = src.commitMutations('cust+order1', cms0);
        const cms1 = new V.CommitMutableState(V.CommitStateBuilder.state(src, c0));
        cms1.attachmentMutating().set(orders, o2, new V.ValueStructure(odt, { custRef: ck, qty: 10 }));
        src.commitMutations('order2', cms1);

        function orderCount(sourceStruct, fieldName, targetType, ctx) {
            let n = 0;
            const keys = ctx.attachmentGetting.keys(orders);
            for (let i = 0; i < keys.size(); i++) {
                const od = ctx.attachmentGetting.get(orders, keys.at(i, false));
                if (od.isNil()) continue;
                const refv = V.ValueStructure.cast(od.unwrap(false)).at('custRef', false);
                if (refv.representation() === ctx.selfKey.representation()) n += 1;
            }
            return new V.ValueInt32(n);
        }

        const d = new TransformationDirectives();
        d.addField(custDoc.representation(), 'orderCount', T.INT32, orderCount);
        const { rewriter, tgt, info } = migrateCommit(src, d);
        const result = migrateCommitDatabase.verify(src, rewriter, tgt, info.remap);
        assert.equal(result.commits, 2);                // faithful — no false VerificationError
    });

    it('single ref to a later-updated doc verifies', () => {
        // order derives customerName from the customer; the customer is RENAMED in a later commit
        // while the order is never rewritten. The order's frozen customerName is opcode-faithful.
        const { src, custDoc, orderDoc, custs, orders } = custOrderSchema();
        const ck = custs.createKey(new V.ValueUUId('11111111-1111-1111-1111-111111111111'));
        const ok = orders.createKey(new V.ValueUUId('22222222-2222-2222-2222-222222222222'));
        const odt = orders.documentType();
        const cms0 = new V.CommitMutableState(V.CommitStateBuilder.initialState(src));
        const am = cms0.attachmentMutating();
        am.set(custs, ck, new V.ValueStructure(custDoc, { name: 'Ada' }));
        am.set(orders, ok, new V.ValueStructure(odt, { custRef: ck, qty: 7 }));
        const c0 = src.commitMutations('c0', cms0);
        const cms1 = new V.CommitMutableState(V.CommitStateBuilder.state(src, c0));
        cms1.attachmentMutating().update(custs, ck, V.Path.fromField('name').const(), 'Ada2');
        src.commitMutations('rename cust', cms1);

        function deriveName(sourceStruct, fieldName, targetType, ctx) {
            const cust = ctx.attachmentGetting.get(custs, sourceStruct.at('custRef', false));
            return new V.ValueString(V.ValueStructure.cast(cust.unwrap(false)).at('name', false));
        }

        const d = new TransformationDirectives();
        d.addField(orderDoc.representation(), 'customerName', T.STRING, deriveName);
        const { rewriter, tgt, info } = migrateCommit(src, d);
        const result = migrateCommitDatabase.verify(src, rewriter, tgt, info.remap);
        assert.equal(result.commits, 2);                // faithful — no false VerificationError
    });
});
