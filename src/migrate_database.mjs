// Database migration — the applied read-old / write-new loop. A 1:1 port of the Python module.
//
// Rebuild Base(A) (read-only) into a fresh Base(B) under the target registry. Never an in-place
// ALTER (a type's runtimeId is its storage key); the old artefact stays as rollback. Documents
// are transformed (not copied verbatim); blobs are copied ON REFERENCE (exactly the referenced
// blobs, never an orphan). This module is silo 2 in full: the loop (`migrate`), its round-trip
// self-check (`verify` / `VerificationError`), `dryRun`, and the `run` entry point.

import { unlinkSync } from 'node:fs';

import V from './dsviper.mjs';
import { copyBlob } from './blobs.mjs';
import { DefinitionsRewriter, Unrepresentable, DiagnosticSink } from './rewrite/index.mjs';
import { attHit } from './rewrite/engine.mjs';

/** @import * as D from '@digitalsubstrate/dsviper' */
/** @import { DefinitionsRewriter as Rewriter } from './rewrite/engine.mjs' */
/** @import { TransformationDirectives } from './rewrite/directives.mjs' */

/**
 * The progress snapshot handed to a `migrate` / `run` `onProgress` callback.
 * @typedef {object} DatabaseProgress
 * @property {number} documents documents written so far
 * @property {number} blobs blobs copied so far
 * @property {number} bytesCopied blob bytes streamed so far
 * @property {number} bytesTotal blob bytes held by the source
 * @property {string | null} attachment local name of the attachment being migrated
 * @property {number} attachmentIndex its index among the migrated attachments
 * @property {number} attachmentCount how many attachments are migrated
 */

/** @typedef {(progress: DatabaseProgress) => void} DatabaseProgressCallback */

/**
 * What `migrate` returns (and `run`, with `verification` when asked to verify).
 * @typedef {object} DatabaseMigrateInfo
 * @property {number} documents documents written to the target
 * @property {number} dropped documents elided by a drop-record policy
 * @property {number} blobs blobs copied to the target
 * @property {DatabaseVerification} [verification] the `verify` result (`run` with `verify: true`)
 */

/**
 * What `verify` returns.
 * @typedef {object} DatabaseVerification
 * @property {number} checked target documents proven equal to their rewritten source
 * @property {number} dropped source documents proven absent (dropped records)
 * @property {number} referencedBlobs blobs the target documents reference
 */

/**
 * What `dryRun` returns.
 * @typedef {object} DatabaseDryRunInfo
 * @property {number} documents documents that would be written
 * @property {number} dropped documents a drop-record policy would elide
 * @property {number} referencedBlobs blobs the rewritten documents would reference
 * @property {number} orphans source blobs no rewritten document references
 * @property {ReturnType<ReturnType<typeof DiagnosticSink>['report']>} diagnostics the per-site loss report
 */

export class VerificationError extends Error {}

// Accumulates progress and fires onProgress(progress) on each change. A null callback makes
// every method accumulate silently. Bytes advance per streamed chunk — so the bar moves even
// through one multi-gigabyte blob. The callback receives a plain object with the fields below.
class Progress {
    /**
     * @param {DatabaseProgressCallback | null} onProgress
     * @param {number} bytesTotal
     * @param {number} attachmentCount
     */
    constructor(onProgress, bytesTotal, attachmentCount) {
        this._cb = onProgress;
        this.bytesTotal = bytesTotal;
        this.attachmentCount = attachmentCount;
        this.documents = 0; this.blobs = 0; this.bytesCopied = 0;
        /** @type {string | null} */
        this.attachment = null;
        this.attachmentIndex = 0;
    }

    _fire() {
        if (this._cb !== null) this._cb({
            documents: this.documents, blobs: this.blobs, bytesCopied: this.bytesCopied,
            bytesTotal: this.bytesTotal, attachment: this.attachment,
            attachmentIndex: this.attachmentIndex, attachmentCount: this.attachmentCount,
        });
    }

    /** @param {string} name @param {number} index */
    enterAttachment(name, index) { this.attachment = name; this.attachmentIndex = index; this._fire(); }
    /** @param {number} n */
    addBytes(n) { this.bytesCopied += n; this._fire(); }       // per streamed chunk — drives the byte bar
    blobDone() { this.blobs += 1; }
    documentDone() { this.documents += 1; this._fire(); }
}


