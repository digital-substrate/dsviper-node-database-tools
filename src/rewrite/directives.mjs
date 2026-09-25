// The edit script — the source of truth for a document rewrite. A 1:1 port of the
// Python edit script: a *declarative* description of a schema change (the Django-
// migrations model, not imperative code): renames, shape changes, and the policies
// that govern the lossy operations. Pure data — it holds strings, target `Type`s and
// default `Value`s, and is consumed by `DefinitionsRewriter`.
//
// FQN arguments are qualified-name strings (`representation()`, e.g. "Shop::Customer").

/** @import * as D from '@digitalsubstrate/dsviper' */
/** @import { RewriteHookContext as HookContext } from './engine.mjs' */

/**
 * A numeric fill for a Vec/Mat resize, or the `fit` pad of a Vector→Vec retype: a native
 * number/bigint, or a numeric `Value`.
 * @typedef {number | bigint | D.Value} FillScalar
 */
/**
 * The policy of a lossy field retype. `null` (none decreed) is refused at construction when
 * the retype is Class B. `'collapse'` names the `Vector→Set` retype, whose policy only gates
 * completeness (the set dedups; a later element collapse is governed by `resolveCollisions`).
 * @typedef {'fail' | 'saturate' | 'drop-record' | 'collapse' | ['default', D.Value] | ['fit', FillScalar] | null} RetypePolicy
 */
/**
 * The policy of a removed enumeration case.
 * @typedef {'fail' | 'drop-record' | ['map-case', string] | null} RemoveCasePolicy
 */
/**
 * The winner of a map key / set element collision.
 * @typedef {'fail' | 'first' | 'last'} CollisionPolicy
 */
/**
 * What a Vec/Mat resize does when it would drop cells.
 * @typedef {'fail' | 'accept'} ShrinkPolicy
 */
/**
 * A recorded Vec/Mat resize: `[kind, dims, fill, onShrink]`.
 * @typedef {['vec', [number], 'zero' | FillScalar, ShrinkPolicy]
 *   | ['mat', [number, number], 'identity' | 'zero' | FillScalar, ShrinkPolicy]} ResizeSpec
 */
/**
 * A value-scoped Class-C hook (`transformType`): `fn(sourceValue, targetType)` returns the
 * target value. A hook that declares a third parameter receives the `HookContext`.
 * @typedef {(sourceValue: D.Value, targetType: D.Type, ctx: HookContext) => D.Value} ValueHook
 */
/**
 * A struct-scoped Class-C hook (`transformField`, derived `addField`):
 * `fn(sourceStruct, fieldName, targetType)` returns the target field value. A hook that
 * declares a fourth parameter receives the `HookContext`.
 * @typedef {(sourceStruct: D.ValueStructure, fieldName: string, targetType: D.Type, ctx: HookContext) => D.Value} FieldHook
 */
/**
 * An added field: `[name, default Value, null]` (static seed) or `[name, target Type, derive]`
 * (Class-C derived field).
 * @typedef {[string, D.Value, null] | [string, D.Type, FieldHook]} AddedField
 */

