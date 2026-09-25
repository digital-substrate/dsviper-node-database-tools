// Shared blob byte-copy — stream a blob source -> target in 64 MB chunks, preserving its
// content-addressed id (stable across databases). Used by both the `Database` and
// `CommitDatabase` migration loops. A 1:1 port of the Python blob helper.
//
// `source` is a Database/CommitDatabase (both expose blobInfo + readBlob); `targetDatabasing`
// is target.databasing() / target.commitDatabasing() (createZeroBlob / writeBlob / freezeBlob).

/** @import * as D from '@digitalsubstrate/dsviper' */

const CHUNK = 64 * 1024 * 1024;        // stream large blobs, never materialised whole

// Stream one blob's bytes source -> target, preserving its id. Returns true if copied, false if
// the source lacks it (an incoherent reference — skipped). `onBytes`, if given, is called with
// each chunk's byte count as it is written — so a caller can show byte-level progress even
// through a single multi-gigabyte blob.
/**
 * @param {D.Database | D.CommitDatabase} source the store the blob is read from
 * @param {D.Databasing | D.CommitDatabasing} targetDatabasing the target's databasing driver
 * @param {D.ValueBlobId} blobId the blob to copy (its id is preserved)
 * @param {((bytes: number) => void) | null} [onBytes] called with each chunk's byte count
 * @returns {boolean} true if copied, false if the source lacks the blob
 */
export function copyBlob(source, targetDatabasing, blobId, onBytes = null) {
    const info = source.blobInfo(blobId);
    if (info === null || info === undefined) return false;
    const size = info.size();
    targetDatabasing.createZeroBlob(blobId, info.blobLayout(), size);
    let offset = 0;
    while (offset < size) {
        const chunk = Math.min(CHUNK, size - offset);
        targetDatabasing.writeBlob(blobId, source.readBlob(blobId, chunk, offset), offset);
        offset += chunk;
        if (onBytes !== null) onBytes(chunk);
    }
    targetDatabasing.freezeBlob(blobId);
    return true;
}
