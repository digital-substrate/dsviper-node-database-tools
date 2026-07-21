#!/usr/bin/env node
// Patch a hand-authored .dsm tree under a transformed schema — the DSM-source twin of
// database_migrate.mjs. A structured codemod: the file split, comments, ordering and formatting are
// preserved; the source tree is read-only and a fresh target tree is written. The result is
// verified against the migration engine (equal definitions digest) unless --no-verify.
//
//   node bin/definitions_migrate.mjs migration.mjs src_dir out_dir [--no-verify] [--force]
//
// The migration file is the SAME one database_migrate.mjs uses — it exports
// buildDirectives(sourceDefs) -> TransformationDirectives.

import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

import { definitionsMigrate } from '../src/definitions_migrate.mjs';

// Import a transformation file by path; it must export buildDirectives(sourceDefs) ->
// TransformationDirectives. Arbitrary code — the operator's own, no sandbox.
async function loadTransformation(file) {
    const mod = await import(pathToFileURL(path.resolve(file)).href);
    if (typeof mod.buildDirectives !== 'function') {
        console.error(`${file}: must export buildDirectives(sourceDefs) -> TransformationDirectives — the same file database_migrate.mjs uses`);
        process.exit(1);
    }
    return mod;
}

const expand = (p) => (p.startsWith('~') ? path.join(process.env.HOME ?? '', p.slice(1)) : p);

async function main() {
    let parsed;
    try {
        parsed = parseArgs({
            allowPositionals: true,
            options: {
                'no-verify': { type: 'boolean', default: false },
                force: { type: 'boolean', default: false },
            },
        });
    } catch {
        parsed = { values: {}, positionals: [] };
    }
    const { values, positionals } = parsed;
    if (positionals.length < 3) {
        console.error('usage: definitions_migrate.mjs <transformation> <source_dir> <out_dir> [--no-verify] [--force]');
        process.exit(1);
    }
    const [transformation, sourceDirArg, outDirArg] = positionals;

    const sourceDir = expand(sourceDirArg);
    if (!fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) {
        console.error(`No such directory: ${sourceDir}`);
        process.exit(1);
    }
    const outDir = expand(outDirArg);
    if (fs.existsSync(outDir) && fs.statSync(outDir).isDirectory()
        && fs.readdirSync(outDir).length && !values.force) {
        console.error(`out_dir is not empty (use --force): ${outDir}`);
        process.exit(1);
    }

    const module = await loadTransformation(expand(transformation));
    try {
        definitionsMigrate(sourceDir, module, outDir, { verify: !values['no-verify'] });
    } catch (exc) {
        console.error(exc.message);
        process.exit(1);
    }
    console.log(`patched ${sourceDir} -> ${outDir}`
        + (values['no-verify'] ? '' : ' (verified against the engine target)'));
}

main();
