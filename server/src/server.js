import { createApp } from './app.js';
import { startCronJobs } from './cron/schedule.js';

const PORT = process.env.PORT || 4000;
const app = createApp();

app.listen(PORT, () => {
  console.log(`Nightbeacon API listening on port ${PORT}`);
  startCronJobs();
});
