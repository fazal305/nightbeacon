import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localDbConfig, pgCtlArgs, isLocalDatabase } from './localDb.js';

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

test('localDb: only a database on this machine is started automatically', () => {
  const url = (host) => `postgres://u:p@${host}:5434/nightbeacon`;
  assert.equal(isLocalDatabase({ PG_BIN_DIR: '/pg/bin', DATABASE_URL: url('localhost') }), true);
  assert.equal(isLocalDatabase({ PG_BIN_DIR: '/pg/bin', DATABASE_URL: url('127.0.0.1') }), true);
  assert.equal(isLocalDatabase({ PG_BIN_DIR: '/pg/bin', DATABASE_URL: url('[::1]') }), true);
  assert.equal(isLocalDatabase({ PG_BIN_DIR: '/pg/bin', DATABASE_URL: url('db.example.com') }), false);
  assert.equal(isLocalDatabase({ DATABASE_URL: url('localhost') }), false);
});
