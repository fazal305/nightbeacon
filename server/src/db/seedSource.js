// Seeds the one real Phase 1 channel. Run manually: npm run seed:source
// Sources are meant to live in the database, not hardcoded application code —
// this script is a one-time convenience for Phase 1, not a permanent mechanism.
import 'dotenv/config';
import { pool } from './pool.js';

const CHANNEL_USERNAME = 'Middle_East_Spectator';
const DISPLAY_NAME = 'Middle East Spectator';

async function seed() {
  const result = await pool.query(
    `INSERT INTO sources (channel_username, display_name, language)
     VALUES ($1, $2, $3)
     ON CONFLICT (channel_username) DO NOTHING
     RETURNING id`,
    [CHANNEL_USERNAME, DISPLAY_NAME, 'ar']
  );

  if (result.rows.length > 0) {
    console.log(`Seeded source "${CHANNEL_USERNAME}" (id: ${result.rows[0].id})`);
  } else {
    console.log(`Source "${CHANNEL_USERNAME}" already exists, skipped.`);
  }

  await pool.end();
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
