// Database migration loop — the richer feature cases: Class-B drop-record (scope +
// acknowledgement), dryRun preview, non-local / aggregate Class-C hooks, drop_attachment,
// on-disk run + self-verify, progress reporting, the source snapshot, and failure safety.
// 1:1 port of the Python migration-loop feature tests. Basic mechanical cases live in
// migrate_database.test.mjs.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import V from '../src/dsviper.mjs';
import { TransformationDirectives, DefinitionsRewriter } from '../src/rewrite/index.mjs';
import * as migrateDatabase from '../src/migrate_database.mjs';

const T = V.Type;
const NS = new V.NameSpace(new V.ValueUUId('6ba7b810-9dad-11d1-80b4-00c04fd430c8'), 'Demo');

function struct(defs, name, fields) {
    const d = new V.TypeStructureDescriptor(name);
    for (const [fn, ft] of fields) d.addField(fn, ft);
    return defs.createStructure(NS, d);
}

// migrate a source Database under `directives`, returning { tgtDb, transformer, info }.
function migrate(srcDb, directives) {
    const [transformer, targetDefs] = DefinitionsRewriter.fromDirectives(srcDb.definitions(), directives);
    const tgtDb = V.Database.createInMemory();
    tgtDb.extendDefinitions(targetDefs.const());
    const info = migrateDatabase.migrate(srcDb, transformer, tgtDb);
    return { tgtDb, transformer, info };
}


describe('migrateDatabase — drop-record skips a document', () => {
    it('a nil optional retyped drop-record elides its enclosing document', () => {
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
            new V.ValueStructure(docT, { x: new V.ValueOptional(ot) }));       // nil -> dropped
        src.commit();

        const d = new TransformationDirectives();
        d.retypeField(docT.representation(), 'x', T.INT32, 'drop-record');
        d.acceptDocumentDrops();                                               // explicit sign-off
        const { tgtDb, info } = migrate(src, d);

        assert.equal(info.documents, 1);
        assert.equal(info.dropped, 1);
        const tatt = tgtDb.definitions().attachments()[0];
        assert.equal(tgtDb.keys(tatt).size(), 1);
    });
});


