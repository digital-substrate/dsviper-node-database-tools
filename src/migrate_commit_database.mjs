// CommitDatabase migration — faithful structural replay. A 1:1 port of the Python module.
//
// Re-issue every commit in topological order, remapping ids (old->new) and translating each
// opcode through the rewrite engine. History is PRESERVED. Because state() is a structural DFS
// linearization in which the CommitId is an IDENTITY key (dedup of re-convergent arcs) and never
// an ordering key, migration preserves the DAG topology and therefore COMMUTES with evaluation:
//   state(target, remap[C]) == migrate(state(source, C))  -- every commit C, merges included.
//
// This module is silo 3 in full: the replay loop (`migrate`), its round-trip self-check
// (`verify`), `dryRun`, and the `run` entry point. `VerificationError` / `removeDbFile` /
// `refuseUnacknowledgedAttachmentDrops` are imported from the Database silo.

import V from './dsviper.mjs';
import { copyBlob } from './blobs.mjs';
import { DefinitionsRewriter, Unrepresentable, DiagnosticSink } from './rewrite/index.mjs';
import { attHit } from './rewrite/engine.mjs';
import { VerificationError, removeDbFile, refuseUnacknowledgedAttachmentDrops } from './migrate_database.mjs';

export { VerificationError };

// Accumulates progress and fires onProgress(progress) on each change. The dominant cost is blob
// BYTES; commits/commitCount give a cheap structural position. The callback receives a plain
// object { commits, commitCount, blobs, bytesCopied, bytesTotal }.
class Progress {
    constructor(onProgress, commitCount, bytesTotal) {
        this._cb = onProgress;
        this.commitCount = commitCount;
        this.bytesTotal = bytesTotal;
        this.commits = 0; this.blobs = 0; this.bytesCopied = 0;
    }

    _fire() {
        if (this._cb !== null) this._cb({
            commits: this.commits, commitCount: this.commitCount, blobs: this.blobs,
            bytesCopied: this.bytesCopied, bytesTotal: this.bytesTotal,
        });
    }

    addBytes(n) { this.bytesCopied += n; this._fire(); }       // per streamed chunk — drives the byte bar
    blobDone() { this.blobs += 1; }
    commitDone() { this.commits += 1; this._fire(); }
}


// -- path remapper: rebuild a PathConst source -> target, renaming each Field (via the struct's
//    fieldRenames at that level) and transforming Key/Position values; walk path + type in
//    lockstep. Returns [target PathConst, terminal [structRepr, field] | null].
export function translatePath(rewriter, sourceDocType, sourcePath) {
    let cur = sourceDocType;
    let out = new V.Path();
    let terminal = null;
    for (const comp of sourcePath.components()) {
        const kind = comp.type();
        if (kind === 'Field') {
            const fname = comp.value(true);
            const st = V.TypeStructure.cast(cur);
            const nw = (rewriter.d.fieldRenames[st.representation()] ?? {})[fname] ?? fname;
            out = out.field(nw);
            terminal = [st.representation(), fname];
            cur = st.check(fname).type();
        } else if (kind === 'Index') {
            out = out.index(comp.value(true));
            cur = V.TypeVector.cast(cur).elementType();
            terminal = null;
        } else if (kind === 'Key') {
            out = out.key(comp.value(false));               // domain-free keys for now
            cur = V.TypeMap.cast(cur).elementType();
            terminal = null;
        } else if (kind === 'Unwrap') {
            out = out.unwrap();
            cur = V.TypeOptional.cast(cur).elementType();
            terminal = null;
        } else if (kind === 'Position') {
            out = out.position(comp.value(false));
            cur = V.TypeXArray.cast(cur).elementType();
            terminal = null;
        } else {
            throw new Error(`path component '${kind}' not handled`);
        }
    }
    return [out.const(), terminal];
}

