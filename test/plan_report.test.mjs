// Smoke test for the rewrite/ barrel: plan + report. Run: node test/_smoke2.mjs
import assert from 'node:assert/strict';
import V from '../src/dsviper.mjs';
import {
    DefinitionsRewriter, TransformationDirectives, buildTargetDefinitions, Unrepresentable,
    plan, formatPlan, DiagnosticSink, formatReport,
} from '../src/rewrite/index.mjs';

const T = V.Type;
const NS = new V.NameSpace(new V.ValueUUId('6ba7b810-9dad-11d1-80b4-00c04fd430c8'), 'Demo');
function struct(defs, name, fields) {
    const d = new V.TypeStructureDescriptor(name);
    for (const [fn, ft] of fields) d.addField(fn, ft);
    return defs.createStructure(NS, d);
}
import { it } from 'node:test';
const check = (name, fn) => it(name, fn);

check('barrel exports present', () => {
    for (const x of [DefinitionsRewriter, TransformationDirectives, buildTargetDefinitions, Unrepresentable, plan, formatPlan, DiagnosticSink, formatReport])
        assert.ok(x !== undefined);
});

check('plan classifies a narrowing retype as Class B, warns on missing policy', () => {
    const src = new V.Definitions();
    const s = struct(src, 'Q', [['q', T.INT32]]);
    const d = new TransformationDirectives();
    d.retypeField(s.representation(), 'q', T.INT16);          // no policy -> warn
    const rep = plan(src, d);
    assert.equal(rep.summary.class_b, 1);
    assert.ok(rep.warnings.some((w) => w.includes('missing policy')));
    assert.ok(formatPlan(rep).includes('Migration plan'));
});

check('plan flags a drop+add as a possible forgotten rename', () => {
    const src = new V.Definitions();
    const s = struct(src, 'C', [['a', T.INT32]]);
    const d = new TransformationDirectives();
    d.dropField(s.representation(), 'a');
    d.addField(s.representation(), 'b', V.Value.create(T.INT32, 0));
    const rep = plan(src, d);
    assert.ok(rep.warnings.some((w) => w.includes('possible forgotten rename')));
});

check('DiagnosticSink aggregates a saturate bite', () => {
    const src = new V.Definitions();
    const s = struct(src, 'Q', [['q', T.INT32]]);
    const d = new TransformationDirectives();
    d.retypeField(s.representation(), 'q', T.INT16, 'saturate');
    const [tr] = DefinitionsRewriter.fromDirectives(src, d);
    const sink = new DiagnosticSink();
    tr._sink = sink;
    tr.value(new V.ValueStructure(s, { q: 99999 }));          // offender -> saturated -> emits
    tr.value(new V.ValueStructure(s, { q: 10 }));             // in range -> no emit
    const rep = sink.report();
    assert.equal(rep.summary.findings, 1);
    assert.ok(formatReport(rep).includes('Diagnostic report'));
});

check('plan classifies a container element WIDENING as Class A (no false warning)', () => {
    const src = new V.Definitions();
    const s = struct(src, 'S', [['f', new V.TypeSet(T.INT32)]]);
    const d = new TransformationDirectives();
    d.retypeField(s.representation(), 'f', new V.TypeSet(T.INT64));   // widen, no policy — engine says A
    const rep = plan(src, d);
    const rt = rep.changes.find((c) => c.kind === 'retype_field');
    assert.equal(rt.class, 'A');
    assert.equal(rt.loss, false);
    assert.ok(!rep.warnings.some((w) => w.includes('missing policy')));
});

check('plan classifies a container element NARROWING as Class B (warns)', () => {
    const src = new V.Definitions();
    const s = struct(src, 'S', [['f', new V.TypeSet(T.INT64)]]);
    const d = new TransformationDirectives();
    d.retypeField(s.representation(), 'f', new V.TypeSet(T.INT32));   // narrow, no policy
    const rep = plan(src, d);
    const rt = rep.changes.find((c) => c.kind === 'retype_field');
    assert.equal(rt.class, 'B');
    assert.ok(rep.warnings.some((w) => w.includes('missing policy')));
});