// Reprs of the struct/enum types reachable — in some document type graph — through a CONTAINER
// element (vector/set/map/xarray), i.e. at a position of element multiplicity. Struct fields,
// Optional, Tuple and Variant are multiplicity-1 and preserve the 'this is the record' scope; a
// container element breaks it (one among many).
/** @param {D.Type[]} documentTypes @returns {Set<string>} */
function carriersUnderContainer(documentTypes) {
    /** @type {Set<string>} */
    const under = new Set();
    /** @type {Set<string>} */
    const seen = new Set();                                     // "struct repr|nested" — breaks ref cycles

    /** @param {D.Type} t @param {boolean} nested */
    const walk = (t, nested) => {
        const tc = t.typeCode();
        if (tc === 'struct') {
            const s = V.TypeStructure.cast(t); const r = s.representation();
            if (nested) under.add(r);
            const key = `${r}|${nested}`;
            if (seen.has(key)) return;
            seen.add(key);
            for (const f of s.fields()) walk(f.type(), nested);
        } else if (tc === 'enum') {
            if (nested) under.add(t.representation());          // enums carry no further named types
        } else if (tc === 'optional') walk(V.TypeOptional.cast(t).elementType(), nested);   // multiplicity 1
        else if (tc === 'tuple') for (const x of V.TypeTuple.cast(t).types()) walk(x, nested);
        else if (tc === 'variant') for (const x of V.TypeVariant.cast(t).types()) walk(x, nested);
        else if (tc === 'vector') walk(V.TypeVector.cast(t).elementType(), true);           // container -> many
        else if (tc === 'set') walk(V.TypeSet.cast(t).elementType(), true);
        else if (tc === 'xarray') walk(V.TypeXArray.cast(t).elementType(), true);
        else if (tc === 'map') { const m = V.TypeMap.cast(t); walk(m.keyType(), true); walk(m.elementType(), true); }
        // key / any / concept / club / primitives: no statically-visible drop-record carrier
    };

    for (const dt of documentTypes) walk(dt, false);
    return under;
}


// Refuse — up front, before any data is touched — a drop-record policy whose bite site sits
// UNDER a container in some document, where 'drop the enclosing record' is ambiguous (the value
// is one element among many). drop-record is admissible only at document scope (multiplicity 1).
/** @param {D.Database} source @param {TransformationDirectives} directives */
function refuseAmbiguousDropRecord(source, directives) {
    /** @type {Record<string, string[]>} */
    const retypeCarriers = {};                                 // struct repr -> [field]
    for (const [s, fields] of Object.entries(directives.retypedFields))
        for (const [f, [, p]] of Object.entries(fields)) if (p === 'drop-record') (retypeCarriers[s] ??= []).push(f);
    /** @type {Record<string, string[]>} */
    const enumCarriers = {};                                   // enum repr -> [case]
    for (const [e, cases] of Object.entries(directives.removedCases))
        for (const [c, p] of Object.entries(cases)) if (p === 'drop-record') (enumCarriers[e] ??= []).push(c);
    if (!Object.keys(retypeCarriers).length && !Object.keys(enumCarriers).length) return;

    const under = carriersUnderContainer(source.definitions().attachments().map((a) => a.documentType()));
    /** @type {string[]} */
    const bad = [];
    for (const [s, fs] of Object.entries(retypeCarriers)) if (under.has(s)) for (const f of fs) bad.push(`${s}.${f}`);
    for (const [e, cs] of Object.entries(enumCarriers)) if (under.has(e)) for (const c of cs) bad.push(`${e}::${c}`);
    if (bad.length)
        throw new Error(`[unsupported] drop-record at ${bad.sort().join(', ')}: the value sits under a container (vector/set/map/xarray) in a document — 'drop the record' is ambiguous there (one element among many). drop-record is admissible only at document scope (reached through structs/optionals, multiplicity 1); use a value-closed policy (default / map-case) for a nested value, or restructure the schema.`);
}


// Refuse any drop-record policy unless the migration has explicitly signed off that it may
// DELETE whole documents (acceptDocumentDrops). dryRun does NOT call this — it informs the
// decision (identify -> inform -> acknowledge -> decide).
/** @param {TransformationDirectives} directives */
function refuseUnacknowledgedDrops(directives) {
    const sites = directives.dropRecordSites();
    if (sites.length && !directives.documentDropsAccepted)
        throw new Error(`[unacknowledged] this migration decrees drop-record at ${sites.sort().join(', ')} — it may DELETE whole documents (a record has no faithful image -> the enclosing document is elided). Run migrateDatabase.dryRun to see how many/which would drop, then call directives.acceptDocumentDrops() to authorize it explicitly.`);
}


