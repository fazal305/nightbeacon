// Start/stop/status for a portable (non-service) local PostgreSQL, e.g. the
// PostgreSQL 18 binaries + C:\coding\nightbeacon\.pgdata setup:
//   npm run db:start | db:stop | db:status
// Configure in server/.env:
//   PG_BIN_DIR   folder containing pg_ctl(.exe)            (required)
//   PG_DATA_DIR  data directory (default: <repo>/.pgdata)
// The port is taken from DATABASE_URL. The log goes to <repo>/.pgdata.log —
// outside the data directory (a log file inside it caused Windows "sharing
// violation" warnings).
import 'dotenv/config';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

export function localDbConfig(env = process.env) {
  if (!env.PG_BIN_DIR) throw new Error('Set PG_BIN_DIR in server/.env to the folder containing pg_ctl');
  const port = env.DATABASE_URL ? new URL(env.DATABASE_URL).port || '5432' : '5432';
  return {
    pgCtl: path.join(env.PG_BIN_DIR, process.platform === 'win32' ? 'pg_ctl.exe' : 'pg_ctl'),
    dataDir: path.resolve(env.PG_DATA_DIR || path.join(repoRoot, '.pgdata')),
    logFile: path.join(repoRoot, '.pgdata.log'),
    port,
  };
}

export function pgCtlArgs(command, cfg) {
  switch (command) {
    case 'start':
      return ['start', '-D', cfg.dataDir, '-o', `-p ${cfg.port}`, '-l', cfg.logFile, '-w', '-t', '120'];
    case 'stop':
      return ['stop', '-D', cfg.dataDir, '-m', 'fast', '-w'];
    case 'status':
      return ['status', '-D', cfg.dataDir];
    default:
      throw new Error(`Unknown command "${command}" — use start, stop or status`);
  }
}

function main() {
  const command = process.argv[2];
  const cfg = localDbConfig();
  if (command === 'start') {
    // pg_ctl status exits 0 when the server is running.
    const status = spawnSync(cfg.pgCtl, pgCtlArgs('status', cfg), { stdio: 'ignore' });
    if (status.status === 0) {
      console.log(`PostgreSQL is already running (data: ${cfg.dataDir}).`);
      return;
    }
    console.log(`Starting PostgreSQL on port ${cfg.port} (data: ${cfg.dataDir}, log: ${cfg.logFile})…`);
  }
  const result = spawnSync(cfg.pgCtl, pgCtlArgs(command, cfg), { stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}
