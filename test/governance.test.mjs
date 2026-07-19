// database-tools inherits Viper's DSM governance and fails closed — a port of the Python
// tests/test_governance.py.
//
// The engine builds the target Definitions through the binding's construction gates
// (createStructure / addField / addCase / TypeStructureDescriptor(name, documentation)), so a
// directive that would mint a non-DSM-expressible identifier or docstring is refused there,
// reached through our build — never a silent bad name (total-or-explicit-refusal). These tests pin
// that boundary as database-tools' own contract.
//
// Governance is a property of the binding, and its two halves shipped at different times (the
// identifier policy is in the published floor; the docstring rule shipped later). Each "refused"
// test is guarded by a live probe of the installed binding and skips cleanly where the rule is
// absent — so the suite documents the contract without breaking on an older peer.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import V from '../src/dsviper.mjs';
import { TransformationDirectives, DefinitionsRewriter } from '../src/rewrite/index.mjs';

const T = V.Type;
const NS = new V.NameSpace(new V.ValueUUId('6ba7b810-9dad-11d1-80b4-00c04fd430c8'), 'Demo');

function srcOrder() {                                          // Demo::Order { amount: int32 }
    const d = new V.TypeStructureDescriptor('Order');
    d.addField('amount', T.INT32);
    const defs = new V.Definitions();
    defs.createStructure(NS, d);
    return defs;
}

function identifierGovernanceActive() {                        // 'set' is Viper-reserved
    try { const d = new V.TypeStructureDescriptor('Probe'); d.addField('set', T.INT32); return false; }
    catch { return true; }
}
function docstringGovernanceActive() {                         // a docstring may not contain """
    try { new V.TypeStructureDescriptor('Probe', 'a"""b'); return false; }
    catch { return true; }
}

const ID_GOV = identifierGovernanceActive();
const DOC_GOV = docstringGovernanceActive();

const renameTo = (name) => {
    const d = new TransformationDirectives();
    d.renameField('Demo::Order', 'amount', name);
    DefinitionsRewriter.fromDirectives(srcOrder(), d);
};

describe('identifier governance fails closed', () => {
    it('a valid rename is accepted', () => {
        renameTo('total');                                     // a plain identifier: no throw
    });
    it('a reserved word is refused', { skip: !ID_GOV && 'identifier governance absent' }, () => {
        for (const bad of ['set', 'type', 'class']) assert.throws(() => renameTo(bad));
    });
    it('a DSM keyword is refused', { skip: !ID_GOV && 'identifier governance absent' }, () => {
        for (const bad of ['struct', 'enum', 'namespace']) assert.throws(() => renameTo(bad));
    });
    it('a non-identifier shape is refused', { skip: !ID_GOV && 'identifier governance absent' }, () => {
        for (const bad of ['bad name', '2nd', 'with-dash', '']) assert.throws(() => renameTo(bad));
    });
});

describe('docstring governance fails closed', () => {
    const documentTo = (doc) => {
        const d = new TransformationDirectives();
        d.documentField('Demo::Order', 'amount', doc);
        DefinitionsRewriter.fromDirectives(srcOrder(), d);
    };
    it('a plain docstring is accepted', () => {
        documentTo('the amount, in cents; C:\\path and "quotes" are fine');   // no throw
    });
    it('a """-bearing docstring is refused', { skip: !DOC_GOV && 'docstring governance absent (pre-1.2.6)' }, () => {
        assert.throws(() => documentTo('a bad """ docstring'));
    });
});