// The value for a Document_Update, converted to the target type at the path: routed through the
// terminal field's retype policy (Class B), else to the path type.
function updateValue(rewriter, op, tgtAtt, path, terminal) {
    const retype = terminal && (rewriter.d.retypedFields[terminal[0]] ?? {})[terminal[1]];
    if (retype) { const [newType, policy] = retype; return rewriter._retype(op.value(), newType, policy); }
    return rewriter.value(op.value(), path.checkType(tgtAtt.documentType()));
}

// Re-issue one opcode (all verbs except XArray_Insert, which is paired) onto the target
// AttachmentMutating, transformed. Each verb that ADDS a value streams its referenced blobs into
// the target first (ensureBlobs) — a document cannot be persisted referencing an absent blob.
export function translateOpcode(op, am, rewriter, sourceDefs, ensureBlobs) {
    const args = op.arguments(sourceDefs);
    const att = args[0]; const key = args[1];
    rewriter._selfKey = key;                          // record identity for aggregate hooks
    const tgtAtt = rewriter.attachment(att); const tgtKey = rewriter.value(key);
    const kind = op.type();

    if (kind === 'Document_Set') {
        const v = rewriter.value(op.value()); ensureBlobs(v);
        am.set(tgtAtt, tgtKey, v);
        return;
    }
    const [path, terminal] = translatePath(rewriter, att.documentType(), op.path());

    if (kind === 'Document_Update') {
        const v = updateValue(rewriter, op, tgtAtt, path, terminal); ensureBlobs(v);
        am.update(tgtAtt, tgtKey, path, v);
    } else if (kind === 'Set_Union') {
        const v = rewriter.value(op.value()); ensureBlobs(v);
        am.unionInSet(tgtAtt, tgtKey, path, v);
    } else if (kind === 'Set_Subtract') {
        am.subtractInSet(tgtAtt, tgtKey, path, rewriter.value(op.value()));   // removal, no blob added
    } else if (kind === 'Map_Union') {
        const v = rewriter.value(op.value()); ensureBlobs(v);
        am.unionInMap(tgtAtt, tgtKey, path, v);
    } else if (kind === 'Map_Update') {
        const v = rewriter.value(op.value()); ensureBlobs(v);
        am.updateInMap(tgtAtt, tgtKey, path, v);
    } else if (kind === 'Map_Subtract') {
        am.subtractInMap(tgtAtt, tgtKey, path, rewriter.value(op.value()));   // value = set of keys
    } else if (kind === 'XArray_Update') {
        const v = rewriter.value(op.value()); ensureBlobs(v);
        am.updateInXarray(tgtAtt, tgtKey, path, op.position(), v);
    } else if (kind === 'XArray_Remove') {
        am.removeInXarray(tgtAtt, tgtKey, path, op.position());
    } else {
        throw new Error(`opcode '${kind}' not handled`);
    }
}

// True if `op` addresses a dropped attachment — its documents are absent from the target, so the
// opcode is not re-issued (skipped). The CommitDatabase parity of silo 2 skipping a dropped
// attachment's documents: uniform over the whole partition; keys are not foreign keys.
function addressesDroppedAttachment(op, sourceDefs, dropped) {
    return dropped.size > 0 && attHit(dropped, op.arguments(sourceDefs)[0]);
}

// An insertInXarray(...value) is stored as XArray_Insert (empty position) + XArray_Update (the
// value) — always adjacent. Re-fuse the pair into one insert. Opcodes addressing a dropped
// attachment are skipped (the insert PAIR together).
function replayOpcodes(ops, am, rewriter, sourceDefs, ensureBlobs) {
    const dropped = rewriter.d.droppedAttachments;
    let i = 0;
    while (i < ops.length) {
        const op = ops[i];
        const isInsert = op.type() === 'XArray_Insert';
        if (addressesDroppedAttachment(op, sourceDefs, dropped)) {
            i += isInsert ? 2 : 1;                     // skip the paired update too
            continue;
        }
        if (isInsert) {
            const nxt = ops[i + 1];                    // the paired XArray_Update
            const args = op.arguments(sourceDefs);
            const att = args[0]; const key = args[1];
            rewriter._selfKey = key;                   // record identity for aggregate hooks
            const [path] = translatePath(rewriter, att.documentType(), op.path());
            const v = rewriter.value(nxt.value()); ensureBlobs(v);
            am.insertInXarray(rewriter.attachment(att), rewriter.value(key), path,
                op.beforePosition(), op.position(), v);
            i += 2;
        } else {
            translateOpcode(op, am, rewriter, sourceDefs, ensureBlobs);
            i += 1;
        }
    }
}


