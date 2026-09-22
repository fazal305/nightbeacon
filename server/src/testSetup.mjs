// Preloaded via `node --import ./src/testSetup.mjs --test ...` so it runs
// before any test file (or pool.js's own `import 'dotenv/config'`) sets
// DATABASE_URL. Points tests at a dedicated test database instead of
// whatever the developer's local .env points at — tests must never run
// against a database that might hold real production data (see the
// classification/translation test failures this fixed: real ingested
// backlog rows were crowding out the tests' own rows in claim queries).
import dotenv from 'dotenv';

dotenv.config({ path: new URL('../.env.test', import.meta.url) });