export class TransformationDirectives {
    constructor() {
        /** @type {Record<string, string>} */
        this.typeRenames = Object.create(null);          // src repr -> tgt repr                 (family 1)
        /** @type {Record<string, Record<string, string>>} */
        this.fieldRenames = Object.create(null);         // src struct repr -> { src field -> tgt field }
        /** @type {Record<string, Record<string, string>>} */
        this.caseRenames = Object.create(null);          // src enum repr  -> { src case  -> tgt case }
        /** @type {Record<string, Set<string>>} */
        this.droppedFields = Object.create(null);        // src struct repr -> Set(field)         (family 2)
        /** @type {Record<string, Record<string, [D.Type, RetypePolicy]>>} */
        this.retypedFields = Object.create(null);        // src struct repr -> { src field -> [newType, policy] }
        /** @type {Record<string, AddedField[]>} */
        this.addedFields = Object.create(null);          // src struct repr -> [[name, defaultOrType, derive]]
        /** @type {Record<string, Record<string, RemoveCasePolicy>>} */
        this.removedCases = Object.create(null);         // src enum repr -> { case -> policy }
        /** @type {Record<string, string>} */
        this.attachmentRenames = Object.create(null);    // src identifier -> new identifier
        /** @type {Record<string, string[]>} */
        this.addedCases = Object.create(null);           // src enum repr -> [names]              (Class A, at end)
        /** @type {Record<string, string[]>} */
        this.caseOrder = Object.create(null);            // src enum repr -> [target names in order]
        /** @type {Record<string, string[]>} */
        this.fieldOrder = Object.create(null);           // src struct repr -> [target names in order]
        /** @type {Record<string, string>} */
        this.namespaceNames = Object.create(null);       // src ns uuid repr -> new display name   (representation only)
        /** @type {Record<string, D.ValueUUId>} */
        this.namespaceUuids = Object.create(null);       // src ns uuid repr -> new ValueUUId      (runtimeId only)
        /** @type {Record<string, D.NameSpace>} */
        this.typeNamespaces = Object.create(null);       // type repr -> target NameSpace   (per-definition move; split/merge)
        /** @type {Record<string, D.NameSpace>} */
        this.attachmentNamespaces = Object.create(null); // attachment identifier -> target NameSpace
        /** @type {CollisionPolicy} */
        this.collisionPolicy = 'fail';  // Map key collision: 'fail' | 'first' | 'last'
        this.documentDropsAccepted = false;   // explicit sign-off that drop-record may DELETE documents
        /** @type {Record<string, Record<string, ResizeSpec>>} */
        this.resizedFields = Object.create(null);        // src struct repr -> { field -> [kind, dims, fill, onShrink] }
        /** @type {Record<string, Set<string>>} */
        this.transposedFields = Object.create(null);     // src struct repr -> Set(field)   (Mat<c,r> -> Mat<r,c>)
        /** @type {Record<string, Record<string, [D.Type, FieldHook]>>} */
        this.transformedFields = Object.create(null);    // src struct repr -> { field -> [newType, fn] }  (Class-C hook)
        /** @type {Record<string, [D.Type, ValueHook]>} */
        this.transformedTypes = Object.create(null);     // src type runtimeId repr -> [newType, fn]  (global Class-C hook)
        /** @type {Record<string, string>} */
        this.transformedTypeNames = Object.create(null); // ... -> the source type's representation, kept alongside:
                                        // a runtimeId is a fingerprint, so a name-based consumer (a
                                        // source codemod) could otherwise only recover the name by
                                        // walking the schema — and would miss a type the schema does
                                        // not reach (a composite used only in a pool signature).
        // documentation authoring (Class A — doc is outside the runtimeId; overrides the
        // source doc the build carries by default). Members named by SOURCE name.
        /** @type {Record<string, string>} */
        this.typeDocs = Object.create(null);             // type repr (struct/enum/concept/club) -> text
        /** @type {Record<string, Record<string, string>>} */
        this.fieldDocs = Object.create(null);            // src struct repr -> { src field -> text }
        /** @type {Record<string, Record<string, string>>} */
        this.caseDocs = Object.create(null);             // src enum repr  -> { src case  -> text }
        /** @type {Record<string, string>} */
        this.attachmentDocs = Object.create(null);       // src attachment identifier -> text
        // definition-level drops (the co-direction of the additive build)
        /** @type {Set<string>} */
        this.droppedTypes = new Set();  // type repr (struct/enum/concept/club) to NOT recreate
        /** @type {Set<string>} */
        this.droppedAttachments = new Set();   // attachment identifier to NOT recreate (+ delete its docs)
        this.attachmentDropsAccepted = false;  // sign-off that dropAttachment may DELETE documents
    }

    // -- renames (family 1, size-preserving; no data policy) ------------------
    /**
     * @param {string} oldRepr the source type's qualified name
     * @param {string} newRepr the target qualified name
     */
    renameType(oldRepr, newRepr) { this.typeRenames[oldRepr] = newRepr; }

    /**
     * @param {string} structRepr
     * @param {string} oldName
     * @param {string} newName
     */
    renameField(structRepr, oldName, newName) {
        (this.fieldRenames[structRepr] ??= Object.create(null))[oldName] = newName;
    }

    /**
     * @param {string} enumRepr
     * @param {string} oldName
     * @param {string} newName
     */
    renameCase(enumRepr, oldName, newName) {
        (this.caseRenames[enumRepr] ??= Object.create(null))[oldName] = newName;
    }

    /**
     * @param {string} oldId the source attachment identifier (`NS::Concept.name`)
     * @param {string} newId the new identifier (or bare name)
     */
    renameAttachment(oldId, newId) { this.attachmentRenames[oldId] = newId; }   // named Map<Key,Doc>

