// definitions_migrate — the DSM-source twin of the data migration. A 1:1 port of the Python
// tests/test_definitions_migrate.py.
//
// definitionsMigrate patches the `.dsm` source as a structured codemod (span-precise edits, file
// split preserved), and self-checks against the engine: re-parse the patched tree and compare its
// Definitions digest to the engine's target. The runtimeId is a structure fingerprint (field
// defaults included), so an equal digest proves the patch faithful — that comparison is the
// assertion these tests rest on (definitionsMigrate raises on mismatch).
//
// The tool needs the parser's DSMSourceMap by-product (dsviper >= 1.2.6), which is newer than the
// shipped floor. The whole suite live-probes the installed binding and skips cleanly where the
// source-map surface is absent, so it documents the contract without breaking on an older peer.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import V from '../src/dsviper.mjs';
import { TransformationDirectives } from '../src/rewrite/index.mjs';
import { definitionsMigrate } from '../src/definitions_migrate.mjs';

// True iff the installed binding exposes the parser source-map surface.
function sourceMapAvailable() {
    if (typeof V.DSMSourceMap !== 'function' || typeof V.DSMBuilder !== 'function') return false;
    try { return 'types' in new V.DSMSourceMap(); } catch { return false; }
}
const SM = sourceMapAvailable();

// A stand-in for a transformation module: any object exposing
// buildDirectives(sourceDefs) -> TransformationDirectives.
const transformation = (fn) => ({ buildDirectives: fn });

const SHOP = `namespace Shop {11111111-1111-1111-1111-111111111111} {

"""A customer of the shop."""
concept Customer;

struct Order {
    key<Customer> buyer;
    uint32 quantity = 1;
    uint16 legacy_code;
    vec<float,3> position;
    mat<float,2,2> basis;
};

};
`;

const CATALOG = `namespace Shop {11111111-1111-1111-1111-111111111111} {

"""Order lifecycle status."""
enum Status {
    pending,
    shipped,
    cancelled
};

};
`;

// a function pool declares no persistence — it sits OUTSIDE the namespace, at top level, and its
// signatures reference named types (qualified, `Shop::Order`). The engine's digest ignores it, but
// its type references must still follow a rename / namespace-rename so the patched tree resolves.
const TOOLS = `"""Order tools."""
function_pool Tools {8d5b40a5-f9a3-4d0e-83dd-90dd282d3cbe} {
  """summarise an order"""
  Shop::Order summarise(Shop::Order o);
  float total(Shop::Order o, float rate);
};
`;

function namespaceOf(sourceDefs, name) {
    for (const defn of [...sourceDefs.concepts(), ...sourceDefs.structures(), ...sourceDefs.enumerations()]) {
        const ns = defn.typeName().nameSpace();
        if (ns.name() === name) return ns;
    }
    throw new Error(`no namespace ${name}`);
}

// Build a two-file `.dsm` tree, run the codemod with verify:true (the digest oracle is the
// pass/fail), and return the patched text.
function run(files, fn) {
    const src = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-src-'));
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-out-'));
    for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(src, name), text, 'utf-8');
    definitionsMigrate(src, transformation(fn), out, { verify: true });   // raises on mismatch
    const patched = {};
    for (const name of Object.keys(files)) patched[name] = fs.readFileSync(path.join(out, name), 'utf-8');
    return patched;
}

