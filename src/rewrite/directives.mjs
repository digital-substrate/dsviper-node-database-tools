// The edit script — the source of truth for a document rewrite. A 1:1 port of the
// Python edit script: a *declarative* description of a schema change (the Django-
// migrations model, not imperative code): renames, shape changes, and the policies
// that govern the lossy operations. Pure data — it holds strings, target `Type`s and
// default `Value`s, and is consumed by `DefinitionsRewriter`.
//
// FQN arguments are qualified-name strings (`representation()`, e.g. "Shop::Customer").

export class TransformationDirectives {
    constructor() {
        this.typeRenames = Object.create(null);          // src repr -> tgt repr                 (family 1)
        this.fieldRenames = Object.create(null);         // src struct repr -> { src field -> tgt field }
        this.caseRenames = Object.create(null);          // src enum repr  -> { src case  -> tgt case }
        this.droppedFields = Object.create(null);        // src struct repr -> Set(field)         (family 2)
        this.retypedFields = Object.create(null);        // src struct repr -> { src field -> [newType, policy] }
        this.addedFields = Object.create(null);          // src struct repr -> [[name, defaultOrType, derive]]
        this.removedCases = Object.create(null);         // src enum repr -> { case -> policy }
        this.attachmentRenames = Object.create(null);    // src identifier -> new identifier
        this.addedCases = Object.create(null);           // src enum repr -> [names]              (Class A, at end)
        this.caseOrder = Object.create(null);            // src enum repr -> [target names in order]
        this.fieldOrder = Object.create(null);           // src struct repr -> [target names in order]
        this.namespaceNames = Object.create(null);       // src ns uuid repr -> new display name   (representation only)
        this.namespaceUuids = Object.create(null);       // src ns uuid repr -> new ValueUUId      (runtimeId only)
        this.typeNamespaces = Object.create(null);       // type repr -> target NameSpace   (per-definition move; split/merge)
        this.attachmentNamespaces = Object.create(null); // attachment identifier -> target NameSpace
        this.collisionPolicy = 'fail';  // Map key collision: 'fail' | 'first' | 'last'
        this.documentDropsAccepted = false;   // explicit sign-off that drop-record may DELETE documents
        this.resizedFields = Object.create(null);        // src struct repr -> { field -> [kind, dims, fill, onShrink] }
        this.transposedFields = Object.create(null);     // src struct repr -> Set(field)   (Mat<c,r> -> Mat<r,c>)
        this.transformedFields = Object.create(null);    // src struct repr -> { field -> [newType, fn] }  (Class-C hook)
        this.transformedTypes = Object.create(null);     // src type runtimeId repr -> [newType, fn]  (global Class-C hook)
        this.transformedTypeNames = Object.create(null); // ... -> the source type's representation, kept alongside:
                                        // a runtimeId is a fingerprint, so a name-based consumer (a
                                        // source codemod) could otherwise only recover the name by
                                        // walking the schema — and would miss a type the schema does
                                        // not reach (a composite used only in a pool signature).
        // documentation authoring (Class A — doc is outside the runtimeId; overrides the
        // source doc the build carries by default). Members named by SOURCE name.
        this.typeDocs = Object.create(null);             // type repr (struct/enum/concept/club) -> text
        this.fieldDocs = Object.create(null);            // src struct repr -> { src field -> text }
        this.caseDocs = Object.create(null);             // src enum repr  -> { src case  -> text }
        this.attachmentDocs = Object.create(null);       // src attachment identifier -> text
        // definition-level drops (the co-direction of the additive build)
        this.droppedTypes = new Set();  // type repr (struct/enum/concept/club) to NOT recreate
        this.droppedAttachments = new Set();   // attachment identifier to NOT recreate (+ delete its docs)
        this.attachmentDropsAccepted = false;  // sign-off that dropAttachment may DELETE documents
    }

    // -- renames (family 1, size-preserving; no data policy) ------------------
    renameType(oldRepr, newRepr) { this.typeRenames[oldRepr] = newRepr; }

    renameField(structRepr, oldName, newName) {
        (this.fieldRenames[structRepr] ??= Object.create(null))[oldName] = newName;
    }

    renameCase(enumRepr, oldName, newName) {
        (this.caseRenames[enumRepr] ??= Object.create(null))[oldName] = newName;
    }

    renameAttachment(oldId, newId) { this.attachmentRenames[oldId] = newId; }   // named Map<Key,Doc>