    // -- a namespace has two orthogonal axes: its NAME drives the human
    //    representation (`Namespace::Type`), its UUID drives every type's runtimeId.
    //    `renameNamespace`/`remapNamespace` act on a WHOLE namespace (all its definitions,
    //    uniformly); `moveType`/`moveAttachment` reassign a SINGLE definition's namespace —
    //    together they express the n:m namespace algebra (split = move some out; merge = map/move
    //    into a shared namespace). A definition's namespace is part of its runtimeId, so a move
    //    is a lossless re-id (Class A, like a rename); references follow via the mapping.
    /**
     * @param {D.NameSpace} oldNs the source namespace
     * @param {string} newName its new display name
     */
    renameNamespace(oldNs, newName) {           // name -> new representations, same ids
        this.namespaceNames[oldNs.uuid().representation()] = newName;
    }

    /**
     * @param {D.NameSpace} oldNs the source namespace
     * @param {D.ValueUUId} newUuid its new UUID
     */
    remapNamespace(oldNs, newUuid) {            // UUID -> new runtimeIds, same representations
        this.namespaceUuids[oldNs.uuid().representation()] = newUuid;
    }

    /**
     * @param {string} typeRepr
     * @param {D.NameSpace} targetNs
     */
    moveType(typeRepr, targetNs) {              // struct/enum/concept/club -> target NameSpace
        this.typeNamespaces[typeRepr] = targetNs;
    }

    /**
     * @param {string} identifier
     * @param {D.NameSpace} targetNs
     */
    moveAttachment(identifier, targetNs) {
        this.attachmentNamespaces[identifier] = targetNs;
    }

    // -- struct field shape changes (family 2) --------------------------------
    /**
     * @overload
     * @param {string} structRepr
     * @param {string} name
     * @param {D.Value} defaultOrType the static default (domain-free)
     * @param {null} [derive]
     * @returns {void}
     */
    /**
     * @overload
     * @param {string} structRepr
     * @param {string} name
     * @param {D.Type} defaultOrType the target type of a derived field
     * @param {FieldHook} derive computes the field from the source struct
     * @returns {void}
     */
    /**
     * @param {string} structRepr
     * @param {string} name
     * @param {D.Value | D.Type} defaultOrType
     * @param {FieldHook | null} [derive]
     */
    addField(structRepr, name, defaultOrType, derive = null) {
        // `derive` null: `defaultOrType` is a Value — a static default (domain-free).
        // `derive` given: `defaultOrType` is the target Type, and the field is a Class-C
        // DERIVED field — `derive(sourceStruct, fieldName, targetType) -> value` computes it
        // from the source struct (its siblings). Same contract/validation as `transformField`.
        (this.addedFields[structRepr] ??= []).push(/** @type {AddedField} */ ([name, defaultOrType, derive]));
    }

    /**
     * @param {string} structRepr
     * @param {string} name
     */
    dropField(structRepr, name) { (this.droppedFields[structRepr] ??= new Set()).add(name); }

    // -- definition-level drops (the co-direction of the additive build) ------
    //    A key is a concept-instance identity, not a foreign key, and nothing references an
    //    attachment — so dropping an attachment dangles nothing (only mass-deletes its docs,
    //    hence the acknowledgement gate). Dropping a TYPE can dangle a surviving reference; the
    //    build refuses that up front with an accumulated report (never a silently broken target).
    /** @param {string} typeRepr */
    dropType(typeRepr) { this.droppedTypes.add(typeRepr); }   // struct/enum/concept/club by FQN

    /** @param {string} identifier */
    dropAttachment(identifier) { this.droppedAttachments.add(identifier); }

    acceptAttachmentDrops() {
        // Acknowledge that this migration may DELETE whole attachments — every document of a
        // dropped attachment is gone. A deliberate, separate act (like `acceptDocumentDrops` for
        // drop-record), not an implicit consequence. Enforced by the `Database` migrate loop;
        // `dryRun` informs without it (identify -> inform -> acknowledge -> decide).
        this.attachmentDropsAccepted = true;
    }

    /**
     * @param {string} structRepr
     * @param {Iterable<string>} order the TARGET field names, in order
     */
    reorderFields(structRepr, order) { this.fieldOrder[structRepr] = [...order]; }

    /**
     * @param {string} structRepr
     * @param {string} name
     * @param {D.Type} newType the target type (in the source domain)
     * @param {RetypePolicy} [policy]
     */
    retypeField(structRepr, name, newType, policy = null) {
        // policy (lossy retypes): 'fail' (default) | 'saturate' | ['default', Value]
        (this.retypedFields[structRepr] ??= Object.create(null))[name] = [newType, policy];
    }

