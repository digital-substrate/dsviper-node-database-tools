// CommitDatabase migration — advanced / feature surface (silo 3). Port of the Python
// test_migrate_commit_database.py feature cases: blob copy-on-reference, commit_id remap,
// drop-record refusal, dry_run inform-step, Enable/Disable replay, progress, non-local hooks,
// drop_attachment opcode skipping, and DAG-replay failure safety.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import V from '../src/dsviper.mjs';
import { TransformationDirectives, DefinitionsRewriter, Unrepresentable } from '../src/rewrite/index.mjs';
import * as migrateCommitDatabase from '../src/migrate_commit_database.mjs';
import { VerificationError } from '../src/migrate_commit_database.mjs';

const T = V.Type;
const NS = new V.NameSpace(new V.ValueUUId('6ba7b810-9dad-11d1-80b4-00c04fd430c8'), 'Demo');

function struct(defs, name, fields) {
    const d = new V.TypeStructureDescriptor(name);
    for (const [fn, ft] of fields) d.addField(fn, ft);
    return defs.createStructure(NS, d);
}

// Materialise a state as { `${att}|${inst}`: dumps(document) } — migrating each document through
// `transformer` first when given (the RHS of the commutation law).
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

function orderDbOnDisk(p) {
    const src = V.CommitDatabase.create(p);
    const defs = new V.Definitions();
    const customer = defs.createConcept(NS, 'Customer');
    const order = struct(defs, 'Order', [['qty', T.INT32]]);
    defs.createAttachment(NS, 'Orders', customer, order);
    src.extendDefinitions(defs.const());
    return { src, order };
}


// -- Blobs carried on reference --------------------------------------------------------------

describe('CommitDatabase blobs carried', () => {
    it('a referenced blob is carried into the target', () => {
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
        const c1 = src.commitMutations('set', cms0);

        const [rewriter, targetDefs] = DefinitionsRewriter.fromDirectives(src.definitions(), renameQty(order));
        const tgt = V.CommitDatabase.createInMemory();
        tgt.extendDefinitions(targetDefs.const());
        const info = migrateCommitDatabase.migrate(src, rewriter, tgt);
        const present = new Set([...tgt.blobIds()].map((b) => b.representation()));
        assert.ok(present.has(blob.representation()));
        assert.equal(Buffer.from(tgt.blob(blob).encoded()).toString(), 'receipt bytes');
        assert.deepEqual(snapshot(src, c1, rewriter), snapshot(tgt, info.remap[c1.representation()]));
    });
});


// -- Blob copy-on-reference: exactly the referenced blobs, deduped; orphans never copied -------