describe('migrateDatabase — on-disk run, self-verified', () => {
    it('a real file migration copies only the referenced blob and self-verifies', () => {
        const dir = mkdtempSync(join(tmpdir(), 'dbmig-'));
        const srcPath = join(dir, 'src.db');
        const tgtPath = join(dir, 'tgt.db');
        try {
            const src = V.Database.create(srcPath);
            const defs = new V.Definitions();
            const item = defs.createConcept(NS, 'Item');
            const docT = struct(defs, 'Doc', [['name', T.STRING], ['thumb', T.BLOB_ID], ['old', T.BLOB_ID]]);
            defs.createAttachment(NS, 'Items', item, docT);
            src.extendDefinitions(defs.const());
            const layout = new V.BlobLayout('uchar', 1);
            src.beginTransaction();
            const kept = src.createBlob(layout, new V.ValueBlob(Buffer.from([7, 7, 7, 7])));
            const orphan = src.createBlob(layout, new V.ValueBlob(Buffer.from(Array.from({ length: 20 }, (_, j) => j))));
            const att = src.definitions().attachments()[0];
            const key = att.createKey(new V.ValueUUId('22222222-2222-2222-2222-222222222222'));
            src.set(att, key, new V.ValueStructure(docT, { name: 'hi', thumb: kept, old: orphan }));
            src.commit();
            src.close();

            const build = (d0) => {
                const st = d0.structures()[0].representation();
                const d = new TransformationDirectives();
                d.renameField(st, 'name', 'title');
                d.dropField(st, 'old');
                return d;
            };

            const info = migrateDatabase.run(srcPath, build, tgtPath, { verify: true });
            assert.equal(info.documents, 1);
            assert.equal(info.blobs, 1);                                       // only the referenced blob copied
            assert.deepEqual(info.verification, { checked: 1, dropped: 0, referencedBlobs: 1 });

            const tgt = V.Database.open(tgtPath, true);
            const tatt = tgt.definitions().attachments()[0];
            const doc = V.ValueStructure.cast(tgt.get(tatt, tgt.keys(tatt).at(0, false)).unwrap(false));
            assert.equal(doc.at('title'), 'hi');
            assert.deepEqual([...Buffer.from(tgt.blob(doc.at('thumb', false)).encoded())], [7, 7, 7, 7]);
            assert.equal([...tgt.blobIds()].length, 1);
            tgt.close();
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});


describe('migrateDatabase — drop-record position (record scope)', () => {
    function makeEnum(defs) {
        const ed = new V.TypeEnumerationDescriptor('Mode');
        ed.addCase('Old'); ed.addCase('New');
        return defs.createEnumeration(NS, ed);
    }

    it('refuses a removed-case drop-record when the enum sits inside a vector', () => {
        const src = V.Database.createInMemory();
        const defs = new V.Definitions();
        const c = defs.createConcept(NS, 'C');
        const e = makeEnum(defs);
        const docT = struct(defs, 'Doc', [['modes', new V.TypeVector(e)]]);     // enum under a container
        defs.createAttachment(NS, 'Docs', c, docT);
        src.extendDefinitions(defs.const());

        const d = new TransformationDirectives();
        d.removeCase(e.representation(), 'Old', 'drop-record');
        const [rewriter] = DefinitionsRewriter.fromDirectives(src.definitions(), d);
        assert.throws(() => migrateDatabase.migrate(src, rewriter, V.Database.createInMemory()),
            (err) => /drop-record/.test(err.message) && /ambiguous/.test(err.message));
    });

    it('refuses a retype drop-record when the struct is nested in a map (dryRun enforces scope too)', () => {
        const src = V.Database.createInMemory();
        const defs = new V.Definitions();
        const c = defs.createConcept(NS, 'C');
        const inner = struct(defs, 'Inner', [['x', new V.TypeOptional(T.INT32)]]);
        const docT = struct(defs, 'Doc', [['m', new V.TypeMap(T.STRING, inner)]]);   // struct under a container
        defs.createAttachment(NS, 'Docs', c, docT);
        src.extendDefinitions(defs.const());

        const d = new TransformationDirectives();
        d.retypeField(inner.representation(), 'x', T.INT32, 'drop-record');
        const [rewriter] = DefinitionsRewriter.fromDirectives(src.definitions(), d);
        assert.throws(() => migrateDatabase.dryRun(src, rewriter), /Inner\.x/);
    });

    it('admits drop-record through a nested struct at multiplicity one', () => {
        const src = V.Database.createInMemory();
        const defs = new V.Definitions();
        const c = defs.createConcept(NS, 'C');
        const inner = struct(defs, 'Inner', [['x', new V.TypeOptional(T.INT32)]]);
        const docT = struct(defs, 'Doc', [['inner', inner]]);                   // nested struct, not a container
        defs.createAttachment(NS, 'Docs', c, docT);
        src.extendDefinitions(defs.const());
        const att = src.definitions().attachments()[0];
        const ot = new V.TypeOptional(T.INT32);
        src.beginTransaction();
        src.set(att, att.createKey(new V.ValueUUId('11111111-1111-1111-1111-111111111111')),
            new V.ValueStructure(docT, { inner: new V.ValueStructure(inner, { x: new V.ValueOptional(ot, 9) }) }));
        src.set(att, att.createKey(new V.ValueUUId('22222222-2222-2222-2222-222222222222')),
            new V.ValueStructure(docT, { inner: new V.ValueStructure(inner, { x: new V.ValueOptional(ot) }) }));
        src.commit();

        const d = new TransformationDirectives();
        d.retypeField(inner.representation(), 'x', T.INT32, 'drop-record');
        const [rewriter] = DefinitionsRewriter.fromDirectives(src.definitions(), d);
        const info = migrateDatabase.dryRun(src, rewriter);                     // NOT refused
        assert.equal(info.documents, 1);
        assert.equal(info.dropped, 1);                                          // the nil-inner doc drops
    });
});


describe('migrateDatabase — document-drop acknowledgement', () => {
    function srcWithDroppableDoc() {
        const src = V.Database.createInMemory();
        const defs = new V.Definitions();
        const concept = defs.createConcept(NS, 'R');
        const docT = struct(defs, 'Rec', [['x', new V.TypeOptional(T.INT32)]]);   // direct field: coherent
        defs.createAttachment(NS, 'Recs', concept, docT);
        src.extendDefinitions(defs.const());
        const att = src.definitions().attachments()[0];
        const ot = new V.TypeOptional(T.INT32);
        src.beginTransaction();
        src.set(att, att.createKey(new V.ValueUUId('44444444-4444-4444-4444-444444444444')),
            new V.ValueStructure(docT, { x: new V.ValueOptional(ot, 9) }));
        src.set(att, att.createKey(new V.ValueUUId('55555555-5555-5555-5555-555555555555')),
            new V.ValueStructure(docT, { x: new V.ValueOptional(ot) }));           // nil -> would drop
        src.commit();
        return { src, docT };
    }

    it('migrate refuses an unacknowledged drop-record', () => {
        const { src, docT } = srcWithDroppableDoc();
        const d = new TransformationDirectives();
        d.retypeField(docT.representation(), 'x', T.INT32, 'drop-record');       // NO sign-off
        const [rewriter] = DefinitionsRewriter.fromDirectives(src.definitions(), d);
        assert.throws(() => migrateDatabase.migrate(src, rewriter, V.Database.createInMemory()),
            (err) => /unacknowledged/.test(err.message) && /acceptDocumentDrops/.test(err.message));
    });

    it('dryRun does not require the acknowledgement', () => {
        const { src, docT } = srcWithDroppableDoc();
        const d = new TransformationDirectives();
        d.retypeField(docT.representation(), 'x', T.INT32, 'drop-record');       // NO sign-off
        const [rewriter] = DefinitionsRewriter.fromDirectives(src.definitions(), d);
        const info = migrateDatabase.dryRun(src, rewriter);                      // not refused
        assert.equal(info.dropped, 1);
    });

    it('migrate proceeds once acknowledged', () => {
        const { src, docT } = srcWithDroppableDoc();
        const d = new TransformationDirectives();
        d.retypeField(docT.representation(), 'x', T.INT32, 'drop-record');
        d.acceptDocumentDrops();                                                // the explicit act
        const [rewriter, targetDefs] = DefinitionsRewriter.fromDirectives(src.definitions(), d);
        const tgt = V.Database.createInMemory();
        tgt.extendDefinitions(targetDefs.const());
        const info = migrateDatabase.migrate(src, rewriter, tgt);
        assert.equal(info.documents, 1);
        assert.equal(info.dropped, 1);
    });
});


describe('migrateDatabase — dryRun preview', () => {
    it('previews documents and orphans without writing', () => {
        const src = V.Database.createInMemory();
        const defs = new V.Definitions();
        const item = defs.createConcept(NS, 'Item');
        const docT = struct(defs, 'Doc', [['name', T.STRING], ['thumb', T.BLOB_ID], ['old', T.BLOB_ID]]);
        defs.createAttachment(NS, 'Items', item, docT);
        src.extendDefinitions(defs.const());
        const layout = new V.BlobLayout('uchar', 1);
        src.beginTransaction();
        const kept = src.createBlob(layout, new V.ValueBlob(Buffer.from([1, 2, 3])));
        const orphan = src.createBlob(layout, new V.ValueBlob(Buffer.from([9, 9])));
        const att = src.definitions().attachments()[0];
        const key = att.createKey(new V.ValueUUId('22222222-2222-2222-2222-222222222222'));
        src.set(att, key, new V.ValueStructure(docT, { name: 'x', thumb: kept, old: orphan }));
        src.commit();

        const d = new TransformationDirectives();
        d.renameField(docT.representation(), 'name', 'title');
        d.dropField(docT.representation(), 'old');                              // orphans the 2nd blob
        const [rewriter] = DefinitionsRewriter.fromDirectives(src.definitions(), d);

        const info = migrateDatabase.dryRun(src, rewriter);
        assert.deepEqual(
            { documents: info.documents, dropped: info.dropped, referencedBlobs: info.referencedBlobs, orphans: info.orphans },
            { documents: 1, dropped: 0, referencedBlobs: 1, orphans: 1 });
        assert.deepEqual(info.diagnostics.sites, []);                           // no Class-B policy fired
        assert.equal([...src.blobIds()].length, 2);                            // nothing written: both blobs remain
    });

    it('previews dropped records', () => {
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
            new V.ValueStructure(docT, { x: new V.ValueOptional(ot) }));           // nil -> would drop
        src.commit();

        const d = new TransformationDirectives();
        d.retypeField(docT.representation(), 'x', T.INT32, 'drop-record');
        const [rewriter] = DefinitionsRewriter.fromDirectives(src.definitions(), d);

        const info = migrateDatabase.dryRun(src, rewriter);
        assert.equal(info.documents, 1);
        assert.equal(info.dropped, 1);
    });
});


describe('migrateDatabase — non-local Class-C hook (single reference)', () => {
    function schema(defs) {
        const customer = defs.createConcept(NS, 'Customer');
        const custDoc = struct(defs, 'CustomerDoc', [['name', T.STRING]]);
        const custsAtt = defs.createAttachment(NS, 'Customers', customer, custDoc);
        const order = defs.createConcept(NS, 'Order');
        const orderDoc = struct(defs, 'OrderDoc', [['custRef', custsAtt.typeKey()], ['qty', T.INT32]]);
        const ordersAtt = defs.createAttachment(NS, 'Orders', order, orderDoc);
        return { custDoc, custsAtt, orderDoc, ordersAtt };
    }

    function directives(orderDoc, custsAtt) {
        const deriveName = (sourceStruct, fieldName, targetType, ctx) => {
            const key = sourceStruct.at('custRef', false);
            const cust = ctx.attachmentGetting.get(custsAtt, key);              // ValueOptional
            const name = V.ValueStructure.cast(cust.unwrap(false)).at('name');
            return new V.ValueString(name);
        };
        const d = new TransformationDirectives();
        d.addField(orderDoc.representation(), 'customerName', T.STRING, deriveName);
        return d;
    }

    it('a derive hook dereferences a key via the source view', () => {
        const src = V.Database.createInMemory();
        const defs = new V.Definitions();
        const { custDoc, custsAtt, orderDoc, ordersAtt } = schema(defs);
        src.extendDefinitions(defs.const());

        const ck = custsAtt.createKey(new V.ValueUUId('11111111-1111-1111-1111-111111111111'));
        const ok = ordersAtt.createKey(new V.ValueUUId('22222222-2222-2222-2222-222222222222'));
        src.beginTransaction();
        src.set(custsAtt, ck, new V.ValueStructure(custDoc, { name: 'Ada' }));
        src.set(ordersAtt, ok, new V.ValueStructure(orderDoc, { custRef: ck, qty: 7 }));
        src.commit();

        const { tgtDb, info } = migrate(src, directives(orderDoc, custsAtt));
        assert.equal(info.documents, 2);

        const tgtOrders = tgtDb.definitions().attachments().find((a) => a.representation().endsWith('Orders'));
        const doc = V.ValueStructure.cast(
            tgtDb.get(tgtOrders, tgtDb.keys(tgtOrders).at(0, false)).unwrap(false));
        assert.equal(doc.at('customerName'), 'Ada');
        assert.equal(doc.at('qty'), 7);
    });

    it('a non-local hook with no source view wired fails closed clearly', () => {
        const defs = new V.Definitions();
        const { orderDoc, custsAtt } = schema(defs);
        const [rewriter] = DefinitionsRewriter.fromDirectives(defs, directives(orderDoc, custsAtt));
        const ck = custsAtt.createKey(new V.ValueUUId('11111111-1111-1111-1111-111111111111'));
        const srcOrder = new V.ValueStructure(orderDoc, { custRef: ck, qty: 7 });
        assert.throws(() => rewriter.value(srcOrder), /no source view/);
    });

    it('ctx reports the view and supports a re-entrant rewrite', () => {
        const seen = {};
        const src = V.Database.createInMemory();
        const defs = new V.Definitions();
        const { custDoc, custsAtt, orderDoc, ordersAtt } = schema(defs);
        src.extendDefinitions(defs.const());
        const ck = custsAtt.createKey(new V.ValueUUId('11111111-1111-1111-1111-111111111111'));
        const ok = ordersAtt.createKey(new V.ValueUUId('22222222-2222-2222-2222-222222222222'));
        src.beginTransaction();
        src.set(custsAtt, ck, new V.ValueStructure(custDoc, { name: 'Ada' }));
        src.set(ordersAtt, ok, new V.ValueStructure(orderDoc, { custRef: ck, qty: 7 }));
        src.commit();

        const deriveName = (sourceStruct, fieldName, targetType, ctx) => {
            seen.view = ctx.hasSourceView;
            const key = sourceStruct.at('custRef', false);
            const cust = ctx.attachmentGetting.get(custsAtt, key);
            const name = V.ValueStructure.cast(cust.unwrap(false)).at('name');
            // re-enter the engine on the leaf; followRefs=false blanks the view inside
            return ctx.rewrite(new V.ValueString(name), T.STRING, { followRefs: false });
        };

        const d = new TransformationDirectives();
        d.addField(orderDoc.representation(), 'customerName', T.STRING, deriveName);
        const [rewriter, tgtDefs] = DefinitionsRewriter.fromDirectives(src.definitions(), d);
        const tgtDb = V.Database.createInMemory();
        tgtDb.extendDefinitions(tgtDefs.const());
        migrateDatabase.migrate(src, rewriter, tgtDb);

        assert.equal(seen.view, true);
        const tgtOrders = tgtDb.definitions().attachments().find((a) => a.representation().endsWith('Orders'));
        const doc = V.ValueStructure.cast(
            tgtDb.get(tgtOrders, tgtDb.keys(tgtOrders).at(0, false)).unwrap(false));
        assert.equal(doc.at('customerName'), 'Ada');
    });
});


describe('migrateDatabase — aggregate Class-C hook (incoming reference fold)', () => {
    function schema(defs) {
        const customer = defs.createConcept(NS, 'Customer');
        const custDoc = struct(defs, 'CustomerDoc', [['name', T.STRING]]);
        const custsAtt = defs.createAttachment(NS, 'Customers', customer, custDoc);
        const order = defs.createConcept(NS, 'Order');
        const orderDoc = struct(defs, 'OrderDoc', [['custRef', custsAtt.typeKey()], ['amount', T.INT32]]);
        const ordersAtt = defs.createAttachment(NS, 'Orders', order, orderDoc);
        return { custDoc, custsAtt, orderDoc, ordersAtt };
    }

    it('folds an incoming reference over the source, scanning once', () => {
        const src = V.Database.createInMemory();
        const defs = new V.Definitions();
        const { custDoc, custsAtt, orderDoc, ordersAtt } = schema(defs);
        src.extendDefinitions(defs.const());

        const ada = custsAtt.createKey(new V.ValueUUId('11111111-1111-1111-1111-111111111111'));
        const bob = custsAtt.createKey(new V.ValueUUId('22222222-2222-2222-2222-222222222222'));
        src.beginTransaction();
        src.set(custsAtt, ada, new V.ValueStructure(custDoc, { name: 'Ada' }));
        src.set(custsAtt, bob, new V.ValueStructure(custDoc, { name: 'Bob' }));
        const rows = [[ada, 10], [ada, 20], [ada, 30], [bob, 99]];
        rows.forEach(([who, amt], i) => {
            const k = ordersAtt.createKey(new V.ValueUUId(`aaaa0000-0000-0000-0000-00000000000${i}`));
            src.set(ordersAtt, k, new V.ValueStructure(orderDoc, { custRef: who, amount: amt }));
        });
        src.commit();

        const index = {};
        const scans = [];
        const totalSpent = (sourceStruct, fieldName, targetType, ctx) => {
            if (Object.keys(index).length === 0) {
                const ag = ctx.attachmentGetting;
                const ks = ag.keys(ordersAtt);
                for (let i = 0; i < ks.size(); i++) {
                    const o = V.ValueStructure.cast(ag.get(ordersAtt, ks.at(i, false)).unwrap(false));
                    const ref = String(V.Value.dumps(o.at('custRef', false)));
                    index[ref] = (index[ref] || 0) + V.Value.dumps(o.at('amount', false));
                }
                scans.push(1);
            }
            return new V.ValueInt32(index[String(V.Value.dumps(ctx.selfKey))] || 0);
        };

        const d = new TransformationDirectives();
        d.addField(custDoc.representation(), 'totalSpent', T.INT32, totalSpent);
        const { tgtDb } = migrate(src, d);

        assert.equal(scans.length, 1);                                         // scanned once, memoised
        const tgtCusts = tgtDb.definitions().attachments().find((a) => a.representation().endsWith('Customers'));
        const totals = {};
        const keys = tgtDb.keys(tgtCusts);
        for (let i = 0; i < keys.size(); i++) {
            const doc = V.ValueStructure.cast(tgtDb.get(tgtCusts, keys.at(i, false)).unwrap(false));
            totals[V.Value.dumps(doc.at('name', false))] = V.Value.dumps(doc.at('totalSpent', false));
        }
        assert.deepEqual(totals, { Ada: 60, Bob: 99 });
    });

    it('a hook that reads self_key outside the store loop fails closed', () => {
        const defs = new V.Definitions();
        const { custDoc } = schema(defs);

        const needsSelf = (sourceStruct, fieldName, targetType, ctx) => {
            assert.equal(ctx.hasSelfKey, false);
            return new V.ValueInt32(ctx.selfKey);                              // throws: no self key
        };

        const d = new TransformationDirectives();
        d.addField(custDoc.representation(), 'totalSpent', T.INT32, needsSelf);
        const [rewriter] = DefinitionsRewriter.fromDirectives(defs, d);
        assert.throws(() => rewriter.value(new V.ValueStructure(custDoc, { name: 'Ada' })), /no self key/);
    });
});


describe('migrateDatabase — dropAttachment', () => {
    function seed() {
        const src = V.Database.createInMemory();
        const defs = new V.Definitions();
        const cust = defs.createConcept(NS, 'Customer');
        const keep = struct(defs, 'Order', [['qty', T.INT32]]);
        const legacy = struct(defs, 'Audit', [['note', T.STRING]]);
        defs.createAttachment(NS, 'Orders', cust, keep);
        defs.createAttachment(NS, 'Audits', cust, legacy);
        src.extendDefinitions(defs.const());
        const atts = {};
        for (const a of src.definitions().attachments()) atts[a.identifier().split('.').pop()] = a;
        src.beginTransaction();
        src.set(atts.Orders, atts.Orders.createKey(new V.ValueUUId('11111111-1111-1111-1111-111111111111')),
            new V.ValueStructure(keep, { qty: 5 }));
        src.set(atts.Audits, atts.Audits.createKey(new V.ValueUUId('22222222-2222-2222-2222-222222222222')),
            new V.ValueStructure(legacy, { note: 'x' }));
        src.commit();
        return { src, keep };
    }

    it('is refused without acknowledgement', () => {
        const { src } = seed();
        const d = new TransformationDirectives();
        d.dropAttachment('Audits');
        const [rewriter, targetDefs] = DefinitionsRewriter.fromDirectives(src.definitions(), d);
        const tgt = V.Database.createInMemory();
        tgt.extendDefinitions(targetDefs.const());
        assert.throws(() => migrateDatabase.migrate(src, rewriter, tgt), /unacknowledged/);
    });

    it('acknowledged, drops the attachment and its documents', () => {
        const { src } = seed();
        const d = new TransformationDirectives();
        d.dropAttachment('Audits');
        d.acceptAttachmentDrops();
        const [rewriter, targetDefs] = DefinitionsRewriter.fromDirectives(src.definitions(), d);
        const tgt = V.Database.createInMemory();
        tgt.extendDefinitions(targetDefs.const());
        const info = migrateDatabase.migrate(src, rewriter, tgt);

        const locals = new Set(tgt.definitions().attachments().map((a) => a.identifier().split('.').pop()));
        assert.deepEqual(locals, new Set(['Orders']));                         // Audits gone, Orders kept
        assert.equal(info.documents, 1);                                       // only the surviving Order copied
    });

    it('dryRun informs without the acknowledgement', () => {
        const { src } = seed();
        const d = new TransformationDirectives();
        d.dropAttachment('Audits');                                            // no accept
        const [rewriter] = DefinitionsRewriter.fromDirectives(src.definitions(), d);
        const info = migrateDatabase.dryRun(src, rewriter);                    // must NOT require the sign-off
        assert.equal(info.documents, 1);                                       // the Audit doc is not carried
    });
});


describe('migrateDatabase — progress reporting', () => {
    it('onProgress reports bytes, documents, and position', () => {
        const src = V.Database.createInMemory();
        const defs = new V.Definitions();
        const item = defs.createConcept(NS, 'Item');
        const docT = struct(defs, 'Doc', [['name', T.STRING], ['thumb', T.BLOB_ID]]);
        defs.createAttachment(NS, 'Items', item, docT);
        src.extendDefinitions(defs.const());
        const att = src.definitions().attachments()[0];
        src.beginTransaction();
        let total = 0;
        ['11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222'].forEach((u, i) => {
            const payload = Buffer.from(Array.from({ length: (i + 1) * 40 }, (_, j) => j));
            total += payload.length;
            const b = src.createBlob(new V.BlobLayout('uchar', 1), new V.ValueBlob(payload));
            src.set(att, att.createKey(new V.ValueUUId(u)), new V.ValueStructure(docT, { name: 'x', thumb: b }));
        });
        src.commit();

        const events = [];
        const d = new TransformationDirectives();
        d.renameField(docT.representation(), 'name', 'title');
        const [rewriter, tdefs] = DefinitionsRewriter.fromDirectives(src.definitions(), d);
        const tgt = V.Database.createInMemory();
        tgt.extendDefinitions(tdefs.const());
        migrateDatabase.migrate(src, rewriter, tgt, (p) => events.push(p));

        assert.ok(events.length > 0);
        const last = events[events.length - 1];
        assert.equal(last.bytesTotal, total);                                  // denominator = source total blob bytes
        assert.equal(last.bytesCopied, total);                                 // bar reaches the total
        assert.equal(last.documents, 2);
        assert.equal(last.blobs, 2);
        assert.deepEqual([last.attachmentIndex, last.attachmentCount], [0, 1]);
        assert.equal(last.attachment, 'Items');
        const seq = events.map((e) => e.bytesCopied);                          // monotonic non-decreasing
        assert.deepEqual(seq, [...seq].sort((a, b) => a - b));
    });

    it('no callback is a no-op', () => {
        const src = V.Database.createInMemory();
        const defs = new V.Definitions();
        const c = defs.createConcept(NS, 'C');
        const docT = struct(defs, 'Doc', [['n', T.INT32]]);
        defs.createAttachment(NS, 'Docs', c, docT);
        src.extendDefinitions(defs.const());
        const att = src.definitions().attachments()[0];
        src.beginTransaction();
        src.set(att, att.createKey(new V.ValueUUId('11111111-1111-1111-1111-111111111111')),
            new V.ValueStructure(docT, { n: 1 }));
        src.commit();
        const { info } = migrate(src, new TransformationDirectives());          // no onProgress
        assert.equal(info.documents, 1);
    });
});


describe('migrateDatabase — source snapshot lifecycle', () => {
    function seed() {
        const src = V.Database.createInMemory();
        const defs = new V.Definitions();
        const c = defs.createConcept(NS, 'C');
        const doc = struct(defs, 'Doc', [['n', T.INT32]]);
        defs.createAttachment(NS, 'Docs', c, doc);
        src.extendDefinitions(defs.const());
        const att = src.definitions().attachments()[0];
        src.beginTransaction();
        src.set(att, att.createKey(new V.ValueUUId('11111111-1111-1111-1111-111111111111')),
            new V.ValueStructure(doc, { n: 1 }));
        src.commit();
        return src;
    }

    it('holds the source snapshot during the pass and releases it after', () => {
        const src = seed();
        const seen = {};
        const probe = (sourceStruct, fieldName, targetType, ctx) => {
            seen.during = src.inTransaction();                                 // snapshot held while the pass reads
            return new V.ValueInt32(0);
        };
        const d = new TransformationDirectives();
        d.addField('Demo::Doc', 'tag', T.INT32, probe);
        const [rewriter, tdefs] = DefinitionsRewriter.fromDirectives(src.definitions(), d);
        const tgt = V.Database.createInMemory();
        tgt.extendDefinitions(tdefs.const());
        migrateDatabase.migrate(src, rewriter, tgt);
        assert.equal(seen.during, true);                                       // in a read transaction during migration
        assert.equal(src.inTransaction(), false);                              // released afterward
    });

    it('releases the snapshot even on failure', () => {
        const src = seed();
        const boom = (sourceStruct, fieldName, targetType, ctx) => { throw new Error('boom'); };
        const d = new TransformationDirectives();
        d.addField('Demo::Doc', 'tag', T.INT32, boom);
        const [rewriter, tdefs] = DefinitionsRewriter.fromDirectives(src.definitions(), d);
        const tgt = V.Database.createInMemory();
        tgt.extendDefinitions(tdefs.const());
        assert.throws(() => migrateDatabase.migrate(src, rewriter, tgt), /boom/);
        assert.equal(src.inTransaction(), false);                              // source snapshot released on failure too
    });
});


describe('migrateDatabase — failure safety (all-or-nothing)', () => {
    const UUIDS = ['11111111-1111-1111-1111-111111111111',
        '22222222-2222-2222-2222-222222222222',
        '33333333-3333-3333-3333-333333333333'];

    function seed(db) {
        const defs = new V.Definitions();
        const c = defs.createConcept(NS, 'C');
        const doc = struct(defs, 'Doc', [['n', T.INT32]]);
        defs.createAttachment(NS, 'Docs', c, doc);
        db.extendDefinitions(defs.const());
        const att = db.definitions().attachments()[0];
        db.beginTransaction();
        for (const u of UUIDS) db.set(att, att.createKey(new V.ValueUUId(u)), new V.ValueStructure(doc, { n: 1 }));
        db.commit();
    }

    function boomDirectives() {
        let calls = 0;
        const boom = (sourceStruct, fieldName, targetType, ctx) => {
            calls += 1;
            if (calls === 3) throw new Error('boom mid-migration');
            return new V.ValueInt32(calls);
        };
        const d = new TransformationDirectives();
        d.addField('Demo::Doc', 'tag', T.INT32, boom);
        return d;
    }

    it('migrate rolls back on failure — no half-written documents', () => {
        const src = V.Database.createInMemory();
        seed(src);
        const [rewriter, tdefs] = DefinitionsRewriter.fromDirectives(src.definitions(), boomDirectives());
        const tgt = V.Database.createInMemory();
        tgt.extendDefinitions(tdefs.const());
        assert.throws(() => migrateDatabase.migrate(src, rewriter, tgt), /boom mid-migration/);
        assert.equal(tgt.inTransaction(), false);                              // exclusive transaction aborted
        const ta = tgt.definitions().attachments()[0];
        assert.equal(tgt.keys(ta).size(), 0);                                  // no half-written documents survive
    });

    it('run discards the partial target on failure', () => {
        const dir = mkdtempSync(join(tmpdir(), 'dbmig-'));
        const srcPath = join(dir, 'src.db');
        const tgtPath = join(dir, 'tgt.db');
        try {
            const src = V.Database.create(srcPath);
            seed(src);
            src.close();
            assert.throws(() => migrateDatabase.run(srcPath, boomDirectives, tgtPath), /boom mid-migration/);
            assert.equal(existsSync(tgtPath), false);                          // partial target discarded
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