// Faithful structural replay of `source` into `target` under the transformed schema. Owns one
// exclusive transaction (all-or-nothing — rolled back on any failure): re-issues every commit in
// topological order, threading an old->new id map, and streams each blob an opcode references ON
// REFERENCE (deduped). Returns { commits, blobs, remap }.
export function migrate(source, rewriter, target, onProgress = null) {
    // drop-record is record-scoped (elides a document); a CommitDatabase stores opcodes, not
    // documents, so refuse it up front with a clear message rather than aborting mid-replay.
    const sites = rewriter.d.dropRecordSites();
    if (sites.length)
        throw new Error(`[unsupported] drop-record policy at ${sites.join(', ')}: a CommitDatabase migration rewrites opcode-carried values, which have no document 'record' to drop. drop-record is a Database-level policy — use a value-level policy (default / map-case) here, or migrate via a Database.`);

    // drop_attachment is static and uniform (skip every opcode that addresses it), so admissible
    // here exactly as on a Database — under the same shared acknowledgement gate.
    refuseUnacknowledgedAttachmentDrops(rewriter.d);

    const driver = source.commitDatabasing();
    const instancing = source.streamCodecInstancing();
    const targetDriver = target.commitDatabasing();
    const remap = {};

    // `remap` grows in topological order, so when a commit's values are transformed every
    // commit_id they reference is already known; the engine remaps intra-DAG references.
    rewriter._commitIdRemap = remap;
    const copied = new Set();                          // blob-id reprs copied this run
    const progress = new Progress(onProgress, source.commitIds().length, source.blobStatistics().totalSize());

    const ensureBlobs = (value) => {                   // copy-on-reference (deduped)
        for (const blobId of V.Value.collectBlobIds(value)) {
            const r = blobId.representation();
            if (!copied.has(r) && copyBlob(source, targetDriver, blobId, (n) => progress.addBytes(n))) {
                copied.add(r); progress.blobDone();
            }
        }
    };

    targetDriver.beginTransaction(V.Databasing.TRANSACTION_EXCLUSIVE);
    try {
        for (const cd of V.CommitData.sort(driver.commitDatas())) {
            const h = cd.header();
            const ctype = h.commitType();
            const parent = h.parentCommitId();
            let newId;

            if (ctype === 'Mutations') {
                const base = parent.isValid()
                    ? V.CommitStateBuilder.state(target, remap[parent.representation()])
                    : V.CommitStateBuilder.initialState(target);
                const cms = new V.CommitMutableState(base);
                // source view for a non-local Class-C hook: the source state at *this* commit
                // (CommitState@C == Database@C). verify re-derives under this same @C view, so
                // wiring it here (not the parent) makes migrate and verify agree by construction.
                const sview = V.CommitStateBuilder.state(source, h.commitId());
                rewriter._sourceView = sview.attachmentGetting();
                try {
                    replayOpcodes(cd.opcodes(instancing, source.definitions()),
                        cms.attachmentMutating(), rewriter, source.definitions(), ensureBlobs);
                } catch (e) {
                    if (e instanceof Unrepresentable) {
                        // An opcode operand with no faithful target image (a Class-C hook drop).
                        // Record-scoped loss has no opcode-level meaning — refuse the whole
                        // migration (roll back), don't silently skip the opcode.
                        throw new Error(`[unsupported] commit ${h.commitId().representation().slice(0, 8)}: an opcode's value has no faithful target image (dropped by a Class-C hook). A CommitDatabase migration rewrites a trace of mutations and cannot elide one without corrupting the document's trajectory — record-scoped loss is a Database-level act. Return a representable value (or use a value-closed policy), or migrate via a Database.`, { cause: e });
                    }
                    throw e;
                }
                newId = target.commitMutations(h.label(), cms);
            } else if (ctype === 'Merge' || ctype === 'Enable' || ctype === 'Disable') {
                const reissue = { Merge: 'mergeCommit', Enable: 'enableCommit', Disable: 'disableCommit' }[ctype];
                newId = target[reissue](h.label(), remap[parent.representation()],
                    remap[h.targetCommitId().representation()]);
            } else {
                throw new Error(`commit type '${ctype}' not handled`);
            }

            remap[h.commitId().representation()] = newId;
            progress.commitDone();
        }
        targetDriver.commit();
    } catch (e) {
        // a mid-replay failure must not leave the exclusive transaction dangling: abort it. The
        // DAG replay is one atomic act — all commits re-issued or none.
        if (targetDriver.inTransaction()) targetDriver.rollback();
        throw e;
    } finally {
        rewriter._commitIdRemap = null;
        rewriter._sourceView = null;
        rewriter._selfKey = null;
    }

    return { commits: Object.keys(remap).length, blobs: copied.size, remap };
}


