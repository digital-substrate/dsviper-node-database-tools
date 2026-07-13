// Round-trip verification — a migration tool must prove its own correctness. Port of
// the Python verifier: re-derive the expected target from the (read-only) source
// through the same transformer and assert the target matches (every kept doc equals
// value(sourceDoc), dropped records absent, no spurious doc, no dangling blob ref).

import V from './dsviper.mjs';
import { DropRecord } from './rewrite.mjs';

export class VerificationError extends Error {}

export function verifyMigration(source, transformer, target) {
    let checked = 0;
    let dropped = 0;
    for (const att of source.definitions().attachments()) {
        const tgtAtt = transformer.attachment(att);
        const keys = source.keys(att);
        for (let i = 0; i < keys.size(); i++) {
            const key = keys.at(i, false);
            const sdoc = source.get(att, key);
            if (sdoc.isNil()) continue;
            const tgtKey = transformer.value(key);
            let expected;
            try {
                expected = transformer.value(sdoc.unwrap(false));
            } catch (e) {
                if (e instanceof DropRecord) {
                    if (target.has(tgtAtt, tgtKey))
                        throw new VerificationError(`dropped record present in target: ${tgtKey.representation()}`);
                    dropped++;
                    continue;
                }
                throw e;
            }
            const got = target.get(tgtAtt, tgtKey);
            if (got.isNil()) throw new VerificationError(`missing target document: ${tgtKey.representation()}`);
            if (!got.unwrap(false).equals(expected))
                throw new VerificationError(`value mismatch at ${tgtKey.representation()}`);
            checked++;
        }
    }

    // no spurious document beyond the kept set
    let targetDocs = 0;
    for (const att of target.definitions().attachments()) targetDocs += target.keys(att).size();
    if (targetDocs !== checked)
        throw new VerificationError(`target holds ${targetDocs} documents, expected ${checked}`);

    // referential integrity: every referenced blob is present (no dangling reference)
    const referenced = new Map();          // repr -> ValueBlobId
    for (const att of target.definitions().attachments()) {
        const keys = target.keys(att);
        for (let i = 0; i < keys.size(); i++) {
            const doc = target.get(att, keys.at(i, false));
            if (!doc.isNil())
                for (const b of V.Value.collectBlobIds(doc.unwrap(false))) referenced.set(b.representation(), b);
        }
    }
    const present = new Set([...target.blobIds()].map((b) => b.representation()));
    for (const [repr] of referenced)
        if (!present.has(repr)) throw new VerificationError(`referenced blob absent from target: ${repr}`);

    return { checked, dropped, referencedBlobs: referenced.size };
}
