// Lists monitored sources, to find usernames for channels/official-sources.md:
//   npm run sources:list                 all sources
//   npm run sources:list -- qassam       only names/usernames containing "qassam"
import 'dotenv/config';
import { pool } from './pool.js';

const search = (process.argv[2] || '').toLowerCase();
const { rows } = await pool.query(
  `SELECT channel_username, display_name, enabled FROM sources
   WHERE $1 = '' OR lower(channel_username) LIKE '%' || $1 || '%' OR lower(display_name) LIKE '%' || $1 || '%'
   ORDER BY lower(display_name)`,
  [search]
);
for (const r of rows) console.log(`@${r.channel_username.padEnd(32)} ${r.display_name}${r.enabled ? '' : '  (disabled)'}`);
console.log(`\n${rows.length} source(s)`);
await pool.end();