describe('CommitDatabase blob copy-on-reference', () => {
    function seedTwoBlobFields() {
        const src = V.CommitDatabase.createInMemory();
        const blobA = src.createBlobFromBuffer(Buffer.from('referenced'));
        const blobB = src.createBlobFromBuffer(Buffer.from('stranded'));
        const defs = new V.Definitions();
        const c = defs.createConcept(NS, 'C');
        const doc = struct(defs, 'Doc', [['keep', T.BLOB_ID], ['drop', T.BLOB_ID]]);
        defs.createAttachment(NS, 'Docs', c, doc);
        src.extendDefinitions(defs.const());
        const a = src.definitions().attachments()[0];
        const cms = new V.CommitMutableState(V.CommitStateBuilder.initialState(src));
        cms.attachmentMutating().set(
            a, a.createKey(new V.ValueUUId('33333333-3333-3333-3333-333333333333')),
            new V.ValueStructure(doc, { keep: blobA, drop: blobB }));
        src.commitMutations('set', cms);
        return { src, doc, blobA, blobB };
    }

    it('a stranded blob is never copied', () => {
        const { src, doc, blobA, blobB } = seedTwoBlobFields();
        const d = new TransformationDirectives();
        d.dropField(doc.representation(), 'drop');                    // strands blobB
        const [rw, tdefs] = DefinitionsRewriter.fromDirectives(src.definitions(), d);
        const tgt = V.CommitDatabase.createInMemory();
        tgt.extendDefinitions(tdefs.const());
        const info = migrateCommitDatabase.migrate(src, rw, tgt);
        const present = new Set([...tgt.blobIds()].map((b) => b.representation()));
        assert.equal(info.blobs, 1);                                 // only the referenced blob copied
        assert.ok(present.has(blobA.representation()));
        assert.ok(!present.has(blobB.representation()));             // the stranded blob is never copied
        migrateCommitDatabase.verify(src, rw, tgt, info.remap);      // no orphan -> passes
    });

    it('a shared blob is copied once, deduped across commits', () => {
        const src = V.CommitDatabase.createInMemory();
        const sb = src.createBlobFromBuffer(Buffer.from('shared'));
        const defs = new V.Definitions();
        const c = defs.createConcept(NS, 'C');
        const doc = struct(defs, 'Doc', [['r', T.BLOB_ID]]);
        defs.createAttachment(NS, 'Docs', c, doc);
        src.extendDefinitions(defs.const());
        const a = src.definitions().attachments()[0];
        const cms0 = new V.CommitMutableState(V.CommitStateBuilder.initialState(src));
        cms0.attachmentMutating().set(
            a, a.createKey(new V.ValueUUId('11111111-1111-1111-1111-111111111111')),
            new V.ValueStructure(doc, { r: sb }));
        const c1 = src.commitMutations('d1', cms0);
        const cms1 = new V.CommitMutableState(V.CommitStateBuilder.state(src, c1));
        cms1.attachmentMutating().set(
            a, a.createKey(new V.ValueUUId('22222222-2222-2222-2222-222222222222')),
            new V.ValueStructure(doc, { r: sb }));                    // same blob, second commit
        src.commitMutations('d2', cms1);
        const d = new TransformationDirectives();
        d.renameField(doc.representation(), 'r', 'ref');
        const [rw, tdefs] = DefinitionsRewriter.fromDirectives(src.definitions(), d);
        const tgt = V.CommitDatabase.createInMemory();
        tgt.extendDefinitions(tdefs.const());
        const info = migrateCommitDatabase.migrate(src, rw, tgt);
        assert.equal(info.blobs, 1);                                 // copied once, deduped across commits
    });

    it('verify catches a leftover orphan blob in the target', () => {
        const { src, doc } = seedTwoBlobFields();
        const d = new TransformationDirectives();
        d.dropField(doc.representation(), 'drop');
        const [rw, tdefs] = DefinitionsRewriter.fromDirectives(src.definitions(), d);
        const tgt = V.CommitDatabase.createInMemory();
        tgt.extendDefinitions(tdefs.const());
        const info = migrateCommitDatabase.migrate(src, rw, tgt);
        tgt.createBlobFromBuffer(Buffer.from('injected orphan'));    // a blob no commit references
        assert.throws(
            () => migrateCommitDatabase.verify(src, rw, tgt, info.remap),
            (e) => e instanceof VerificationError && /orphan/.test(e.message));
    });
});


// -- drop-record refused (record-scoped loss has no opcode-level meaning) ---------------------

