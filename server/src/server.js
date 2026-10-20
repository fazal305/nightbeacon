import { createApp } from './app.js';
import { startPipeline } from './pipeline/workers.js';
import { recoverOrphanedStatuses } from './db/recoverOrphanedStatuses.js';

const PORT = process.env.PORT || 4000;
const app = createApp();

app.listen(PORT, async () => {
  console.log(`Nightbeacon API listening on port ${PORT}`);
  await recoverOrphanedStatuses();
  startPipeline();
});
