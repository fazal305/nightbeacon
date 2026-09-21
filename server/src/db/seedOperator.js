// Seeds (or updates) the single operator account from OPERATOR_USERNAME / OPERATOR_PASSWORD
// in .env. Run manually: npm run seed:operator
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { pool } from './pool.js';

async function seed() {
  const { OPERATOR_USERNAME, OPERATOR_PASSWORD } = process.env;
  if (!OPERATOR_USERNAME || !OPERATOR_PASSWORD) {
    console.error('Set OPERATOR_USERNAME and OPERATOR_PASSWORD in .env first.');
    process.exit(1);
  }

  const passwordHash = await bcrypt.hash(OPERATOR_PASSWORD, 12);

  await pool.query(
    `INSERT INTO users (username, password_hash)
     VALUES ($1, $2)
     ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash`,
    [OPERATOR_USERNAME, passwordHash]
  );

  console.log(`Operator account "${OPERATOR_USERNAME}" ready.`);
  await pool.end();
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