    // -- a namespace has two orthogonal axes: its NAME drives the human
    //    representation (`Namespace::Type`), its UUID drives every type's runtimeId.
    //    `renameNamespace`/`remapNamespace` act on a WHOLE namespace (all its definitions,
    //    uniformly); `moveType`/`moveAttachment` reassign a SINGLE definition's namespace —
    //    together they express the n:m namespace algebra (split = move some out; merge = map/move
    //    into a shared namespace). A definition's namespace is part of its runtimeId, so a move
    //    is a lossless re-id (Class A, like a rename); references follow via the mapping.
    renameNamespace(oldNs, newName) {           // name -> new representations, same ids
        this.namespaceNames[oldNs.uuid().representation()] = newName;
    }

    remapNamespace(oldNs, newUuid) {            // UUID -> new runtimeIds, same representations
        this.namespaceUuids[oldNs.uuid().representation()] = newUuid;
    }

    moveType(typeRepr, targetNs) {              // struct/enum/concept/club -> target NameSpace
        this.typeNamespaces[typeRepr] = targetNs;
    }

    moveAttachment(identifier, targetNs) {
        this.attachmentNamespaces[identifier] = targetNs;
    }

    // -- struct field shape changes (family 2) --------------------------------
    addField(structRepr, name, defaultOrType, derive = null) {
        // `derive` null: `defaultOrType` is a Value — a static default (domain-free).
        // `derive` given: `defaultOrType` is the target Type, and the field is a Class-C
        // DERIVED field — `derive(sourceStruct, fieldName, targetType) -> value` computes it
        // from the source struct (its siblings). Same contract/validation as `transformField`.
        (this.addedFields[structRepr] ??= []).push([name, defaultOrType, derive]);
    }

    dropField(structRepr, name) { (this.droppedFields[structRepr] ??= new Set()).add(name); }

    // -- definition-level drops (the co-direction of the additive build) ------
    //    A key is a concept-instance identity, not a foreign key, and nothing references an
    //    attachment — so dropping an attachment dangles nothing (only mass-deletes its docs,
    //    hence the acknowledgement gate). Dropping a TYPE can dangle a surviving reference; the
    //    build refuses that up front with an accumulated report (never a silently broken target).
    dropType(typeRepr) { this.droppedTypes.add(typeRepr); }   // struct/enum/concept/club by FQN

    dropAttachment(identifier) { this.droppedAttachments.add(identifier); }

    acceptAttachmentDrops() {
        // Acknowledge that this migration may DELETE whole attachments — every document of a
        // dropped attachment is gone. A deliberate, separate act (like `acceptDocumentDrops` for
        // drop-record), not an implicit consequence. Enforced by the `Database` migrate loop;
        // `dryRun` informs without it (identify -> inform -> acknowledge -> decide).
        this.attachmentDropsAccepted = true;
    }

    reorderFields(structRepr, order) { this.fieldOrder[structRepr] = [...order]; }

    retypeField(structRepr, name, newType, policy = null) {
        // policy (lossy retypes): 'fail' (default) | 'saturate' | ['default', Value]
        (this.retypedFields[structRepr] ??= Object.create(null))[name] = [newType, policy];
    }

    // -- Vec/Mat DIMENSION changes (family 2). Named explicitly, never inferred from the
    //    target type — a target Mat<3,2> cannot say resize vs transpose vs (ambiguous)
    //    reshape. The target type is DERIVED (the element type T is read from the source);
    //    the field must be a *direct* Vec/Mat. Position-preserving (`[i]->[i]`, `[i,j]->[i,j]`):
    //    grow fills the new cells, shrink drops the trailing ones.
    resizeVecField(structRepr, field, size, { fill = 'zero', onShrink = 'fail' } = {}) {
        // fill: 'zero' (born-default) | a numeric scalar. onShrink: 'fail' | 'accept'.
        (this.resizedFields[structRepr] ??= Object.create(null))[field] = ['vec', [size], fill, onShrink];
    }

    resizeMatField(structRepr, field, columns, rows, { fill = 'identity', onShrink = 'fail' } = {}) {
        // fill: 'identity' (born-default: extend the diagonal with 1) | 'zero' | a numeric
        //       scalar. onShrink: 'fail' | 'accept' (accept the dropped rows/columns).
        (this.resizedFields[structRepr] ??= Object.create(null))[field] = ['mat', [columns, rows], fill, onShrink];
    }

