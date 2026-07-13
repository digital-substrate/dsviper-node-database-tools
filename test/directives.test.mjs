// Foundation: the edit script records, and dsviper's typed read path works — the
// `at(field, false)` surface the rewrite engine hammers on every node. If this fails,
// the binding's encoded=false path is the culprit, not the port.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import V from '../src/dsviper.mjs';
import { TransformationDirectives } from '../src/directives.mjs';

const NS = new V.NameSpace(new V.ValueUUId('6ba7b810-9dad-11d1-80b4-00c04fd430c8'), 'Demo');

describe('TransformationDirectives', () => {
    it('records renames, shape changes, and policies', () => {
        const d = new TransformationDirectives();
        d.renameField('Demo::Order', 'qty', 'count');
        d.retypeField('Demo::Order', 'amount', V.Type.INT64);
        d.retypeField('Demo::Order', 'small', V.Type.INT16, 'saturate');
        d.dropField('Demo::Order', 'legacy');
        assert.equal(d.fieldRenames['Demo::Order'].qty, 'count');
        assert.deepEqual(d.retypedFields['Demo::Order'].amount, [V.Type.INT64, null]);
        assert.equal(d.retypedFields['Demo::Order'].small[1], 'saturate');
        assert.ok(d.droppedFields['Demo::Order'].has('legacy'));
    });
});

describe('dsviper typed read path (encoded=false)', () => {
    it('at(field, false) returns a typed Value; at(field) natives a scalar', () => {
        const desc = new V.TypeStructureDescriptor('Order');
        desc.addField('qty', V.Type.INT32);
        desc.addField('note', V.Type.STRING);
        const order = new V.Definitions().createStructure(NS, desc);
        const doc = new V.ValueStructure(order, { qty: 42, note: 'x' });

        assert.equal(doc.at('qty'), 42);                         // default: native
        const typed = doc.at('qty', false);                      // typed Value
        assert.equal(typeof typed.typeCode, 'function');
        assert.equal(typed.typeCode(), 'int32');
        assert.equal(typed.encoded(), 42);
        assert.equal(doc.at('note', false).typeCode(), 'string');
    });
});