describe('CommitDatabase drop-record refused', () => {
    it('migration refuses a drop-record policy up front', () => {
        const src = V.CommitDatabase.createInMemory();
        const defs = new V.Definitions();
        const customer = defs.createConcept(NS, 'Customer');
        const order = struct(defs, 'Order', [['qty', new V.TypeOptional(T.INT32)]]);
        defs.createAttachment(NS, 'Orders', customer, order);
        src.extendDefinitions(defs.const());
        const att = src.definitions().attachments()[0];
        const k1 = att.createKey(new V.ValueUUId('11111111-1111-1111-1111-111111111111'));
        const ot = new V.TypeOptional(T.INT32);
        const cms0 = new V.CommitMutableState(V.CommitStateBuilder.initialState(src));
        cms0.attachmentMutating().set(att, k1, new V.ValueStructure(order, { qty: new V.ValueOptional(ot, 5) }));
        src.commitMutations('set', cms0);

        const d = new TransformationDirectives();
        d.retypeField(order.representation(), 'qty', T.INT32, 'drop-record');
        const [rewriter, targetDefs] = DefinitionsRewriter.fromDirectives(src.definitions(), d);
        const tgt = V.CommitDatabase.createInMemory();
        tgt.extendDefinitions(targetDefs.const());
        assert.throws(() => migrateCommitDatabase.migrate(src, rewriter, tgt), /drop-record/);
    });

    it('a hook dropping a value is refused clearly at runtime, rolling back', () => {
        // The runtime twin of the up-front refusal: a Class-C hook returning Unrepresentable has no
        // opcode-level meaning on a CommitDatabase (dropping one mutation corrupts the trajectory),
        // so the replay refuses the whole migration with a clear error and rolls back.
        const { src, order } = orderDb();
        const att = src.definitions().attachments()[0];
        const k1 = att.createKey(new V.ValueUUId('11111111-1111-1111-1111-111111111111'));
        const cms0 = new V.CommitMutableState(V.CommitStateBuilder.initialState(src));
        cms0.attachmentMutating().set(att, k1, new V.ValueStructure(order, { qty: 5, label: 'a' }));
        src.commitMutations('set', cms0);

        function dropHook(_sourceStruct, _fieldName, _targetType) {
            throw new Unrepresentable('this value has no faithful image');
        }

        const d = new TransformationDirectives();
        d.addField(order.representation(), 'note', T.STRING, dropHook);
        const [rewriter, targetDefs] = DefinitionsRewriter.fromDirectives(src.definitions(), d);
        const tgt = V.CommitDatabase.createInMemory();
        tgt.extendDefinitions(targetDefs.const());
        assert.throws(() => migrateCommitDatabase.migrate(src, rewriter, tgt), /no faithful target image/);
        assert.equal(tgt.commitDatabasing().inTransaction(), false);  // rolled back
        assert.equal(tgt.commitIds().length, 0);
    });
});


// -- dry_run — the inform step: preview policy bites + would-abort record-scoped losses --------

