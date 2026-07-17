// The rewrite kernel — the pure, I/O-free core of the tool. A schema-directed,
// format-agnostic value transformation over the Viper value model (Definitions / Type /
// Value): `DefinitionsRewriter` builds a target `Definitions` from a source schema +
// `TransformationDirectives` and rewrites any source-domain value to the target domain, with no
// I/O, no store, and no serialization format of its own.
//
// Public surface:
//   DefinitionsRewriter        — buildTargetDefinitions() + value() — the engine
//   TransformationDirectives   — the declarative edit script (the engine's input)
//   buildTargetDefinitions     — definitions => definitions (phase 1)
//   Unrepresentable            — a value has no faithful target image (decreed elide)
//   plan / formatPlan          — the static plan report (schema-only pre-validation)
//   DiagnosticSink / formatReport — the dynamic diagnostic report (real per-site loss)

export { DefinitionsRewriter, buildTargetDefinitions, Unrepresentable } from './engine.mjs';
export { TransformationDirectives } from './directives.mjs';
export { plan, formatPlan } from './plan.mjs';
export { DiagnosticSink, formatReport } from './report.mjs';
