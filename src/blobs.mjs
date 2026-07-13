// Shared blob byte-copy — stream a blob source -> target in 64 MB chunks, preserving
// its content-addressed id. Used by both the Database and CommitDatabase loops. A port
// of the Python blob helper. `source` is a Database/CommitDatabase (blobInfo + readBlob);
// `targetDatabasing` is target.databasing() / target.commitDatabasing() (createZeroBlob
// / writeBlob / freezeBlob).

const CHUNK = 64 * 1024 * 1024;

export function copyBlob(source, targetDatabasing, blobId) {
    const info = source.blobInfo(blobId);
    if (info === null || info === undefined) return false;
    const size = info.size();
    targetDatabasing.createZeroBlob(blobId, info.blobLayout(), size);
    let offset = 0;
    while (offset < size) {
        const chunk = Math.min(CHUNK, size - offset);
        targetDatabasing.writeBlob(blobId, source.readBlob(blobId, chunk, offset), offset);
        offset += chunk;
    }
    targetDatabasing.freezeBlob(blobId);
    return true;
}

export function copyBlobs(source, targetDatabasing, blobIds) {
    let n = 0;
    for (const b of blobIds) if (copyBlob(source, targetDatabasing, b)) n++;
    return n;
}
