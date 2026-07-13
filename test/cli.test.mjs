// CLI smoke — the tool loads (importing the peer binding) and its argument guards fire
// cleanly. The functional path (dispatch + migrate) is covered by migrate/commit tests.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../bin/database_migrate.mjs', import.meta.url));
const run = (args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });

describe('database_migrate CLI', () => {
    it('prints usage on a wrong argument count', () => {
        const { stdout, stderr } = run([]);
        assert.match(`${stdout}${stderr}`, /usage:/);
    });

    it('errors cleanly on a missing source', () => {
        const { stdout, stderr, status } = run(['examples/migration_shop_v2.mjs', '/tmp/nope_xyz.db', '/tmp/out.db']);
        assert.match(`${stdout}${stderr}`, /No such file/);
        assert.equal(status, 1);
    });
});
