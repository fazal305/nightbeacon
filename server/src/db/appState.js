import { pool } from './pool.js';

// Small persistent key/value store (app_state table) for runtime state that
// must survive restarts, e.g. the bot's MTProto session.
export async function getState(key) {
  const { rows } = await pool.query('SELECT value, updated_at FROM app_state WHERE key = $1', [key]);
  return rows[0] ? { value: rows[0].value, updatedAt: rows[0].updated_at } : null;
}

export async function setState(key, value) {
  await pool.query(
    `INSERT INTO app_state (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, value]
  );
}
