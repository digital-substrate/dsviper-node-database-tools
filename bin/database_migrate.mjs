#!/usr/bin/env node
// Migrate a Viper Database or CommitDatabase under a transformed schema. Reads the
// source read-only and writes a fresh target — a rebuild, never an in-place ALTER; the
// source is kept as rollback. A CommitDatabase is replayed faithfully (history
// preserved). The schema change is a migration file exporting
// `buildDirectives(sourceDefs) -> TransformationDirectives`. Port of the Python CLI.
//
//     node bin/database_migrate.mjs migration.mjs old.db new.db --verify

import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

import V from '../src/dsviper.mjs';
import { runMigration } from '../src/migrate.mjs';
import { runCommitMigration } from '../src/commit_migrate.mjs';

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
                verify: { type: 'boolean', default: false },
                force: { type: 'boolean', default: false },
                verbose: { type: 'boolean', short: 'v', default: false },
            },
        });
    } catch {
        parsed = { values: {}, positionals: [] };
    }
    const { values, positionals } = parsed;
    if (positionals.length !== 3) {
        console.error('usage: database_migrate.mjs <migration> <source> <target> [--verify] [--force] [-v]');
        process.exit(1);
    }
    const [migration, source, target] = positionals;
    if (!fs.existsSync(source)) { console.error(`No such file: ${source}`); process.exit(1); }
    if (fs.existsSync(target)) {
        if (!values.force) { console.error(`Target exists (use --force to overwrite): ${target}`); process.exit(1); }
        fs.rmSync(target);
    }

    const buildDirectives = await loadBuildDirectives(migration);
    let info;
    if (V.CommitDatabase.isCompatible(source)) {
        if (values.verify) console.error('note: --verify is not yet supported for a CommitDatabase (ignored).');
        info = runCommitMigration(source, buildDirectives, target);
    } else if (V.Database.isCompatible(source)) {
        info = runMigration(source, buildDirectives, target, { verify: values.verify });
    } else {
        console.error(`Not a dsviper Database or CommitDatabase: ${source}`);
        process.exit(1);
    }

    if (values.verbose) console.log(info);
    console.log(`migrated ${source} -> ${target}`);
}

main();
