// CommitDatabase migration — faithful structural replay. Port of the Python CommitDatabase migration.
// Re-issue every commit in topological order, remapping ids (old->new) and translating
// each opcode through the rewrite engine. History is preserved; because state() is a
// structural DFS linearization where the CommitId is an identity key (never an ordering
// key), migration preserves the DAG topology and commutes with evaluation, merges
// included (a Merge only seeds the linearization).

import V from './dsviper.mjs';
import { copyBlobs } from './blobs.mjs';
import { DefinitionsTransformer } from './rewrite.mjs';

// -- path remapper: rebuild a PathConst source -> target, renaming each Field and
//    transforming Key/Entry values; walk path + type in lockstep. Returns
//    [target PathConst, terminal [structRepr, field] | null].
export function translatePath(tr, sourceDocType, sourcePath) {
    let cur = sourceDocType;
    let out = new V.Path();
    let terminal = null;
    for (const comp of sourcePath.components()) {
        const kind = comp.type();
        if (kind === 'Field') {
            const fname = comp.value(true);
            const st = V.TypeStructure.cast(cur);
            const nw = (tr.d.fieldRenames[st.representation()] ?? {})[fname] ?? fname;
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

function updateValue(tr, op, tgtAtt, path, terminal) {
    const retype = terminal && (tr.d.retypedFields[terminal[0]] ?? {})[terminal[1]];
    if (retype) { const [newType, policy] = retype; return tr._retype(op.value(), newType, policy); }
    return tr.value(op.value(), path.checkType(tgtAtt.documentType()));
}

export function translateOpcode(op, am, tr, sourceDefs) {
    const args = op.arguments(sourceDefs);
    const att = args[0]; const key = args[1];
    const tgtAtt = tr.attachment(att); const tgtKey = tr.value(key);
    const kind = op.type();

    if (kind === 'Document_Set') { am.set(tgtAtt, tgtKey, tr.value(op.value())); return; }
    const [path, terminal] = translatePath(tr, att.documentType(), op.path());

    if (kind === 'Document_Update') am.update(tgtAtt, tgtKey, path, updateValue(tr, op, tgtAtt, path, terminal));
    else if (kind === 'Set_Union') am.unionInSet(tgtAtt, tgtKey, path, tr.value(op.value()));
    else if (kind === 'Set_Subtract') am.subtractInSet(tgtAtt, tgtKey, path, tr.value(op.value()));
    else if (kind === 'Map_Union') am.unionInMap(tgtAtt, tgtKey, path, tr.value(op.value()));
    else if (kind === 'Map_Update') am.updateInMap(tgtAtt, tgtKey, path, tr.value(op.value()));
    else if (kind === 'Map_Subtract') am.subtractInMap(tgtAtt, tgtKey, path, tr.value(op.value()));  // value = set of keys
    else if (kind === 'XArray_Update') am.updateInXArray(tgtAtt, tgtKey, path, op.position(), tr.value(op.value()));
    else if (kind === 'XArray_Remove') am.removeInXArray(tgtAtt, tgtKey, path, op.position());
    else throw new Error(`opcode '${kind}' not handled`);
}

function replayOpcodes(ops, am, tr, sourceDefs) {
    // insertInXArray(...value) is stored as XArray_Insert (empty position) + XArray_Update
    // (the value) -- always adjacent. Re-fuse the pair into one insert.
    let i = 0;
    while (i < ops.length) {
        const op = ops[i];
        if (op.type() === 'XArray_Insert') {
            const nxt = ops[i + 1];                          // the paired XArray_Update
            const args = op.arguments(sourceDefs);
            const att = args[0]; const key = args[1];
            const [path] = translatePath(tr, att.documentType(), op.path());
            am.insertInXArray(tr.attachment(att), tr.value(key), path,
                op.beforePosition(), op.position(), tr.value(nxt.value()));
            i += 2;
        } else {
            translateOpcode(op, am, tr, sourceDefs);
            i += 1;
        }
    }
}

export function migrateCommitDatabase(source, transformer, target) {
    const driver = source.commitDatabasing();
    const instancing = source.streamCodecInstancing();
    const targetDriver = target.commitDatabasing();
    const remap = {};

    targetDriver.beginTransaction(V.Databasing.TRANSACTION_EXCLUSIVE);
    const missing = targetDriver.unknownBlobIds([...source.blobIds()]);
    const blobs = copyBlobs(source, targetDriver, missing);         // blobs first (streamed)

    // `remap` grows in topological order, so every commit_id a value references is
    // already known; the engine remaps intra-DAG references at commit_id leaves.
    transformer._commitIdRemap = remap;
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
                replayOpcodes(cd.opcodes(instancing, source.definitions()),
                    cms.attachmentMutating(), transformer, source.definitions());
                newId = target.commitMutations(h.label(), cms);
            } else if (ctype === 'Merge' || ctype === 'Enable' || ctype === 'Disable') {
                const reissue = { Merge: 'mergeCommit', Enable: 'enableCommit', Disable: 'disableCommit' }[ctype];
                newId = target[reissue](h.label(), remap[parent.representation()],
                    remap[h.targetCommitId().representation()]);
            } else {
                throw new Error(`commit type '${ctype}' not handled`);
            }
            remap[h.commitId().representation()] = newId;
        }
        targetDriver.commit();
    } finally {
        transformer._commitIdRemap = null;
    }

    return { commits: Object.keys(remap).length, blobs, remap };
}

export function runCommitMigration(sourcePath, buildDirectives, targetPath) {
    const source = V.CommitDatabase.open(sourcePath, true);        // read-only
    try {
        const directives = buildDirectives(source.definitions());
        const [transformer, targetDefs] = DefinitionsTransformer.fromDirectives(source.definitions(), directives);
        const target = V.CommitDatabase.create(targetPath);
        try {
            target.extendDefinitions(targetDefs.const());          // manages its own transaction
            const info = migrateCommitDatabase(source, transformer, target);
            return { commits: info.commits, blobs: info.blobs };   // operator summary
        } finally {
            target.close();
        }
    } finally {
        source.close();
    }
}