describe('CommitDatabase dryRun', () => {
    function linear(qtyType = T.INT32, first = 5, second = 7) {
        const { src, order } = orderDb(qtyType);
        const att = src.definitions().attachments()[0];
        const k1 = att.createKey(new V.ValueUUId('11111111-1111-1111-1111-111111111111'));
        const cms0 = new V.CommitMutableState(V.CommitStateBuilder.initialState(src));
        cms0.attachmentMutating().set(att, k1, new V.ValueStructure(order, { qty: first, label: 'a' }));
        const c1 = src.commitMutations('set', cms0);
        const cms1 = new V.CommitMutableState(V.CommitStateBuilder.state(src, c1));
        cms1.attachmentMutating().update(att, k1, V.Path.fromField('qty').const(), second);
        src.commitMutations('update', cms1);
        return { src, order };
    }
    function dry(src, directives) {
        const [rewriter] = DefinitionsRewriter.fromDirectives(src.definitions(), directives);
        return migrateCommitDatabase.dryRun(src, rewriter);
    }

    it('a clean migration previews no loss', () => {
        const { src, order } = linear();
        const r = dry(src, renameQty(order));
        assert.equal(r.opcodes, 2);                                  // a Set + an Update
        assert.deepEqual(r.unrepresentable, []);
        assert.equal(r.strandedBlobs, 0);
    });

    it('a value-closed policy shows in diagnostics, not as a would-abort', () => {
        const { src, order } = linear(T.INT64, 5, 2 ** 40);
        const d = new TransformationDirectives();
        d.retypeField(order.representation(), 'qty', T.INT32, 'saturate');
        const r = dry(src, d);
        assert.deepEqual(r.unrepresentable, []);                     // value-closed -> not a would-abort
        assert.equal(r.diagnostics.summary.findings, 1);            // the saturate bit is recorded
    });

    it('a drop-record policy is a would-abort site (dryRun informs, does not raise)', () => {
        const src = V.CommitDatabase.createInMemory();
        const defs = new V.Definitions();
        const customer = defs.createConcept(NS, 'Customer');
        const order = struct(defs, 'Order', [['qty', new V.TypeOptional(T.INT32)]]);
        defs.createAttachment(NS, 'Orders', customer, order);
        src.extendDefinitions(defs.const());
        const att = src.definitions().attachments()[0];
        const ot = new V.TypeOptional(T.INT32);
        const cms0 = new V.CommitMutableState(V.CommitStateBuilder.initialState(src));
        cms0.attachmentMutating().set(
            att, att.createKey(new V.ValueUUId('11111111-1111-1111-1111-111111111111')),
            new V.ValueStructure(order, { qty: new V.ValueOptional(ot, 5) }));
        src.commitMutations('set', cms0);
        const d = new TransformationDirectives();
        d.retypeField(order.representation(), 'qty', T.INT32, 'drop-record');
        const r = dry(src, d);
        assert.equal(r.unrepresentable.length, 1);
        assert.ok(r.unrepresentable[0].includes('drop-record'));
    });

    it('a hook drop is a dynamic would-abort site, found only by running', () => {
        const { src, order } = linear();
        function dropHook(_sourceStruct, _fieldName, _targetType) {
            throw new Unrepresentable('no image');
        }
        const d = new TransformationDirectives();
        d.addField(order.representation(), 'note', T.STRING, dropHook);
        const r = dry(src, d);
        assert.ok(r.unrepresentable.length > 0);
        assert.ok(r.unrepresentable[0].includes('Document_Set'));
    });

    it('a stranded blob is previewed', () => {
        const src = V.CommitDatabase.createInMemory();
        const blob = src.createBlobFromBuffer(Buffer.from('receipt'));
        const defs = new V.Definitions();
        const customer = defs.createConcept(NS, 'Customer');
        const order = struct(defs, 'Order', [['qty', T.INT32], ['receipt', T.BLOB_ID]]);
        defs.createAttachment(NS, 'Orders', customer, order);
        src.extendDefinitions(defs.const());
        const att = src.definitions().attachments()[0];
        const cms0 = new V.CommitMutableState(V.CommitStateBuilder.initialState(src));
        cms0.attachmentMutating().set(
            att, att.createKey(new V.ValueUUId('11111111-1111-1111-1111-111111111111')),
            new V.ValueStructure(order, { qty: 5, receipt: blob }));
        src.commitMutations('set', cms0);
        const d = new TransformationDirectives();
        d.dropField(order.representation(), 'receipt');
        const r = dry(src, d);
        assert.equal(r.referencedBlobs, 0);                          // nothing references it after the drop
        assert.equal(r.strandedBlobs, 1);                            // the blob would not be copied
    });
});


// -- Enable/Disable feature-flag history re-issued structurally ------------------------------

describe('CommitDatabase Enable/Disable replay', () => {
    it('a disable->enable pair replays and verifies, commuting per commit', () => {
        const { src, order } = orderDb();
        const att = src.definitions().attachments()[0];
        const k1 = att.createKey(new V.ValueUUId('11111111-1111-1111-1111-111111111111'));
        const cms0 = new V.CommitMutableState(V.CommitStateBuilder.initialState(src));
        cms0.attachmentMutating().set(att, k1, new V.ValueStructure(order, { qty: 5, label: 'a' }));
        const c0 = src.commitMutations('base', cms0);
        const cmsA = new V.CommitMutableState(V.CommitStateBuilder.state(src, c0));
        cmsA.attachmentMutating().update(att, k1, V.Path.fromField('qty').const(), 7);
        const cA = src.commitMutations('A', cmsA);
        src.disableCommit('disable A', src.lastCommitId(), cA);      // revert cA's effect
        src.enableCommit('enable A', src.lastCommitId(), cA);        // restore it

        const [rewriter, targetDefs] = DefinitionsRewriter.fromDirectives(src.definitions(), renameQty(order));
        const tgt = V.CommitDatabase.createInMemory();
        tgt.extendDefinitions(targetDefs.const());
        const info = migrateCommitDatabase.migrate(src, rewriter, tgt);
        for (const c of [c0, cA])
            assert.deepEqual(snapshot(src, c, rewriter), snapshot(tgt, info.remap[c.representation()]));
        assert.equal(tgt.commitIds().length, 4);                     // base, A, disable, enable
        const result = migrateCommitDatabase.verify(src, rewriter, tgt, info.remap);
        assert.equal(result.commits, 4);
    });
});