describe('definitions_migrate', { skip: !SM && 'binding has no DSMSourceMap (parser source-map surface)' }, () => {
    // -- renames (family 1) -------------------------------------------------------------

    it('rename type patches declaration and references', () => {
        const out = run({ 'shop.dsm': SHOP, 'catalog.dsm': CATALOG }, () => {
            const d = new TransformationDirectives();
            d.renameType('Shop::Order', 'Shop::PurchaseOrder');
            return d;
        });
        assert.ok(out['shop.dsm'].includes('struct PurchaseOrder'));
        assert.ok(!out['shop.dsm'].includes('struct Order'));
    });

    it('rename field preserves its default', () => {
        const out = run({ 'shop.dsm': SHOP, 'catalog.dsm': CATALOG }, () => {
            const d = new TransformationDirectives();
            d.renameField('Shop::Order', 'quantity', 'qty');
            return d;
        });
        assert.ok(out['shop.dsm'].includes('uint32 qty = 1;'));   // the default rides the rename
    });

    it('rename case', () => {
        const out = run({ 'shop.dsm': SHOP, 'catalog.dsm': CATALOG }, () => {
            const d = new TransformationDirectives();
            d.renameCase('Shop::Status', 'cancelled', 'voided');
            return d;
        });
        assert.ok(out['catalog.dsm'].includes('voided'));
        assert.ok(!out['catalog.dsm'].includes('cancelled'));
    });

    // -- type change: retype / resize / transpose via the engine target type ------------

    it('retype widens field', () => {
        const out = run({ 'shop.dsm': SHOP, 'catalog.dsm': CATALOG }, () => {
            const d = new TransformationDirectives();
            d.retypeField('Shop::Order', 'legacy_code', V.Type.UINT32);
            return d;
        });
        assert.ok(out['shop.dsm'].includes('uint32 legacy_code;'));
    });

    it('retype drops a default authored against the old type', () => {
        // `quantity` carries `= 1`. A default is part of the runtimeId and was authored under the
        // source type, so the engine builds the retyped field bare — the patched text must follow,
        // or the two disagree and the digest (which `run` checks) refuses.
        const out = run({ 'shop.dsm': SHOP, 'catalog.dsm': CATALOG }, () => {
            const d = new TransformationDirectives();
            d.retypeField('Shop::Order', 'quantity', V.Type.UINT64);
            return d;
        });
        assert.ok(out['shop.dsm'].includes('uint64 quantity;'));
        assert.ok(!out['shop.dsm'].includes('= 1'));
    });

    it('resize vec field', () => {
        const out = run({ 'shop.dsm': SHOP, 'catalog.dsm': CATALOG }, () => {
            const d = new TransformationDirectives();
            d.resizeVecField('Shop::Order', 'position', 4);
            return d;
        });
        assert.match(out['shop.dsm'], /vec<float,\s*4>\s+position;/);
    });

    // -- add / drop (family 2) ----------------------------------------------------------

    it('add field renders default', () => {
        const out = run({ 'shop.dsm': SHOP, 'catalog.dsm': CATALOG }, () => {
            const d = new TransformationDirectives();
            d.addField('Shop::Order', 'priority', V.Value.create(V.Type.UINT8, 3));
            return d;
        });
        assert.ok(out['shop.dsm'].includes('uint8 priority = 3;'));
    });

    it('drop field leaves no dangling terminator', () => {
        const out = run({ 'shop.dsm': SHOP, 'catalog.dsm': CATALOG }, () => {
            const d = new TransformationDirectives();
            d.dropField('Shop::Order', 'legacy_code');
            return d;
        });
        assert.ok(!out['shop.dsm'].includes('legacy_code'));
        assert.ok(!out['shop.dsm'].includes('\n    ;'));          // no orphan ';'
    });

    it('add case', () => {
        const out = run({ 'shop.dsm': SHOP, 'catalog.dsm': CATALOG }, () => {
            const d = new TransformationDirectives();
            d.addCase('Shop::Status', 'returned');
            return d;
        });
        assert.ok(out['catalog.dsm'].includes('returned'));
    });

    it('remove middle case', () => {
        const out = run({ 'shop.dsm': SHOP, 'catalog.dsm': CATALOG }, () => {
            const d = new TransformationDirectives();
            d.removeCase('Shop::Status', 'shipped', 'fail');
            return d;
        });
        assert.ok(!out['catalog.dsm'].includes('shipped'));
        assert.ok(out['catalog.dsm'].includes('pending'));
        assert.ok(out['catalog.dsm'].includes('cancelled'));
    });

    // -- documentation (Class A) --------------------------------------------------------

    it('document type authors and overrides', () => {
        const out = run({ 'shop.dsm': SHOP, 'catalog.dsm': CATALOG }, () => {
            const d = new TransformationDirectives();
            d.documentType('Shop::Order', 'An order placed by a customer.');   // bare -> authored
            d.documentType('Shop::Status', 'The lifecycle state of an order.');  // override
            return d;
        });
        assert.ok(out['shop.dsm'].includes('An order placed by a customer.'));
        assert.ok(out['catalog.dsm'].includes('The lifecycle state of an order.'));
        assert.ok(!out['catalog.dsm'].includes('Order lifecycle status.'));
    });

    it('document field authors at the field indent', () => {
        const out = run({ 'shop.dsm': SHOP, 'catalog.dsm': CATALOG }, () => {
            const d = new TransformationDirectives();
            d.documentField('Shop::Order', 'quantity', 'how many');
            return d;
        });
        // the docstring sits on its own line at the field's indent, not doubled
        assert.ok(out['shop.dsm'].includes('    """how many"""\n    uint32 quantity = 1;'));
    });

    it('document case authors and overrides', () => {
        const catalog = 'namespace Shop {11111111-1111-1111-1111-111111111111} {\n\n'
            + 'enum Status {\n'
            + '    pending,\n'
            + '    """being shipped"""\n'
            + '    shipped,\n'
            + '    cancelled\n'
            + '};\n\n};\n';
        const out = run({ 'shop.dsm': SHOP, 'catalog.dsm': catalog }, () => {
            const d = new TransformationDirectives();
            d.documentCase('Shop::Status', 'pending', 'not yet shipped');     // bare -> authored
            d.documentCase('Shop::Status', 'shipped', 'handed to carrier');   // override
            return d;
        });
        assert.ok(out['catalog.dsm'].includes('    """not yet shipped"""\n    pending,'));
        assert.ok(out['catalog.dsm'].includes('handed to carrier'));
        assert.ok(!out['catalog.dsm'].includes('being shipped'));
    });

    // -- namespace: two orthogonal axes, patched across the file split ------------------

    it('rename and remap namespace across files', () => {
        const out = run({ 'shop.dsm': SHOP, 'catalog.dsm': CATALOG }, (defs) => {
            const d = new TransformationDirectives();
            const shop = namespaceOf(defs, 'Shop');
            d.renameNamespace(shop, 'Store');
            d.remapNamespace(shop, new V.ValueUUId('99999999-9999-9999-9999-999999999999'));
            return d;
        });
        for (const text of Object.values(out)) {                 // every occurrence, both files
            assert.ok(text.includes('namespace Store {99999999-9999-9999-9999-999999999999}'));
            assert.ok(!text.includes('Shop {11111111'));
        }
    });

    // -- function pools: type references in signatures follow the type edits ------------

    it('type rename propagates into pool signature', () => {
        const out = run({ 'shop.dsm': SHOP, 'catalog.dsm': CATALOG, 'tools.dsm': TOOLS }, () => {
            const d = new TransformationDirectives();
            d.renameType('Shop::Order', 'Shop::PurchaseOrder');
            return d;
        });
        // qualification preserved: Shop::Order -> Shop::PurchaseOrder inside the pool
        assert.ok(out['tools.dsm'].includes('Shop::PurchaseOrder summarise(Shop::PurchaseOrder o);'));
        assert.ok(!out['tools.dsm'].includes('Shop::Order'));
    });

    it('namespace rename propagates into qualified pool references', () => {
        const out = run({ 'shop.dsm': SHOP, 'catalog.dsm': CATALOG, 'tools.dsm': TOOLS }, (defs) => {
            const d = new TransformationDirectives();
            d.renameNamespace(namespaceOf(defs, 'Shop'), 'Store');
            return d;
        });
        assert.ok(out['tools.dsm'].includes('Store::Order summarise(Store::Order o);'));
        assert.ok(!out['tools.dsm'].includes('Shop::Order'));
    });

    // -- move_type: relocate a declaration to another namespace (n:m algebra) ------------

    it('move type split into new namespace', () => {
        const model = 'namespace N {22222222-2222-2222-2222-222222222222} {\n\n'
            + '"""A catalogued item."""\n'
            + 'struct Item { uint32 id; };\n\n'
            + 'struct Basket { Item first; };\n\n'
            + '};\n';
        const tools = 'function_pool Tools {8d5b40a5-f9a3-4d0e-83dd-90dd282d3cbe} {\n'
            + '  N::Item pick(N::Item x);\n'
            + '};\n';
        const out = run({ 'model.dsm': model, 'tools.dsm': tools }, () => {
            const d = new TransformationDirectives();
            const cat = new V.NameSpace(new V.ValueUUId('33333333-3333-3333-3333-333333333333'), 'Cat');
            d.moveType('N::Item', cat);
            return d;
        });
        // the declaration (with its docstring) now lives under a fresh namespace Cat
        assert.ok(out['model.dsm'].includes('namespace Cat {33333333-3333-3333-3333-333333333333}'));
        assert.ok(out['model.dsm'].includes('"""A catalogued item."""'));
        // every reference is fully re-qualified — the bare sibling field and the pool signature
        assert.ok(out['model.dsm'].includes('Cat::Item first;'));
        assert.ok(out['tools.dsm'].includes('Cat::Item pick(Cat::Item x);'));
    });

    it('move type merge with rename and retype', () => {
        const core = 'namespace M {44444444-4444-4444-4444-444444444444} {\n\n'
            + 'struct Anchor { uint32 tag; };\n\n'
            + '};\n';
        const model = 'namespace N {22222222-2222-2222-2222-222222222222} {\n\n'
            + '"""A catalogued item."""\n'
            + 'struct Item { uint32 id; uint16 code; };\n\n'
            + 'struct Basket { Item first; };\n\n'
            + '};\n';
        const out = run({ 'core.dsm': core, 'model.dsm': model }, (defs) => {
            const m = namespaceOf(defs, 'M');
            const d = new TransformationDirectives();
            d.moveType('N::Item', m);                          // move into an existing namespace
            d.renameType('N::Item', 'N::Widget');              // rename — baked into the carried text
            d.retypeField('N::Item', 'code', V.Type.UINT32);   // retype a field of the moved type too
            return d;
        });
        // merged INTO the live M block (not a second adjacent one), carrying its own edits
        assert.equal(out['core.dsm'].split('namespace M {').length - 1, 1);
        assert.match(out['core.dsm'], /struct Anchor[\s\S]*struct Widget \{ uint32 id; uint32 code; \}/);
        assert.ok(out['model.dsm'].includes('M::Widget first;'));   // reference: moved + renamed -> qualified
        assert.ok(!out['model.dsm'].includes('struct Item'));
    });

    it('move type merge is brace safe', () => {
        // the target block holds a docstring and a string default that both contain braces —
        // the merge must find the block's real closing brace, not one inside a literal
        const core = 'namespace M {44444444-4444-4444-4444-444444444444} {\n\n'
            + '"""tricky doc with a { and a } brace"""\n'
            + 'struct Anchor { string tag = "a } brace { here"; };\n\n'
            + '};\n';
        const model = 'namespace N {22222222-2222-2222-2222-222222222222} {\n'
            + 'struct Item { uint32 id; };\n};\n';
        const out = run({ 'core.dsm': core, 'model.dsm': model }, (defs) => {
            const d = new TransformationDirectives();
            d.moveType('N::Item', namespaceOf(defs, 'M'));
            return d;
        });
        assert.equal(out['core.dsm'].split('namespace M {').length - 1, 1);
        assert.match(out['core.dsm'], /struct Anchor[\s\S]*struct Item/);   // merged inside, in order
    });

    // -- reorder: rewrite the member region in the target order (a permutation) ----------

    it('reorder fields with rename retype and add', () => {
        const out = run({ 'shop.dsm': SHOP, 'catalog.dsm': CATALOG }, () => {
            const d = new TransformationDirectives();
            d.renameField('Shop::Order', 'quantity', 'qty');
            d.retypeField('Shop::Order', 'legacy_code', V.Type.UINT32);
            d.addField('Shop::Order', 'priority', V.Value.create(V.Type.UINT8, 5));
            d.reorderFields('Shop::Order',
                ['buyer', 'qty', 'priority', 'legacy_code', 'position', 'basis']);
            return d;
        });
        const body = out['shop.dsm'];
        // target order, each member carrying its own edit (rename keeps default, retype, add)
        const order = ['key<Customer> buyer;', 'uint32 qty = 1;', 'uint8 priority = 5;', 'uint32 legacy_code;']
            .map((m) => body.indexOf(m));
        assert.deepEqual(order, [...order].sort((a, b) => a - b));
    });

    it('reorder cases moves a documented case', () => {
        const catalog = 'namespace Shop {11111111-1111-1111-1111-111111111111} {\n\n'
            + '"""Order lifecycle status."""\n'
            + 'enum Status {\n'
            + '    pending,\n'
            + '    """being shipped"""\n'
            + '    shipped,\n'
            + '    cancelled\n'
            + '};\n\n};\n';
        const out = run({ 'shop.dsm': SHOP, 'catalog.dsm': catalog }, () => {
            const d = new TransformationDirectives();
            d.renameCase('Shop::Status', 'cancelled', 'voided');
            d.reorderCases('Shop::Status', ['voided', 'pending', 'shipped']);
            return d;
        });
        const body = out['catalog.dsm'];
        assert.ok(body.indexOf('voided') < body.indexOf('pending'));   // target order
        assert.ok(body.indexOf('pending') < body.indexOf('shipped'));
        assert.ok(body.includes('"""being shipped"""'));              // the case's doc travelled with it
    });

    // -- attachments: declarations too, so the same machinery patches them ---------------

    it('attachment operations', () => {
        const model = 'namespace N {22222222-2222-2222-2222-222222222222} {\n\n'
            + '"""A person."""\n'
            + 'concept Person;\n\n'
            + '"""orders placed"""\n'
            + 'attachment<Person, uint32> orders;\n\n'
            + 'attachment<Person, bool> flags;\n\n'
            + '};\n';

        const rename = () => {
            const d = new TransformationDirectives();
            d.renameAttachment('orders', 'purchaseOrders');    // keyed by LOCAL name
            return d;
        };
        const drop = () => {
            const d = new TransformationDirectives();
            d.dropAttachment('flags');
            d.acceptAttachmentDrops();
            return d;
        };
        const move = () => {
            const d = new TransformationDirectives();
            const cat = new V.NameSpace(new V.ValueUUId('33333333-3333-3333-3333-333333333333'), 'Cat');
            d.moveAttachment('orders', cat);
            return d;
        };

        let out = run({ 'model.dsm': model }, rename);
        assert.ok(out['model.dsm'].includes('attachment<Person, uint32> purchaseOrders;'));

        out = run({ 'model.dsm': model }, drop);
        assert.ok(!out['model.dsm'].includes('flags'));

        out = run({ 'model.dsm': model }, move);
        assert.ok(out['model.dsm'].includes('namespace Cat {33333333-3333-3333-3333-333333333333}'));
        // the moved attachment's key concept, staying in N, is re-qualified so it still resolves
        assert.ok(out['model.dsm'].includes('attachment<N::Person, uint32> orders;'));
    });

    it('attachment addressed by identifier', () => {
        // `identifier()` (`NS::KeyConcept.name`) is the attachment's identity and the key the
        // directive API names; the bare local name is the legacy form. Both reach the same
        // declaration here, because this layer mirrors the engine's lookup.
        const model = 'namespace N {22222222-2222-2222-2222-222222222222} {\n\n'
            + 'concept Person;\n\n'
            + '"""orders placed"""\n'
            + 'attachment<Person, uint32> orders;\n\n'
            + 'attachment<Person, bool> flags;\n\n'
            + '};\n';

        const out = run({ 'model.dsm': model }, () => {
            const d = new TransformationDirectives();
            d.renameAttachment('N::Person.orders', 'purchaseOrders');
            d.documentAttachment('N::Person.orders', 're-documented');
            d.dropAttachment('N::Person.flags');
            d.acceptAttachmentDrops();
            return d;
        });
        assert.ok(out['model.dsm'].includes('"""re-documented"""'));
        assert.ok(out['model.dsm'].includes('attachment<Person, uint32> purchaseOrders;'));
        assert.ok(!out['model.dsm'].includes('flags'));
    });

    it('two attachments of one namespace sharing a name', () => {
        // An attachment's key concept is part of its identity, so one namespace may hold two
        // attachments called `orders`. Only the identifier tells them apart — their declarations
        // report the same `N::orders` type name — so each directive must reach exactly one.
        const model = 'namespace N {22222222-2222-2222-2222-222222222222} {\n\n'
            + 'concept Customer;\nconcept Vendor;\n\n'
            + 'attachment<Customer, uint32> orders;\n\n'
            + 'attachment<Vendor, uint32> orders;\n\n'
            + '};\n';

        const out = run({ 'model.dsm': model }, () => {
            const d = new TransformationDirectives();
            d.renameAttachment('N::Vendor.orders', 'supplierOrders');
            d.documentAttachment('N::Customer.orders', 'placed by a customer');
            return d;
        });
        assert.ok(out['model.dsm'].includes('attachment<Customer, uint32> orders;'));
        assert.ok(out['model.dsm'].includes('attachment<Vendor, uint32> supplierOrders;'));
        assert.ok(out['model.dsm'].includes('"""placed by a customer"""'));
    });

    // -- transform_type: a global type substitution at every occurrence, nested included -------

    it('transform type primitive named and composite', () => {
        const model = 'namespace N {22222222-2222-2222-2222-222222222222} {\n\n'
            + 'struct A { uint32 x; };\n'
            + 'struct B { uint32 x; float y; };\n'
            + 'struct S {\n'
            + '    uint16 count = 3;\n'                           // primitive, with a default
            + '    map<uint16, vector<int32>> grid;\n'           // nested primitive + nested composite
            + '    A a;\n'                                       // named
            + '    vector<A> many;\n'
            + '};\n\n'
            + '};\n';
        const out = run({ 'model.dsm': model }, (defs) => {
            const a = defs.structures().find((s) => s.representation() === 'N::A');
            const b = defs.structures().find((s) => s.representation() === 'N::B');
            const d = new TransformationDirectives();
            d.transformType(V.Type.UINT16, V.Type.UINT32, (v) => v);          // primitive, everywhere
            d.transformType(new V.TypeVector(V.Type.INT32), new V.TypeSet(V.Type.INT32), (v) => v);  // composite
            d.transformType(a, b, (v) => v);                                  // named A -> B
            return d;
        });
        const body = out['model.dsm'];
        assert.ok(body.includes('uint32 count = 3;'));           // primitive incl. its default's type
        assert.ok(body.includes('map<uint32, set<int32>>'));     // nested primitive AND nested composite
        assert.ok(body.includes('N::B a;'));                     // named -> fully qualified
        assert.ok(body.includes('vector<N::B> many;'));
        assert.ok(!body.includes('struct A {'));                 // the engine drops the transformed decl
    });

    it('dropped type still named by a pool is refused up front', () => {
        // A pool declares no storage, so the engine never sees one — but a signature names types,
        // and a `dropType` can leave it naming nothing. Refused before any edit, every site
        // accumulated: both pool kinds, nested inside a container, return type and parameters.
        const model = 'namespace N {22222222-2222-2222-2222-222222222222} {\n\n'
            + 'struct Money { uint32 cents; };\n\nstruct Order { uint32 id; };\n\n};\n';
        const pools = 'function_pool Tools {8d5b40a5-f9a3-4d0e-83dd-90dd282d3cbe} {\n'
            + '  N::Money total(vector<N::Money> xs);\n'
            + '  uint32 count(N::Order o);\n};\n'
            + 'attachment_function_pool Ops {9d5b40a5-f9a3-4d0e-83dd-90dd282d3cbe} {\n'
            + '  mutable uint32 bump(map<uint32, N::Money> m);\n};\n';

        assert.throws(() => run({ 'model.dsm': model, 'pools.dsm': pools }, () => {
            const d = new TransformationDirectives();
            d.dropType('N::Money');
            return d;
        }), (err) => {
            assert.ok(err.message.includes('[dropped-type-in-pool]'));
            assert.ok(err.message.includes("Tools::total — return type"));
            assert.ok(err.message.includes("Tools::total — parameter 'xs'"));   // nested in a vector
            assert.ok(err.message.includes("Ops::bump — parameter 'm'"));       // map, other kind
            assert.ok(!err.message.includes('count'));                          // names no dropped type
            return true;
        });
    });

    it('transform type rewriting a pool signature is notified', () => {
        // Not dangling — the signature is rewritten to the new type, which is what was asked —
        // but it silently changes a pool's API, so the author is told rather than refused.
        const model = 'namespace N {22222222-2222-2222-2222-222222222222} {\n\n'
            + 'struct Money { uint32 cents; };\n\n};\n';
        const pools = 'function_pool Tools {8d5b40a5-f9a3-4d0e-83dd-90dd282d3cbe} {\n'
            + '  N::Money total(uint32 n);\n};\n';

        const src = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-src-'));
        const out = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-out-'));
        fs.writeFileSync(path.join(src, 'model.dsm'), model, 'utf-8');
        fs.writeFileSync(path.join(src, 'pools.dsm'), pools, 'utf-8');

        const notices = [];
        definitionsMigrate(src, transformation((defs) => {
            const money = defs.structures().find((s) => s.representation() === 'N::Money');
            const d = new TransformationDirectives();
            d.transformType(money, V.Type.UINT64, () => new V.ValueUInt64(0));
            return d;
        }), out, { verify: true, onNotice: (line) => notices.push(line) });

        assert.deepEqual(notices, ['[pool-signature-rewritten] Tools::total — return type : '
            + 'N::Money -> uint64']);
        assert.ok(fs.readFileSync(path.join(out, 'pools.dsm'), 'utf-8')
            .includes('uint64 total(uint32 n);'));
    });

    it('transform type reaches a type the schema does not hold', () => {
        // A composite used ONLY in a function-pool signature is in no `Definitions` (pools sit
        // outside persistence) — so it cannot be found by walking the schema. The directive keeps
        // its source type's representation next to the runtimeId, which is what makes the source
        // layer able to name it at all. The digest is blind to pools, so assert on the text.
        const model = 'namespace N {22222222-2222-2222-2222-222222222222} {\n\n'
            + 'struct Order { uint32 id; };\n\n};\n';
        const tools = 'function_pool Tools {8d5b40a5-f9a3-4d0e-83dd-90dd282d3cbe} {\n'
            + '  uint32 count(vector<uint32> xs);\n};\n';

        const out = run({ 'model.dsm': model, 'tools.dsm': tools }, () => {
            const d = new TransformationDirectives();
            d.transformType(new V.TypeVector(V.Type.UINT32), new V.TypeSet(V.Type.UINT32), (v) => v);
            return d;
        });
        assert.ok(out['tools.dsm'].includes('uint32 count(set<uint32> xs);'));
    });
});