// Refuse any drop_attachment unless the migration has signed off that it may DELETE whole
// attachments (acceptAttachmentDrops). Shared with the CommitDatabase loop (imported there).
/**
 * Refuse a migration that drops an attachment unless `directives.acceptAttachmentDrops()` was called.
 * @param {TransformationDirectives} directives the migration's edit script
 * @returns {void}
 * @throws {Error} when an attachment is dropped without that acknowledgement
 */
export function refuseUnacknowledgedAttachmentDrops(directives) {
    if (directives.droppedAttachments.size && !directives.attachmentDropsAccepted)
        throw new Error(`[unacknowledged] this migration drops the attachment(s) ${[...directives.droppedAttachments].sort().join(', ')} — it will DELETE every document they hold. Run migrateDatabase.dryRun to preview, then call directives.acceptAttachmentDrops() to authorize it explicitly.`);
}


// Hold ONE read (deferred) transaction on the source for the whole read, so every read sees a
// single consistent snapshot. The source is opened read-only but is NOT immutable: another
// process may del / delBlob concurrently. A deferred transaction takes a shared lock on first
// read; rollback releases it (nothing was written).
/**
 * @template T
 * @param {D.Database} source
 * @param {() => T} fn
 * @returns {T}
 */
function withSourceSnapshot(source, fn) {
    source.beginTransaction();
    try { return fn(); }
    finally { if (source.inTransaction()) source.rollback(); }
}


// Read every source document, rewrite it, and hand each kept result to sink(tgtAtt, tgtKey,
// tgtDoc); a drop-record policy that fires skips the document. Returns [documents, dropped,
// referenced]. Shared by `migrate` (sink = target.set) and `dryRun` (sink = no-op). Wires the
// diagnostic sink and the source view (attachmentGetting over Base(A)) for the duration.
/**
 * @param {D.Database} source
 * @param {Rewriter} rewriter
 * @param {(tgtAtt: D.Attachment, tgtKey: D.ValueKey, tgtDoc: D.Value) => void} sink
 * @param {{ diag?: ReturnType<typeof DiagnosticSink> | null, progress?: Progress | null }} [options]
 * @returns {[number, number, Set<string>]}
 */
function transformPass(source, rewriter, sink, { diag = null, progress = null } = {}) {
    let documents = 0; let dropped = 0;
    /** @type {Set<string>} */
    const referenced = new Set();
    rewriter._sink = diag;
    rewriter._sourceView = source.attachmentGetting();
    const atts = source.definitions().attachments()
        .filter((a) => !attHit(rewriter.d.droppedAttachments, a));
    try {
        for (let attI = 0; attI < atts.length; attI++) {
            const att = atts[attI];
            if (progress !== null) progress.enterAttachment(/** @type {string} */ (att.identifier().split('.').pop()), attI);   // a split has >= 1 part
            const tgtAtt = rewriter.attachment(att);
            const keys = source.keys(att);
            for (let i = 0; i < keys.size(); i++) {
                const key = V.ValueKey.cast(keys.at(i, false));
                const doc = source.get(att, key);                  // ValueOptional
                if (doc.isNil()) continue;
                rewriter._selfKey = key;                           // record identity for aggregate hooks
                let tgtDoc;
                try { tgtDoc = rewriter.value(/** @type {D.Value} */ (doc.unwrap(false))); }
                catch (e) { if (e instanceof Unrepresentable) { dropped++; continue; } throw e; }
                sink(tgtAtt, /** @type {D.ValueKey} */ (rewriter.value(key)), tgtDoc);   // a key rewrites to a key
                for (const b of V.Value.collectBlobIds(tgtDoc)) referenced.add(b.representation());
                documents++;
                if (progress !== null) progress.documentDone();
            }
        }
    } finally {
        rewriter._sink = null; rewriter._sourceView = null; rewriter._selfKey = null;
    }
    return [documents, dropped, referenced];
}


// Rewrite every document of `source` into `target` through `rewriter`. Assumes `target` has
// already been extended with `rewriter`'s target definitions. Owns its own exclusive
// transaction. Blobs are copied ON REFERENCE: just before a target document is written, every
// blob it references that the target lacks is streamed over. A drop-record policy that fires
// skips the document. Rolls back on any failure. Returns a transfer summary.
/**
 * Rewrite every document of `source` into `target` (already extended with the target definitions).
 * @param {D.Database} source the database read
 * @param {Rewriter} rewriter the rewriter built from the migration's directives
 * @param {D.Database} target the database written, in one exclusive transaction
 * @param {DatabaseProgressCallback | null} [onProgress] called on every progress change
 * @returns {DatabaseMigrateInfo} the transfer summary
 */