// -- Progress: a byte bar (per streamed chunk) and a commit counter --------------------------

describe('CommitDatabase progress', () => {
    it('reports a monotonic byte bar and a commit counter', () => {
        const src = V.CommitDatabase.createInMemory();
        const big = src.createBlobFromBuffer(Buffer.alloc(150 * 1024 * 1024, 0x78));   // 150 MB -> 3 chunks of 64 MB
        const defs = new V.Definitions();
        const customer = defs.createConcept(NS, 'Customer');
        const order = struct(defs, 'Order', [['qty', T.INT32], ['receipt', T.BLOB_ID]]);
        defs.createAttachment(NS, 'Orders', customer, order);
        src.extendDefinitions(defs.const());
        const att = src.definitions().attachments()[0];
        const k1 = att.createKey(new V.ValueUUId('11111111-1111-1111-1111-111111111111'));
        const cms0 = new V.CommitMutableState(V.CommitStateBuilder.initialState(src));
        cms0.attachmentMutating().set(att, k1, new V.ValueStructure(order, { qty: 5, receipt: big }));
        const c1 = src.commitMutations('set', cms0);
        const cms1 = new V.CommitMutableState(V.CommitStateBuilder.state(src, c1));
        cms1.attachmentMutating().update(att, k1, V.Path.fromField('qty').const(), 7);
        src.commitMutations('update', cms1);

        const [rewriter, targetDefs] = DefinitionsRewriter.fromDirectives(src.definitions(), renameQty(order));
        const tgt = V.CommitDatabase.createInMemory();
        tgt.extendDefinitions(targetDefs.const());
        const events = [];
        migrateCommitDatabase.migrate(src, rewriter, tgt, (p) => events.push(p));

        const last = events[events.length - 1];
        assert.equal(last.commitCount, 2);
        assert.equal(last.commits, 2);                               // counter reached the total
        assert.equal(last.blobs, 1);
        assert.equal(last.bytesCopied, last.bytesTotal);            // byte bar reached the total
        // the bar advanced per 64 MB chunk through the single 150 MB blob (not one jump)
        const climbs = [...new Set(events.map((e) => e.bytesCopied).filter((n) => n))].sort((a, b) => a - b);
        assert.ok(climbs.length > 1);
        assert.deepEqual([...climbs].sort((a, b) => a - b), climbs);  // monotonic
    });
});


// -- Non-local Class-C derive hook under DAG replay ------------------------------------------

