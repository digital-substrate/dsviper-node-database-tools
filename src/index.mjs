// Public API of @digitalsubstrate/dsviper-database-tools — the Node twin of the Python
// dsviper_database_tools package. A 1:1 port.
//
// Two silo modules, each self-contained and symmetric — migrate / verify / dryRun / run:
//
//   import { migrateDatabase, migrateCommitDatabase } from '@digitalsubstrate/dsviper-database-tools';
//   migrateDatabase.migrate(source, rewriter, target);                 // the Database loop
//   migrateDatabase.run(srcPath, buildDirectives, tgtPath, { verify: true });
//   migrateCommitDatabase.migrate(source, rewriter, target);           // the CommitDatabase replay
//   migrateCommitDatabase.verify(source, rewriter, target, remap);
//
// Top-level vocabulary: the pure kernel (rewrite/) + VerificationError.

export {
    TransformationDirectives,      // the edit script (declarative)
    DefinitionsRewriter,           // buildTargetDefinitions() + value() — the engine
    Unrepresentable,               // a value has no faithful target image (decreed elide)
    buildTargetDefinitions,        // definitions => definitions (phase 1)
    plan, formatPlan,              // the static plan report (schema-only pre-validation)
    DiagnosticSink, formatReport,  // the dynamic diagnostic report (real per-site loss)
} from './rewrite/index.mjs';

export { VerificationError } from './migrate_database.mjs';   // raised by verify() on any divergence

export * as migrateDatabase from './migrate_database.mjs';         // silo 2: .migrate / .verify / .dryRun / .run
export * as migrateCommitDatabase from './migrate_commit_database.mjs';   // silo 3: same surface