    transposeMatField(structRepr, field) {
        // Mat<c,r> -> Mat<r,c>, [i,j] -> [j,i]. Lossless; the target shape is derived.
        (this.transposedFields[structRepr] ??= new Set()).add(field);
    }

    // -- Class-C custom transform (a user hook) -------------------------------
    transformField(structRepr, field, newType, fn) {
        // The escape hatch for a change no declarative directive expresses (e.g. a field
        // retyped to an UNRELATED type). `newType` names the target type (in the source
        // domain — the engine maps it); `fn(sourceValue, targetType) -> targetValue` is the
        // author's transform. It owns its loss model: it returns a valid target value (the
        // engine validates it), throws `Unrepresentable` to drop the record, or throws to
        // refuse. The engine refuses anything the hook does not produce as a valid target value.
        (this.transformedFields[structRepr] ??= Object.create(null))[field] = [newType, fn];
    }

    transformType(sourceType, newType, fn) {
        // The GLOBAL hook: transform EVERY occurrence of `sourceType` (wherever it appears —
        // a field, a container element, a variant arm, nested) to `newType`, in one directive.
        // Rides the target-directed recursion (the walk visits every node). A field-level
        // `transformField` on the same position OVERRIDES this (resolution: field > type).
        // Same contract as `transformField`: `fn(sourceValue, targetType) -> targetValue`.
        const rid = sourceType.runtimeId().representation();
        this.transformedTypes[rid] = [newType, fn];
        this.transformedTypeNames[rid] = sourceType.representation();
    }

    // -- enum case shape changes (family 2) -----------------------------------
    addCase(enumRepr, name) { (this.addedCases[enumRepr] ??= []).push(name); }   // Class A — at end

    reorderCases(enumRepr, order) { this.caseOrder[enumRepr] = [...order]; }

    removeCase(enumRepr, caseName, policy) {
        // policy: 'fail' (default) | ['map-case', name] | 'drop-record'
        (this.removedCases[enumRepr] ??= Object.create(null))[caseName] = policy;
    }

    // -- documentation authoring (Class A; overrides the carried source doc) ---
    //    Documentation is metadata OUTSIDE the runtimeId (a doc change never re-ids/re-keys),
    //    so this is lossless authoring, no policy. The build carries the source doc by default;
    //    these set/override it. Members named by SOURCE name (as renames do); `text=""` clears.
    documentType(typeRepr, text) { this.typeDocs[typeRepr] = text; }   // struct/enum/concept/club

    documentField(structRepr, field, text) { (this.fieldDocs[structRepr] ??= Object.create(null))[field] = text; }

    documentCase(enumRepr, caseName, text) { (this.caseDocs[enumRepr] ??= Object.create(null))[caseName] = text; }

    documentAttachment(attachmentId, text) { this.attachmentDocs[attachmentId] = text; }

    // -- maps -----------------------------------------------------------------
    resolveCollisions(winner) { this.collisionPolicy = winner; }   // 'fail' | 'first' | 'last'

    // -- explicit sign-off for record-scoped loss -----------------------------
    acceptDocumentDrops() {
        // Acknowledge that this migration may DELETE whole documents. Every `drop-record` policy
        // is *record-scoped*: when a value has no target image it elides the enclosing document,
        // rather than losing a bounded field (the value-closed policies `saturate` /
        // `['default', v]` / `['map-case', n]`). Because that consequence is categorically
        // graver, a `Database` migration REFUSES any `drop-record` until this explicit act.
        //
        // Run `migrateDatabase.dryRun` first: it deliberately does NOT require this
        // acknowledgement, so it can show exactly how many / which documents would be dropped.
        // (A `CommitDatabase` migration refuses `drop-record` outright, regardless of this flag.)
        this.documentDropsAccepted = true;
    }

    // -- introspection --------------------------------------------------------
    dropRecordSites() {
        // Every target (`Struct.field` retype, `Enum::case` removal) that decrees a `drop-record`
        // policy. `drop-record` is record-scoped — it elides the enclosing document — so a
        // consumer with no document to drop (a `CommitDatabase` migration) refuses it up front.
        const sites = [];
        for (const [s, fields] of Object.entries(this.retypedFields))
            for (const [f, [, p]] of Object.entries(fields))
                if (p === 'drop-record') sites.push(`${s}.${f}`);
        for (const [e, cases] of Object.entries(this.removedCases))
            for (const [c, p] of Object.entries(cases))
                if (p === 'drop-record') sites.push(`${e}::${c}`);
        return sites;
    }
}
