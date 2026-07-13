// Example migration — defines the schema change; the tool loads and runs it:
//
//     node bin/database_migrate.mjs examples/migration_shop_v2.mjs old.db new.db --verify
//
// `buildDirectives` receives the source's live Definitions, so you build directives
// against real type and field names instead of guessing.

import { TransformationDirectives } from '@digitalsubstrate/dsviper-database-tools';
import dsviper from '@digitalsubstrate/dsviper';

const { Type, ValueString } = dsviper;

export function buildDirectives(sourceDefs) {
    const d = new TransformationDirectives();

    // --- renames (family 1, size-preserving) ---
    d.renameField('Shop::Customer', 'fullname', 'full_name');

    // --- shape changes (family 2) ---
    d.addField('Shop::Customer', 'email', new ValueString(''));      // A: seeded default
    d.dropField('Shop::Customer', 'legacyId');                       // A
    d.retypeField('Shop::Order', 'amountCents', Type.INT64);         // A: int32->int64 widening
    d.retypeField('Shop::Order', 'quantity', Type.INT16, 'saturate'); // B: narrowing

    return d;
}
