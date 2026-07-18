#!/usr/bin/env node
// Migrate a Viper Database or CommitDatabase under a transformed schema. Reads the source
// read-only and writes a fresh target — a rebuild, never an in-place ALTER; the source is kept
// as rollback. A CommitDatabase is replayed faithfully (history preserved). The schema change is
// a migration file exporting buildDirectives(sourceDefs) -> TransformationDirectives.
//
// The decision loop is on the command line — identify, inform, then decide:
//   node bin/database_migrate.mjs migration.mjs old.db          --plan      # identify: the static plan
//   node bin/database_migrate.mjs migration.mjs old.db          --dry-run   # inform:   real loss, no write
//   node bin/database_migrate.mjs migration.mjs old.db new.db   --verify    # decide:   migrate + prove

import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

import V from '../src/dsviper.mjs';
import * as migrateDatabase from '../src/migrate_database.mjs';
import * as migrateCommitDatabase from '../src/migrate_commit_database.mjs';
import { DefinitionsRewriter, plan, formatPlan, formatReport } from '../src/rewrite/index.mjs';

async function loadBuildDirectives(file) {
    const mod = await import(pathToFileURL(path.resolve(file)).href);
    if (typeof mod.buildDirectives !== 'function') {
        console.error(`${file}: must export buildDirectives(sourceDefs) -> TransformationDirectives`);
        process.exit(1);
    }
    return mod.buildDirectives;
}

async function main() {
    let parsed;
    try {
        parsed = parseArgs({
            allowPositionals: true,
            options: {
                plan: { type: 'boolean', default: false },
                'dry-run': { type: 'boolean', default: false },
                verify: { type: 'boolean', default: false },
                force: { type: 'boolean', default: false },
                verbose: { type: 'boolean', short: 'v', default: false },
            },
        });
    } catch {
        parsed = { values: {}, positionals: [] };
    }
    const { values, positionals } = parsed;
    if (positionals.length < 2) {
        console.error('usage: database_migrate.mjs <migration> <source> [target] [--plan | --dry-run | --verify] [--force] [-v]');
        process.exit(1);
    }
    const [migration, source, target] = positionals;
    if (!fs.existsSync(source)) { console.error(`No such file: ${source}`); process.exit(1); }

    // dispatch on the source kind, once — the silo module + a read-only opener
    let silo; let open;
    if (V.CommitDatabase.isCompatible(source)) { silo = migrateCommitDatabase; open = () => V.CommitDatabase.open(source, true); }
    else if (V.Database.isCompatible(source)) { silo = migrateDatabase; open = () => V.Database.open(source, true); }
    else { console.error(`Not a dsviper Database or CommitDatabase: ${source}`); process.exit(1); }

    const buildDirectives = await loadBuildDirectives(migration);

    // -- pre-flight (identify / inform): read-only, print, and exit before any write --
    if (values.plan || values['dry-run']) {
        const src = open();
        try {
            const directives = buildDirectives(src.definitions());
            if (values.plan) {
                console.log(formatPlan(plan(src.definitions(), directives)));
            } else {                                          // --dry-run
                const [rewriter] = DefinitionsRewriter.fromDirectives(src.definitions(), directives);
                const info = silo.dryRun(src, rewriter);
                const { diagnostics, ...counts } = info;
                console.log(counts);                          // counts (documents/commits, drops, blobs, …)
                if (diagnostics) console.log(formatReport(diagnostics));   // per-site loss, before -> after
            }
        } finally {
            src.close();
        }
        return;
    }

    // -- decide: the real migration (a target is required) --
    if (!target) {
        console.error('a target is required for a migration (omit it only with --plan / --dry-run)');
        process.exit(1);
    }
    if (fs.existsSync(target)) {
        if (!values.force) { console.error(`Target exists (use --force to overwrite): ${target}`); process.exit(1); }
        fs.rmSync(target);
    }
    const info = silo.run(source, buildDirectives, target, { verify: values.verify });
    if (values.verbose) console.log(info);
    console.log(`migrated ${source} -> ${target}`);
}

main();
