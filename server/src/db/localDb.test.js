import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localDbConfig, pgCtlArgs } from './localDb.js';

test('localDb: port from DATABASE_URL, log kept outside the data directory', () => {
  const cfg = localDbConfig({ PG_BIN_DIR: '/pg/bin', PG_DATA_DIR: '/data/pg', DATABASE_URL: 'postgres://u:p@localhost:5434/nightbeacon' });
  assert.equal(cfg.port, '5434');
  assert.ok(!cfg.logFile.startsWith(cfg.dataDir + '/') && !cfg.logFile.startsWith(cfg.dataDir + '\\'));
  assert.deepEqual(pgCtlArgs('start', cfg).slice(0, 5), ['start', '-D', cfg.dataDir, '-o', '-p 5434']);
  assert.deepEqual(pgCtlArgs('stop', cfg), ['stop', '-D', cfg.dataDir, '-m', 'fast', '-w']);
});

test('localDb: clear errors for missing config or unknown command', () => {
  assert.throws(() => localDbConfig({}), /PG_BIN_DIR/);
  assert.throws(() => pgCtlArgs('restart', { dataDir: 'x' }), /Unknown command/);
});
