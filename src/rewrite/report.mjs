// The dynamic diagnostic report — what a migration would actually do to the DATA. A 1:1 port.
//
// The static `plan` reads the schema alone and says which sites COULD lose information. This
// report reads the values: it aggregates the findings the engine emits each time a Class-B
// policy actually BITES — a narrowing saturated, a fraction truncated, a nil/removed-case
// elided, a set/map member collapsed — into per-site counts and a bounded sample of
// before → after pairs.
//
// `DiagnosticSink` is that aggregator: a CALLABLE the engine notifies (one finding per bite; see
// `DefinitionsRewriter._emit`). It owns the aggregation and the sample cap. Wire it over any
// value stream — `migrateDatabase.dryRun` runs it over a whole `Database`, but because
// `rewriter.value` is per-value and pure the same sink works over a single value.

/** @import * as D from '@digitalsubstrate/dsviper' */
/** @import { RetypePolicy, RemoveCasePolicy } from './directives.mjs' */

/**
 * The policy that governed a finding: a decreed retype / remove-case policy, or a label (a
 * collision winner, an `onShrink`, a hook's name).
 * @typedef {RetypePolicy | RemoveCasePolicy | string} FindingPolicy
 */
/**
 * One bite of a Class-B policy, as the engine emits it. `before` / `after` are rendered
 * samples; `after` is null when the value was dropped/elided.
 * @typedef {object} Finding
 * @property {string | null} site the diagnostic site path (e.g. `Shop::Order.qty`)
 * @property {string} op the operation that lost information
 * @property {FindingPolicy} policy
 * @property {string | null} before
 * @property {string | null} after
 */
/**
 * The aggregate of one (site, op) group.
 * @typedef {object} SiteRecord
 * @property {string | null} site
 * @property {string} op
 * @property {FindingPolicy} policy
 * @property {number} count the exact number of findings
 * @property {number} dropped the findings that elided the value
 * @property {[string | null, string | null][]} samples bounded [before, after] pairs
 */
/**
 * What `DiagnosticSink.report()` returns: plain serialisable data.
 * @typedef {object} DiagnosticReport
 * @property {SiteRecord[]} sites
 * @property {{ findings: number, sites: number, dropped: number }} summary
 */
/**
 * The callable sink: call it with a finding; `.report()` aggregates.
 * @typedef {((finding: Finding) => void) & { report: () => DiagnosticReport }} DiagnosticSinkFn
 */

// A callable sink with a `.report()` method. Usable as `new DiagnosticSink(5)` or
// `DiagnosticSink(5)` — the factory returns the callable, so `new` yields it too. `maxSamples`
// bounds the before→after pairs kept per (site, op) group (the counts stay exact regardless).
/**
 * @param {number} [maxSamples] the before→after pairs kept per (site, op) group
 * @returns {DiagnosticSinkFn}
 */
function diagnosticSink(maxSamples = 5) {
    /** @type {Map<string, SiteRecord>} */
    const groups = new Map();          // "site\u0000op" -> record; insertion order preserved

    /** @param {Finding} finding */
    const sink = (finding) => {
        const key = `${finding.site}\u0000${finding.op}`;
        let rec = groups.get(key);
        if (rec === undefined) {
            rec = { site: finding.site, op: finding.op, policy: finding.policy, count: 0, dropped: 0, samples: [] };
            groups.set(key, rec);
        }
        rec.count += 1;
        if (finding.after === null || finding.after === undefined) rec.dropped += 1;   // elided value: count it here,
        if (rec.samples.length < maxSamples) rec.samples.push([finding.before, finding.after]);   // not from the bounded samples
    };

    // The aggregate, as plain serialisable data: { sites: [...], summary: {...} }. Each site
    // record is { site, op, policy, count, dropped, samples }; `samples` is a list of [before,
    // after] pairs (`after` is null when the value was dropped/elided).
    /** @returns {DiagnosticReport} */
    sink.report = () => {
        const sites = [...groups.values()];
        return {
            sites,
            summary: {
                findings: sites.reduce((a, r) => a + r.count, 0),    // total offenders touched
                sites: sites.length,                                 // distinct (site, op) groups
                dropped: sites.reduce((a, r) => a + r.dropped, 0),   // findings that elided the value (per finding)
            },
        };
    };

    return sink;
}

// A function that returns an object may be called with `new`, and yields that object; TypeScript
// refuses the `new` form on a plain function, so the export states both forms it supports.
/** @type {{ new (maxSamples?: number): DiagnosticSinkFn, (maxSamples?: number): DiagnosticSinkFn }} */
export const DiagnosticSink = /** @type {typeof DiagnosticSink} */ (/** @type {unknown} */ (diagnosticSink));

/** @param {FindingPolicy} p */
const fmtPolicy = (p) => Array.isArray(p)
    ? `[${p.map((/** @type {string | number | bigint | D.Value} */ x) => (x !== null && typeof x === 'object' && typeof x.representation === 'function' ? x.representation() : x)).join(', ')}]`
    : String(p);

// Render a `DiagnosticSink.report()` as human-readable text (the operator's post-run,
// pre-commit view). Mirrors `formatPlan`: one line per lossy site, with a sample.
/**
 * @param {DiagnosticReport} report a `DiagnosticSink.report()`
 * @returns {string}
 */
export function formatReport(report) {
    const s = report.summary;
    if (!report.sites.length) return 'Diagnostic report — no Class-B policy fired: nothing was lost.';
    const out = [`Diagnostic report — ${s.findings} value(s) lost/altered across ${s.sites} site(s).`];
    for (const r of report.sites) {
        const pol = r.policy !== null && r.policy !== undefined ? `  policy=${fmtPolicy(r.policy)}` : '';
        out.push(`  ${String(r.op).padEnd(20)} ${String(r.site).padEnd(32)} ×${r.count}${pol}`);
        for (const [before, after] of r.samples) {
            const arrow = after === null || after === undefined ? 'dropped' : after;
            out.push(`      ${before} → ${arrow}`);
        }
    }
    return out.join('\n');
}
