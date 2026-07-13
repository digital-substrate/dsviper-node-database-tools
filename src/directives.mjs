// The edit script — the source of truth for a document rewrite. A 1:1 port of the
// Python edit script: a *declarative* description of a schema change (the Django-
// migrations model), pure data — strings, target `Type`s, and default `Value`s. FQN
// arguments are qualified-name strings (`representation()`, e.g. "Shop::Customer").

export class TransformationDirectives {
    constructor() {
        this.typeRenames = {};         // src repr -> tgt repr                 (family 1)
        this.fieldRenames = {};        // src struct repr -> { src field -> tgt field }
        this.caseRenames = {};         // src enum repr  -> { src case  -> tgt case }
        this.droppedFields = {};       // src struct repr -> Set(field)         (family 2)
        this.retypedFields = {};       // src struct repr -> { src field -> [newType, policy] }
        this.addedFields = {};         // src struct repr -> [[name, defaultValue]]
        this.removedCases = {};        // src enum repr -> { case -> policy }
        this.attachmentRenames = {};   // src identifier -> new identifier
        this.addedCases = {};          // src enum repr -> [names]              (Class A, at end)
        this.caseOrder = {};           // src enum repr -> [target names in order]
        this.fieldOrder = {};          // src struct repr -> [target names in order]
        this.namespaceNames = {};      // src ns uuid repr -> new display name   (representation only)
        this.namespaceUuids = {};      // src ns uuid repr -> new ValueUUId      (runtimeId only)
        this.collisionPolicy = 'fail'; // Map key / Set element collision: 'fail' | 'first' | 'last'
    }

    // -- renames (family 1, size-preserving; no data policy) ------------------
    renameType(oldRepr, newRepr) { this.typeRenames[oldRepr] = newRepr; }

    renameField(structRepr, oldName, newName) {
        (this.fieldRenames[structRepr] ??= {})[oldName] = newName;
    }

    renameCase(enumRepr, oldName, newName) {
        (this.caseRenames[enumRepr] ??= {})[oldName] = newName;
    }

    renameAttachment(oldId, newId) { this.attachmentRenames[oldId] = newId; }

    // -- a namespace has two orthogonal axes: its NAME drives the human
    //    representation (`Namespace::Type`), its UUID drives every type's runtimeId.
    renameNamespace(oldNs, newName) {           // name -> new representations, same ids
        this.namespaceNames[oldNs.uuid().representation()] = newName;
    }

    remapNamespace(oldNs, newUuid) {            // UUID -> new runtimeIds, same representations
        this.namespaceUuids[oldNs.uuid().representation()] = newUuid;
    }

    // -- struct field shape changes (family 2) --------------------------------
    addField(structRepr, name, defaultValue) {
        (this.addedFields[structRepr] ??= []).push([name, defaultValue]);
    }

    dropField(structRepr, name) { (this.droppedFields[structRepr] ??= new Set()).add(name); }

    reorderFields(structRepr, order) { this.fieldOrder[structRepr] = [...order]; }

    retypeField(structRepr, name, newType, policy = null) {
        // policy (lossy retypes): 'fail' (default) | 'saturate' | ['default', Value]
        (this.retypedFields[structRepr] ??= {})[name] = [newType, policy];
    }

    // -- enum case shape changes (family 2) -----------------------------------
    addCase(enumRepr, name) { (this.addedCases[enumRepr] ??= []).push(name); }

    reorderCases(enumRepr, order) { this.caseOrder[enumRepr] = [...order]; }

    removeCase(enumRepr, caseName, policy) {
        // policy: 'fail' (default) | ['map-case', name] | 'drop-record'
        (this.removedCases[enumRepr] ??= {})[caseName] = policy;
    }

    // -- maps -----------------------------------------------------------------
    resolveCollisions(winner) { this.collisionPolicy = winner; }   // 'fail' | 'first' | 'last'
}