// The rewritten operand of one opcode — the same rule translateOpcode applies, so the two agree
// by construction. XArray_Insert/XArray_Remove carry no operand; a Document_Update's value is
// routed through the terminal field's retype policy; every other verb is a plain engine rewrite.
function rewrittenOpcodeValue(op, rewriter, tgtAtt, path, terminal) {
    const kind = op.type();
    if (kind === 'XArray_Insert' || kind === 'XArray_Remove') return null;
    if (kind === 'Document_Update') return updateValue(rewriter, op, tgtAtt, path, terminal);
    return rewriter.value(op.value());
}

// A source->target commit link (a parent or a merge/enable/disable target) is preserved iff the
// target id is the remapped source id — or both are invalid (a root has no parent).
function linkPreserved(srcId, tgtId, remap) {
    if (!srcId.isValid()) return !tgtId.isValid();
    const mapped = remap[srcId.representation()];
    return mapped !== undefined && tgtId.representation() === mapped.representation();
}


// Prove every opcode was CORRECTLY REWRITTEN (the per-opcode twin of the Database verify) and the
// DAG TOPOLOGY preserved. Re-derives each source opcode's rewrite independently under the
// commit's own @C view and checks the stored target opcode carries exactly that; checks every
// parent link and a Merge/Enable/Disable's target link is the remapped source id. Does NOT
// compare materialised CommitStates (a best-effort, LWW reconstruction — the wrong oracle).
export function verify(source, rewriter, target, remap) {
    const srcIds = source.commitIds();

    // history preserved: same commit count, every source commit re-issued
    if (target.commitIds().length !== srcIds.length)
        throw new VerificationError(`target holds ${target.commitIds().length} commits, expected ${srcIds.length}`);
    for (const c of srcIds)
        if (!(c.representation() in remap)) throw new VerificationError(`source commit ${c.representation().slice(0, 8)} was not re-issued`);

    const instancing = source.streamCodecInstancing();
    const srcDefs = source.definitions(); const tgtDefs = target.definitions();
    const tgtById = {};
    for (const cd of target.commitDatabasing().commitDatas()) tgtById[cd.header().commitId().representation()] = cd;

    let checked = 0;
    const referenced = new Set();
    const prevRemap = rewriter._commitIdRemap;
    rewriter._commitIdRemap = remap;                   // remap intra-DAG commit_id leaves
    try {
        for (const cd of V.CommitData.sort(source.commitDatabasing().commitDatas())) {
            const h = cd.header();
            const ctype = h.commitType();
            const crepr = h.commitId().representation();
            const tgtCd = tgtById[remap[crepr].representation()];
            const tgtH = tgtCd.header();
            if (tgtH.commitType() !== ctype)
                throw new VerificationError(`commit ${crepr.slice(0, 8)}: type mismatch — ${tgtH.commitType()} != ${ctype}`);

            // topology preserved: every commit's parent link — and a Merge/Enable/Disable's target
            // link — must be the remapped source id (or invalid -> invalid at a root).
            if (!linkPreserved(h.parentCommitId(), tgtH.parentCommitId(), remap))
                throw new VerificationError(`commit ${crepr.slice(0, 8)}: parent link not preserved`);
            if (ctype !== 'Mutations') {
                if (!linkPreserved(h.targetCommitId(), tgtH.targetCommitId(), remap))
                    throw new VerificationError(`commit ${crepr.slice(0, 8)}: ${ctype} target link not preserved`);
                continue;
            }

            // the commit's own materialised source state — a non-local hook must re-derive under
            // the same @C snapshot migrate used.
            rewriter._sourceView = V.CommitStateBuilder.state(source, h.commitId()).attachmentGetting();
            const srcOps = cd.opcodes(instancing, srcDefs)
                .filter((o) => !addressesDroppedAttachment(o, srcDefs, rewriter.d.droppedAttachments));
            const tgtOps = tgtCd.opcodes(instancing, tgtDefs);
            if (srcOps.length !== tgtOps.length)
                throw new VerificationError(`commit ${crepr.slice(0, 8)}: ${tgtOps.length} opcodes, expected ${srcOps.length}`);

            for (let j = 0; j < srcOps.length; j++) {
                const so = srcOps[j]; const to = tgtOps[j];
                const kind = so.type();
                if (to.type() !== kind)
                    throw new VerificationError(`commit ${crepr.slice(0, 8)}: opcode type mismatch — ${to.type()} != ${kind}`);
                const sArgs = so.arguments(srcDefs); const tArgs = to.arguments(tgtDefs);
                const sAtt = sArgs[0]; const sKey = sArgs[1]; const tAtt = tArgs[0]; const tKey = tArgs[1];
                rewriter._selfKey = sKey;              // record identity for aggregate hooks
                if (rewriter.attachment(sAtt).identifier() !== tAtt.identifier())
                    throw new VerificationError(`commit ${crepr.slice(0, 8)}: ${kind} attachment mismatch`);
                if (!rewriter.value(sKey).equals(tKey))
                    throw new VerificationError(`commit ${crepr.slice(0, 8)}: ${kind} key mismatch`);

                let path = null; let terminal = null;
                if (kind !== 'Document_Set') {
                    [path, terminal] = translatePath(rewriter, sAtt.documentType(), so.path());
                    if (to.path().representation() !== path.representation())
                        throw new VerificationError(`commit ${crepr.slice(0, 8)}: ${kind} path mismatch`);
                }

                const expVal = rewrittenOpcodeValue(so, rewriter, tAtt, path, terminal);
                if (expVal !== null) {
                    if (!to.value().equals(expVal))
                        throw new VerificationError(`commit ${crepr.slice(0, 8)}: ${kind} value mismatch`);
                    for (const b of V.Value.collectBlobIds(expVal)) referenced.add(b.representation());
                }
                checked++;
            }
        }
    } finally {
        rewriter._commitIdRemap = prevRemap;
        rewriter._sourceView = null;
        rewriter._selfKey = null;
    }

    // blob integrity: the target holds EXACTLY the blobs its opcodes reference.
    const present = new Set([...target.blobIds()].map((b) => b.representation()));
    const dangling = [...referenced].filter((r) => !present.has(r));
    if (dangling.length) throw new VerificationError(`${dangling.length} referenced blob(s) absent from target`);
    const leftover = [...present].filter((r) => !referenced.has(r));
    if (leftover.length) throw new VerificationError(`${leftover.length} orphan blob(s) present in target`);

    return { commits: srcIds.length, checked, referencedBlobs: referenced.size };
}


