// Database migration loop — real read-old / write-new over an in-memory Database,
// including blob byte-copy, orphan mark-sweep, and self-verification. Port of
// the Python migration-loop tests.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import V from '../src/dsviper.mjs';
import { TransformationDirectives } from '../src/rewrite/index.mjs';
import { DefinitionsRewriter } from '../src/rewrite/index.mjs';
import * as migrateDatabase from '../src/migrate_database.mjs';

const T = V.Type;
const NS = new V.NameSpace(new V.ValueUUId('6ba7b810-9dad-11d1-80b4-00c04fd430c8'), 'Demo');

function struct(defs, name, fields) {
    const d = new V.TypeStructureDescriptor(name);
    for (const [fn, ft] of fields) d.addField(fn, ft);
    return defs.createStructure(NS, d);
}

function migrate(srcDb, directives) {
    const [transformer, targetDefs] = DefinitionsRewriter.fromDirectives(srcDb.definitions(), directives);
    const tgtDb = V.Database.createInMemory();
    tgtDb.extendDefinitions(targetDefs.const());
    const info = migrateDatabase.migrate(srcDb, transformer, tgtDb);
    return { tgtDb, transformer, info };
}

describe('migrateDatabase', () => {
    it('rename field migration (in-memory)', () => {
        const src = V.Database.createInMemory();
        const defs = new V.Definitions();
        const c = defs.createConcept(NS, 'Customer');
        const order = struct(defs, 'Order', [['qty', T.INT32]]);
        defs.createAttachment(NS, 'Orders', c, order);
        src.extendDefinitions(defs.const());
        const att = src.definitions().attachments()[0];
        const key = att.createKey(new V.ValueUUId('22222222-2222-2222-2222-222222222222'));
        src.beginTransaction();
        src.set(att, key, new V.ValueStructure(order, { qty: 5 }));
        src.commit();

        const d = new TransformationDirectives();
        d.renameField(order.representation(), 'qty', 'count');
        const { tgtDb, info } = migrate(src, d);

        assert.equal(info.documents, 1);
        const tatt = tgtDb.definitions().attachments()[0];
        const tkey = tgtDb.keys(tatt).at(0, false);
        const doc = tgtDb.get(tatt, tkey);
        assert.ok(!doc.isNil());
        assert.equal(V.ValueStructure.cast(doc.unwrap(false)).at('count'), 5);
    });

    it('blob bytes copied + orphan swept + self-verified', () => {
        const src = V.Database.createInMemory();
        const defs = new V.Definitions();
        const item = defs.createConcept(NS, 'Item');
        const docT = struct(defs, 'Doc', [['name', T.STRING], ['thumb', T.BLOB_ID], ['old', T.BLOB_ID]]);
        defs.createAttachment(NS, 'Items', item, docT);
        src.extendDefinitions(defs.const());
        const layout = new V.BlobLayout('uchar', 1);
        src.beginTransaction();
        const kept = src.createBlob(layout, new V.ValueBlob(Buffer.from([10, 20, 30, 40])));
        const orphan = src.createBlob(layout, new V.ValueBlob(Buffer.from([9, 9, 9])));
        const att = src.definitions().attachments()[0];
        const key = att.createKey(new V.ValueUUId('33333333-3333-3333-3333-333333333333'));
        src.set(att, key, new V.ValueStructure(docT, { name: 'x', thumb: kept, old: orphan }));
        src.commit();

        const d = new TransformationDirectives();
        d.renameField(docT.representation(), 'name', 'title');
        d.dropField(docT.representation(), 'old');                      // orphans the second blob
        const { tgtDb, transformer, info } = migrate(src, d);

        // copy-on-reference: only the referenced (kept) blob is streamed — the dropped-field
        // blob is never copied, so there is nothing to sweep (blobs=1, no orphansSwept).
        assert.deepEqual(info, { documents: 1, dropped: 0, blobs: 1 });

        const tatt = tgtDb.definitions().attachments()[0];
        const tdoc = V.ValueStructure.cast(tgtDb.get(tatt, tgtDb.keys(tatt).at(0, false)).unwrap(false));
        assert.equal(tdoc.at('title'), 'x');
        const thumb = tdoc.at('thumb', false);
        assert.equal(thumb.representation(), kept.representation());
        assert.deepEqual([...Buffer.from(tgtDb.blob(thumb).encoded())], [10, 20, 30, 40]);

        // the orphan is gone; only the referenced blob survives
        const surviving = new Set([...tgtDb.blobIds()].map((b) => b.representation()));
        assert.deepEqual(surviving, new Set([kept.representation()]));
        assert.ok(!surviving.has(orphan.representation()));

        assert.deepEqual(migrateDatabase.verify(src, transformer, tgtDb), { checked: 1, dropped: 0, referencedBlobs: 1 });
    });

    it('a shared blob is copied once (copy-on-reference dedups)', () => {
        // two documents referencing the SAME blob copy it once.
        const src = V.Database.createInMemory();
        const defs = new V.Definitions();
        const item = defs.createConcept(NS, 'Item');
        const docT = struct(defs, 'Doc', [['thumb', T.BLOB_ID]]);
        defs.createAttachment(NS, 'Items', item, docT);
        src.extendDefinitions(defs.const());
        const att = src.definitions().attachments()[0];
        src.beginTransaction();
        const shared = src.createBlob(new V.BlobLayout('uchar', 1), new V.ValueBlob(Buffer.from([1, 2, 3])));
        for (const u of ['11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222'])
            src.set(att, att.createKey(new V.ValueUUId(u)), new V.ValueStructure(docT, { thumb: shared }));
        src.commit();

        const { tgtDb, info } = migrate(src, new TransformationDirectives());
        assert.equal(info.documents, 2);
        assert.equal(info.blobs, 1);                                    // the shared blob streamed once
        assert.equal([...tgtDb.blobIds()].length, 1);
    });
});