describe('CommitDatabase non-local hook in replay', () => {
    it('derives a field across commits (deref through the source view) and verifies', () => {
        const src = V.CommitDatabase.createInMemory();
        const defs = new V.Definitions();
        const customer = defs.createConcept(NS, 'Customer');
        const custDoc = struct(defs, 'CustomerDoc', [['name', T.STRING]]);
        const custsAtt = defs.createAttachment(NS, 'Customers', customer, custDoc);
        const order = defs.createConcept(NS, 'Order');
        const orderDoc = struct(defs, 'OrderDoc', [['custRef', custsAtt.typeKey()], ['qty', T.INT32]]);
        const ordersAtt = defs.createAttachment(NS, 'Orders', order, orderDoc);
        src.extendDefinitions(defs.const());

        const ck = custsAtt.createKey(new V.ValueUUId('11111111-1111-1111-1111-111111111111'));
        const ok = ordersAtt.createKey(new V.ValueUUId('22222222-2222-2222-2222-222222222222'));
        const cms0 = new V.CommitMutableState(V.CommitStateBuilder.initialState(src));
        cms0.attachmentMutating().set(custsAtt, ck, new V.ValueStructure(custDoc, { name: 'Ada' }));
        const c0 = src.commitMutations('add customer', cms0);        // parent commit
        const cms1 = new V.CommitMutableState(V.CommitStateBuilder.state(src, c0));
        cms1.attachmentMutating().set(ordersAtt, ok, new V.ValueStructure(orderDoc, { custRef: ck, qty: 7 }));
        const c1 = src.commitMutations('add order', cms1);

        function deriveName(sourceStruct, _fieldName, _targetType, ctx) {
            const key = sourceStruct.at('custRef', false);
            const cust = ctx.attachmentGetting.get(custsAtt, key);
            return new V.ValueString(V.ValueStructure.cast(cust.unwrap(false)).at('name', false));
        }

        const d = new TransformationDirectives();
        d.addField(orderDoc.representation(), 'customerName', T.STRING, deriveName);

        const [rewriter, targetDefs] = DefinitionsRewriter.fromDirectives(src.definitions(), d);
        const tgt = V.CommitDatabase.createInMemory();
        tgt.extendDefinitions(targetDefs.const());
        const info = migrateCommitDatabase.migrate(src, rewriter, tgt);

        // the head order carries the dereferenced name
        const head = info.remap[c1.representation()];
        const ag = V.CommitStateBuilder.state(tgt, head).attachmentGetting();
        const tgtOrders = tgt.definitions().attachments().find((a) => a.representation().endsWith('Orders'));
        const tkeys = ag.keys(tgtOrders);
        const doc = V.ValueStructure.cast(ag.get(tgtOrders, tkeys.at(0, false)).unwrap(false));
        assert.equal(doc.at('customerName', true), 'Ada');

        // the whole-DAG commutation law holds with the hook (verify wires the view)
        const summary = migrateCommitDatabase.verify(src, rewriter, tgt, info.remap);
        assert.equal(summary.commits, 2);
    });
});


// -- drop_attachment: static, uniform whole-partition drop; opcodes skipped ------------------

describe('CommitDatabase drop_attachment', () => {
    function twoAttachments() {
        const src = V.CommitDatabase.createInMemory();
        const defs = new V.Definitions();
        const cust = defs.createConcept(NS, 'Customer');
        const order = struct(defs, 'Order', [['qty', T.INT32]]);
        defs.createAttachment(NS, 'Orders', cust, order);
        const note = struct(defs, 'Note', [['text', T.STRING], ['tags', new V.TypeXArray(T.STRING)]]);
        defs.createAttachment(NS, 'Notes', cust, note);
        src.extendDefinitions(defs.const());
        const [oatt, natt] = src.definitions().attachments();
        const ok = oatt.createKey(new V.ValueUUId('11111111-1111-1111-1111-111111111111'));
        const nk = natt.createKey(new V.ValueUUId('22222222-2222-2222-2222-222222222222'));
        const cms0 = new V.CommitMutableState(V.CommitStateBuilder.initialState(src));
        const am0 = cms0.attachmentMutating();
        am0.set(oatt, ok, new V.ValueStructure(order, { qty: 5 }));
        am0.set(natt, nk, new V.ValueStructure(note, { text: 'hi' }));
        const c0 = src.commitMutations('c0', cms0);
        const cms1 = new V.CommitMutableState(V.CommitStateBuilder.state(src, c0));
        const am1 = cms1.attachmentMutating();
        am1.update(oatt, ok, V.Path.fromField('qty').const(), 7);
        am1.insertInXarray(natt, nk, V.Path.fromField('tags').const(), V.ValueXArray.END,
            new V.ValueUUId('aaaaaaaa-0000-0000-0000-000000000001'), new V.ValueString('x'));  // a PAIR to skip
        src.commitMutations('c1', cms1);
        return { src, order };
    }

    it('is refused without acknowledgement', () => {
        const { src } = twoAttachments();
        const d = new TransformationDirectives();
        d.dropAttachment('Notes');                                   // no acceptAttachmentDrops()
        const [rewriter, targetDefs] = DefinitionsRewriter.fromDirectives(src.definitions(), d);
        const tgt = V.CommitDatabase.createInMemory();
        tgt.extendDefinitions(targetDefs.const());
        assert.throws(
            () => migrateCommitDatabase.migrate(src, rewriter, tgt),
            (e) => /unacknowledged/.test(e.message.toLowerCase()));
    });

    it('an acknowledged drop skips the partition and verifies', () => {
        const { src } = twoAttachments();
        const d = new TransformationDirectives();
        d.dropAttachment('Notes');
        d.acceptAttachmentDrops();
        const [rewriter, targetDefs] = DefinitionsRewriter.fromDirectives(src.definitions(), d);
        const tgt = V.CommitDatabase.createInMemory();
        tgt.extendDefinitions(targetDefs.const());
        const info = migrateCommitDatabase.migrate(src, rewriter, tgt);
        assert.equal(info.commits, 2);
        const tatts = tgt.definitions().attachments().map((a) => a.representation());
        assert.ok(tatts.some((r) => r.endsWith('Orders')));
        assert.ok(!tatts.some((r) => r.endsWith('Notes')));          // partition gone
        // Orders survives with its update; the Notes opcodes (incl. the xarray insert pair) skipped
        const head = V.CommitStateBuilder.state(tgt, tgt.lastCommitId());
        const toa = head.definitions().attachments().find((a) => a.representation().endsWith('Orders'));
        const k = head.attachmentGetting().keys(toa).at(0, false);
        const doc = V.ValueStructure.cast(head.attachmentGetting().get(toa, k).unwrap(false));
        assert.equal(doc.at('qty', true), 7);
        // verify aligns the opcode streams (dropped-attachment opcodes filtered on both sides)
        const result = migrateCommitDatabase.verify(src, rewriter, tgt, info.remap);
        assert.equal(result.commits, 2);
    });
});