export function migrate(source, rewriter, target, onProgress = null) {
    refuseAmbiguousDropRecord(source, rewriter.d);         // coherence: no ambiguous record scope
    refuseUnacknowledgedDrops(rewriter.d);                 // authorization: document drops signed off
    refuseUnacknowledgedAttachmentDrops(rewriter.d);       // both fail closed, before any data is touched
    /** @type {Set<string>} */
    const copied = new Set();                              // blob-id reprs copied this run
    return withSourceSnapshot(source, () => {
        const liveAtts = source.definitions().attachments()
            .filter((a) => !attHit(rewriter.d.droppedAttachments, a));
        const progress = new Progress(onProgress, source.blobStatistics().totalSize(), liveAtts.length);
        target.beginTransaction(V.Databasing.TRANSACTION_EXCLUSIVE);

        /** @type {(tgtAtt: D.Attachment, tgtKey: D.ValueKey, tgtDoc: D.Value) => void} */
        const sink = (tgtAtt, tgtKey, tgtDoc) => {
            for (const blobId of V.Value.collectBlobIds(tgtDoc)) {
                const r = blobId.representation();
                if (!copied.has(r) && copyBlob(source, target.databasing(), blobId, (n) => progress.addBytes(n))) {
                    copied.add(r); progress.blobDone();       // streamed once; shared blobs deduped
                }
            }
            target.set(tgtAtt, tgtKey, tgtDoc);               // blob(s) present -> the document is writable
        };

        try {
            const [documents, dropped] = transformPass(source, rewriter, sink, { progress });
            target.commit();
            return { documents, dropped, blobs: copied.size };
        } catch (e) {
            // a mid-migration failure must not leave the exclusive transaction dangling.
            if (target.inTransaction()) target.rollback();
            throw e;
        }
    });
}


// Exercise the rewriter over every document of `source` WITHOUT writing anything — no target,
// no blob copy, no transaction. A DiagnosticSink records, per site, every Class-B policy that
// actually bit + a bounded sample of before->after values. Returns { documents, dropped,
// referencedBlobs, orphans, diagnostics }.
/**
 * Exercise the rewriter over every document of `source` without writing anything.
 * @param {D.Database} source the database read
 * @param {Rewriter} rewriter the rewriter built from the migration's directives
 * @param {{ maxSamples?: number }} [options] `maxSamples`: before -> after pairs kept per site
 * @returns {DatabaseDryRunInfo} the counts and the diagnostic report
 */
export function dryRun(source, rewriter, { maxSamples = 5 } = {}) {
    refuseAmbiguousDropRecord(source, rewriter.d);         // same admissible-scope check as migrate
    const sink = new DiagnosticSink(maxSamples);
    return withSourceSnapshot(source, () => {
        const [documents, dropped, referenced] = transformPass(source, rewriter, () => {}, { diag: sink });
        const orphans = [...source.blobIds()].filter((b) => !referenced.has(b.representation())).length;
        return { documents, dropped, referencedBlobs: referenced.size, orphans, diagnostics: sink.report() };
    });
}


// Prove `target` is the faithful image of `source` under `rewriter`: every kept document equals
// rewriter.value(sourceDoc) (content equality), every dropped record is absent, no spurious
// document, no dangling/leftover blob. Throws VerificationError on divergence.
/**
 * Prove `target` is the faithful image of `source` under `rewriter`.
 * @param {D.Database} source the migrated database
 * @param {Rewriter} rewriter the rewriter the migration used
 * @param {D.Database} target the database `migrate` wrote
 * @returns {DatabaseVerification} the verification counts
 * @throws {VerificationError} on any divergence
 */
