// Database migration — the applied read-old / write-new loop. Port of the Python
// migration loop. Rebuild Base(A) (read-only) into a fresh Base(B) under the target
// registry; never an in-place ALTER. Documents are transformed; blobs are streamed
// first, then a mark-sweep reclaims those a schema change stranded. Owns one exclusive
// transaction (blobs before documents, one unit).

import V from './dsviper.mjs';
import { copyBlobs } from './blobs.mjs';
import { DefinitionsTransformer, DropRecord } from './rewrite.mjs';
import { verifyMigration } from './verify.mjs';

export function migrateDatabase(source, transformer, target) {
    const allBlobs = [...source.blobIds()];

    target.beginTransaction(V.Databasing.TRANSACTION_EXCLUSIVE);

    const blobs = copyBlobs(source, target.databasing(), allBlobs);   // blobs first (streamed)

    let documents = 0;
    let dropped = 0;
    const referenced = new Set();                                     // blob-id representations
    for (const att of source.definitions().attachments()) {
        const tgtAtt = transformer.attachment(att);
        const keys = source.keys(att);
        for (let i = 0; i < keys.size(); i++) {
            const key = keys.at(i, false);
            const doc = source.get(att, key);                          // ValueOptional
            if (doc.isNil()) continue;
            let tgtDoc;
            try {
                tgtDoc = transformer.value(doc.unwrap(false));
            } catch (e) {
                if (e instanceof DropRecord) { dropped++; continue; }  // policy: skip this document
                throw e;
            }
            target.set(tgtAtt, transformer.value(key), tgtDoc);
            for (const b of V.Value.collectBlobIds(tgtDoc)) referenced.add(b.representation());
            documents++;
        }
    }

    const orphans = allBlobs.filter((b) => !referenced.has(b.representation()));  // stranded
    for (const b of orphans) target.delBlob(b);

    target.commit();
    return { documents, dropped, blobs, orphansSwept: orphans.length };
}

export function runMigration(sourcePath, buildDirectives, targetPath, { verify = false } = {}) {
    const source = V.Database.open(sourcePath, true);              // read-only
    try {
        const directives = buildDirectives(source.definitions());
        const [transformer, targetDefs] = DefinitionsTransformer.fromDirectives(source.definitions(), directives);
        const target = V.Database.create(targetPath);
        try {
            target.extendDefinitions(targetDefs.const());          // manages its own transaction
            const info = migrateDatabase(source, transformer, target);
            if (verify) info.verification = verifyMigration(source, transformer, target);
            return info;
        } finally {
            target.close();
        }
    } finally {
        source.close();
    }
}