// Exercise the rewriter over every opcode of `source` WITHOUT writing — no target, no blob copy,
// no transaction. A record-scoped loss has no opcode-level meaning (migrate refuses it); dryRun
// COLLECTS those would-abort sites up front. Returns { commits, opcodes, referencedBlobs,
// strandedBlobs, unrepresentable, diagnostics }.
export function dryRun(source, rewriter, { maxSamples = 5 } = {}) {
    const sink = new DiagnosticSink(maxSamples);
    const instancing = source.streamCodecInstancing();
    const srcDefs = source.definitions();
    let commits = 0; let opcodes = 0;
    const referenced = new Set();
    // statically-known record-scoped losses would abort migrate too — surface them alongside the
    // dynamically-discovered hook drops, in one would-abort list.
    const unrepresentable = rewriter.d.dropRecordSites().sort().map((s) => `${s} (drop-record policy)`);

    rewriter._sink = sink;
    rewriter._commitIdRemap = {};                      // no target ids yet -> commit_ids kept verbatim
    try {
        for (const cd of V.CommitData.sort(source.commitDatabasing().commitDatas())) {
            const h = cd.header();
            if (h.commitType() !== 'Mutations') continue;   // Merge/Enable/Disable carry no opcodes
            commits++;
            rewriter._sourceView = V.CommitStateBuilder.state(source, h.commitId()).attachmentGetting();
            for (const op of cd.opcodes(instancing, srcDefs)) {
                if (addressesDroppedAttachment(op, srcDefs, rewriter.d.droppedAttachments)) continue;
                opcodes++;
                const kind = op.type();
                const args = op.arguments(srcDefs);
                const att = args[0]; const key = args[1];
                rewriter._selfKey = key;
                const tgtAtt = rewriter.attachment(att);
                try {
                    let v;
                    if (kind === 'Document_Set') {
                        v = rewriter.value(op.value());
                    } else {
                        const [path, terminal] = translatePath(rewriter, att.documentType(), op.path());
                        v = rewrittenOpcodeValue(op, rewriter, tgtAtt, path, terminal);
                    }
                    if (v !== null) for (const b of V.Value.collectBlobIds(v)) referenced.add(b.representation());
                } catch (e) {
                    if (e instanceof Unrepresentable)
                        unrepresentable.push(`commit ${h.commitId().representation().slice(0, 8)} ${kind} ${key.representation()}`);
                    else throw e;
                }
            }
        }
    } finally {
        rewriter._sink = null;
        rewriter._commitIdRemap = null;
        rewriter._sourceView = null;
        rewriter._selfKey = null;
    }

    const strandedBlobs = [...source.blobIds()].filter((b) => !referenced.has(b.representation())).length;
    return {
        commits, opcodes, referencedBlobs: referenced.size, strandedBlobs,
        unrepresentable, diagnostics: sink.report(),
    };
}

// a stable handle to verify() — run()'s `verify` flag would otherwise shadow it in-body
const _verify = verify;


// Open the source CommitDatabase read-only, build the directives against its live schema, and
// replay it into a fresh target CommitDatabase. The source is never modified. With verify:true,
// prove the rebuild is faithful before closing it. A failed run discards the half-written target.
export function run(sourcePath, buildDirectives, targetPath, { verify = false, onProgress = null } = {}) {
    const source = V.CommitDatabase.open(sourcePath, true);   // read-only
    try {
        const directives = buildDirectives(source.definitions());
        const [rewriter, targetDefs] = DefinitionsRewriter.fromDirectives(source.definitions(), directives);
        const target = V.CommitDatabase.create(targetPath);
        let ok = false;
        try {
            target.extendDefinitions(targetDefs.const());  // manages its own transaction
            const info = migrate(source, rewriter, target, onProgress);
            const summary = { commits: info.commits, blobs: info.blobs };   // operator summary
            if (verify) summary.verification = _verify(source, rewriter, target, info.remap);
            ok = true;
            return summary;
        } finally {
            target.close();
            if (!ok) removeDbFile(targetPath);             // discard the half-written target
        }
    } finally {
        source.close();
    }
}