export function verify(source, rewriter, target) {
    let checked = 0; let dropped = 0;
    // re-derive through the SAME engine wiring migrate uses (source view + self key), or the
    // self-check has blind spots exactly where the engine is most powerful.
    rewriter._sourceView = source.attachmentGetting();
    try {
        for (const att of source.definitions().attachments()) {
            if (attHit(rewriter.d.droppedAttachments, att)) continue;          // no target image
            const tgtAtt = rewriter.attachment(att);
            const keys = source.keys(att);
            for (let i = 0; i < keys.size(); i++) {
                const key = V.ValueKey.cast(keys.at(i, false));
                const sdoc = source.get(att, key);
                if (sdoc.isNil()) continue;
                rewriter._selfKey = key;                       // record identity for aggregate hooks
                const tgtKey = /** @type {D.ValueKey} */ (rewriter.value(key));   // a key rewrites to a key
                let expected;
                try { expected = rewriter.value(/** @type {D.Value} */ (sdoc.unwrap(false))); }
                catch (e) {
                    if (e instanceof Unrepresentable) {
                        if (target.has(tgtAtt, tgtKey)) throw new VerificationError(`dropped record present in target: ${tgtKey.representation()}`);
                        dropped++; continue;
                    }
                    throw e;
                }
                const got = target.get(tgtAtt, tgtKey);
                if (got.isNil()) throw new VerificationError(`missing target document: ${tgtKey.representation()}`);
                if (!/** @type {D.Value} */ (got.unwrap(false)).equals(expected)) throw new VerificationError(`value mismatch at ${tgtKey.representation()}`);
                checked++;
            }
        }
    } finally {
        rewriter._sourceView = null; rewriter._selfKey = null;
    }

    // no spurious document beyond the kept set
    let targetDocs = 0;
    for (const a of target.definitions().attachments()) targetDocs += target.keys(a).size();
    if (targetDocs !== checked) throw new VerificationError(`target holds ${targetDocs} documents, expected ${checked}`);

    // blob integrity: the target holds EXACTLY the referenced blobs — none dangling, none leftover.
    /** @type {Set<string>} */
    const referenced = new Set();
    for (const att of target.definitions().attachments()) {
        const keys = target.keys(att);
        for (let i = 0; i < keys.size(); i++) {
            const doc = target.get(att, V.ValueKey.cast(keys.at(i, false)));
            if (!doc.isNil()) for (const b of V.Value.collectBlobIds(/** @type {D.Value} */ (doc.unwrap(false)))) referenced.add(b.representation());
        }
    }
    const present = new Set([...target.blobIds()].map((b) => b.representation()));
    const dangling = [...referenced].filter((r) => !present.has(r));
    if (dangling.length) throw new VerificationError(`${dangling.length} referenced blob(s) absent from target`);
    const leftover = [...present].filter((r) => !referenced.has(r));
    if (leftover.length) throw new VerificationError(`${leftover.length} orphan blob(s) not swept from target`);

    return { checked, dropped, referencedBlobs: referenced.size };
}

// a stable handle to verify() — run()'s `verify` flag would otherwise shadow it in-body
const _verify = verify;


// Open the source read-only, build the directives against its live schema, transform, and write
// a fresh target database. The source is never modified. With verify:true, prove the target is
// a faithful image before closing it. A failed run discards the half-written target.
/**
 * Migrate the Database at `sourcePath` into a fresh Database at `targetPath`.
 * @param {string} sourcePath the source database, opened read-only
 * @param {(sourceDefs: D.DefinitionsConst) => TransformationDirectives} buildDirectives builds the edit script from the source's live definitions
 * @param {string} targetPath the target database, created
 * @param {{ verify?: boolean, onProgress?: DatabaseProgressCallback | null }} [options] `verify`: prove the target faithful before closing it
 * @returns {DatabaseMigrateInfo} the transfer summary, with `verification` when verified
 */
export function run(sourcePath, buildDirectives, targetPath, { verify = false, onProgress = null } = {}) {
    const source = V.Database.open(sourcePath, true);      // read-only
    try {
        const directives = buildDirectives(source.definitions());
        const [rewriter, targetDefs] = DefinitionsRewriter.fromDirectives(source.definitions(), directives);
        const target = V.Database.create(targetPath);
        let ok = false;
        try {
            target.extendDefinitions(targetDefs.const());  // manages its own transaction
            const info = migrate(source, rewriter, target, onProgress);
            if (verify) info.verification = _verify(source, rewriter, target);
            ok = true;
            return info;
        } finally {
            target.close();
            if (!ok) removeDbFile(targetPath);             // discard the half-written target
        }
    } finally {
        source.close();
    }
}


// Best-effort delete of a database file and its SQLite sidecars — used to discard a target that
// a failed run left half-written. Shared with the CommitDatabase loop (imported there).
/**
 * Best-effort delete of a database file and its SQLite sidecars.
 * @param {string} path the database file
 * @returns {void}
 */
export function removeDbFile(path) {
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
        try { unlinkSync(path + suffix); } catch { /* absent or unremovable — nothing to do */ }
    }
}