    // -- Vec/Mat DIMENSION changes (family 2). Named explicitly, never inferred from the
    //    target type — a target Mat<3,2> cannot say resize vs transpose vs (ambiguous)
    //    reshape. The target type is DERIVED (the element type T is read from the source);
    //    the field must be a *direct* Vec/Mat. Position-preserving (`[i]->[i]`, `[i,j]->[i,j]`):
    //    grow fills the new cells, shrink drops the trailing ones.
    /**
     * @param {string} structRepr
     * @param {string} field
     * @param {number} size
     * @param {{ fill?: 'zero' | FillScalar, onShrink?: ShrinkPolicy }} [options]
     */
    resizeVecField(structRepr, field, size, { fill = 'zero', onShrink = 'fail' } = {}) {
        // fill: 'zero' (born-default) | a numeric scalar. onShrink: 'fail' | 'accept'.
        (this.resizedFields[structRepr] ??= Object.create(null))[field] = ['vec', [size], fill, onShrink];
    }

    /**
     * @param {string} structRepr
     * @param {string} field
     * @param {number} columns
     * @param {number} rows
     * @param {{ fill?: 'identity' | 'zero' | FillScalar, onShrink?: ShrinkPolicy }} [options]
     */
    resizeMatField(structRepr, field, columns, rows, { fill = 'identity', onShrink = 'fail' } = {}) {
        // fill: 'identity' (born-default: extend the diagonal with 1) | 'zero' | a numeric
        //       scalar. onShrink: 'fail' | 'accept' (accept the dropped rows/columns).
        (this.resizedFields[structRepr] ??= Object.create(null))[field] = ['mat', [columns, rows], fill, onShrink];
    }

    /**
     * @param {string} structRepr
     * @param {string} field
     */
    transposeMatField(structRepr, field) {
        // Mat<c,r> -> Mat<r,c>, [i,j] -> [j,i]. Lossless; the target shape is derived.
        (this.transposedFields[structRepr] ??= new Set()).add(field);
    }

    // -- Class-C custom transform (a user hook) -------------------------------
    /**
     * @param {string} structRepr
     * @param {string} field
     * @param {D.Type} newType the target type (in the source domain)
     * @param {FieldHook} fn
     */
    transformField(structRepr, field, newType, fn) {
        // The escape hatch for a change no declarative directive expresses (e.g. a field
        // retyped to an UNRELATED type). `newType` names the target type (in the source
        // domain — the engine maps it); `fn(sourceValue, targetType) -> targetValue` is the
        // author's transform. It owns its loss model: it returns a valid target value (the
        // engine validates it), throws `Unrepresentable` to drop the record, or throws to
        // refuse. The engine refuses anything the hook does not produce as a valid target value.
        (this.transformedFields[structRepr] ??= Object.create(null))[field] = [newType, fn];
    }

    /**
     * @param {D.Type} sourceType
     * @param {D.Type} newType the target type (in the source domain)
     * @param {ValueHook} fn
     */
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
    /**
     * @param {string} enumRepr
     * @param {string} name
     */
    addCase(enumRepr, name) { (this.addedCases[enumRepr] ??= []).push(name); }   // Class A — at end

    /**
     * @param {string} enumRepr
     * @param {Iterable<string>} order the TARGET case names, in order
     */
    reorderCases(enumRepr, order) { this.caseOrder[enumRepr] = [...order]; }

    /**
     * @param {string} enumRepr
     * @param {string} caseName
     * @param {RemoveCasePolicy} policy
     */
    removeCase(enumRepr, caseName, policy) {
        // policy: 'fail' (default) | ['map-case', name] | 'drop-record'
        (this.removedCases[enumRepr] ??= Object.create(null))[caseName] = policy;
    }

    // -- documentation authoring (Class A; overrides the carried source doc) ---
    //    Documentation is metadata OUTSIDE the runtimeId (a doc change never re-ids/re-keys),
    //    so this is lossless authoring, no policy. The build carries the source doc by default;
    //    these set/override it. Members named by SOURCE name (as renames do); `text=""` clears.
    /**
     * @param {string} typeRepr
     * @param {string} text
     */
    documentType(typeRepr, text) { this.typeDocs[typeRepr] = text; }   // struct/enum/concept/club

    /**
     * @param {string} structRepr
     * @param {string} field
     * @param {string} text
     */
    documentField(structRepr, field, text) { (this.fieldDocs[structRepr] ??= Object.create(null))[field] = text; }

    /**
     * @param {string} enumRepr
     * @param {string} caseName
     * @param {string} text
     */
    documentCase(enumRepr, caseName, text) { (this.caseDocs[enumRepr] ??= Object.create(null))[caseName] = text; }

    /**
     * @param {string} attachmentId
     * @param {string} text
     */
    documentAttachment(attachmentId, text) { this.attachmentDocs[attachmentId] = text; }

    // -- maps -----------------------------------------------------------------
    /** @param {CollisionPolicy} winner */
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
    /** @returns {string[]} */
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
