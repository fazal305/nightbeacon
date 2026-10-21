// Start/stop/status for a portable (non-service) local PostgreSQL, e.g. the
// PostgreSQL 18 binaries + C:\coding\nightbeacon\.pgdata setup:
//   npm run db:start | db:stop | db:status
// Configure in server/.env:
//   PG_BIN_DIR   folder containing pg_ctl(.exe)            (required)
//   PG_DATA_DIR  data directory (default: <repo>/.pgdata)
// The port is taken from DATABASE_URL. The log goes to <repo>/.pgdata.log —
// outside the data directory (a log file inside it caused Windows "sharing
// violation" warnings).
//
// Postgres is started DETACHED from the terminal: started normally, it shares
// the console, so Ctrl+C there (e.g. to restart the server) or closing the
// window also shut the database down. The server calls startLocalDb() itself
// when DATABASE_URL points at this machine and nothing answers.
import 'dotenv/config';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
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

// True when DATABASE_URL names this machine, i.e. a database we may start.
export function isLocalDatabase(env = process.env) {
  if (!env.PG_BIN_DIR || !env.DATABASE_URL) return false;
  const host = new URL(env.DATABASE_URL).hostname.replace(/^\[|\]$/g, '');
  return ['localhost', '127.0.0.1', '::1', ''].includes(host);
}

// Starts Postgres unless it's already running. Resolves to 'running' or
// 'started'; rejects with pg_ctl's failure (details are in the log file).
export async function startLocalDb(cfg = localDbConfig()) {
  // pg_ctl status exits 0 when the server is running.
  const status = spawnSync(cfg.pgCtl, pgCtlArgs('status', cfg), { stdio: 'ignore', windowsHide: true });
  if (status.error) throw status.error;
  if (status.status === 0) return 'running';
  // stdio must be 'ignore': postgres inherits pg_ctl's handles and outlives it.
  const child = spawn(cfg.pgCtl, pgCtlArgs('start', cfg), { detached: true, stdio: 'ignore', windowsHide: true });
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  if (code !== 0) throw new Error(`pg_ctl start failed (exit ${code}) — see ${cfg.logFile}`);
  return 'started';
}

async function main() {
  const command = process.argv[2];
  const cfg = localDbConfig();
  if (command === 'start') {
    console.log(`Starting PostgreSQL on port ${cfg.port} (data: ${cfg.dataDir}, log: ${cfg.logFile})…`);
    const outcome = await startLocalDb(cfg);
    console.log(outcome === 'running' ? 'PostgreSQL is already running.' : 'PostgreSQL started (it keeps running if you close this window).');
    return;
  }
  const result = spawnSync(cfg.pgCtl, pgCtlArgs(command, cfg), { stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}
