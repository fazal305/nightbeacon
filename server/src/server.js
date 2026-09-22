import { createApp } from './app.js';
import { startCronJobs } from './cron/schedule.js';
import { recoverOrphanedStatuses } from './db/recoverOrphanedStatuses.js';

const PORT = process.env.PORT || 4000;
const app = createApp();

app.listen(PORT, async () => {
  console.log(`Nightbeacon API listening on port ${PORT}`);
  await recoverOrphanedStatuses();
  startCronJobs();
});