// -- Failure safety: a DAG replay is all-or-nothing ------------------------------------------

describe('CommitDatabase replay failure safety', () => {
    function boomDirectives(_sourceDefs) {
        const calls = { n: 0 };
        function boom(_sourceStruct, _fieldName, _targetType, _ctx) {
            calls.n += 1;
            if (calls.n === 2) throw new Error('boom mid-replay');
            return new V.ValueInt32(calls.n);
        }
        const d = new TransformationDirectives();
        d.addField('Demo::Order', 'tag', T.INT32, boom);
        return d;
    }

    function seed(src, order) {
        const att = src.definitions().attachments()[0];
        const uuids = ['11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222'];
        uuids.forEach((u, i) => {
            const base = i === 0
                ? V.CommitStateBuilder.initialState(src)
                : V.CommitStateBuilder.state(src, src.lastCommitId());
            const cms = new V.CommitMutableState(base);
            cms.attachmentMutating().set(att, att.createKey(new V.ValueUUId(u)), new V.ValueStructure(order, { qty: i }));
            src.commitMutations(`c${i}`, cms);
        });
    }

    it('migrate rolls back on a mid-replay failure', () => {
        const { src, order } = orderDb();
        seed(src, order);
        const [rw, tdefs] = DefinitionsRewriter.fromDirectives(src.definitions(), boomDirectives(src.definitions()));
        const tgt = V.CommitDatabase.createInMemory();
        tgt.extendDefinitions(tdefs.const());
        assert.throws(() => migrateCommitDatabase.migrate(src, rw, tgt), /boom mid-replay/);
        // the exclusive transaction was aborted, not left dangling — the target is usable again
        assert.equal(tgt.commitDatabasing().inTransaction(), false);
        assert.equal(tgt.commitIds().length, 0);                     // no half-issued commits survive
    });

    it('run discards the partial target file on failure', () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cdbfail-'));
        const sp = path.join(tmp, 'src.cdb');
        const tp = path.join(tmp, 'tgt.cdb');
        try {
            const { src, order } = orderDbOnDisk(sp);
            seed(src, order);
            src.close();
            assert.throws(() => migrateCommitDatabase.run(sp, boomDirectives, tp), /boom mid-replay/);
            assert.equal(fs.existsSync(tp), false);                  // partial target discarded
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });
});
