import { useEffect, useState } from 'react';

// Ticks every second so the UI can show "checked Ns ago" — an honest,
// live-feeling freshness indicator that never claims to be a push feed
// (Nightbeacon is scheduled polling, see docs/POLLING.md and section 25 of
// the original brief: "communicate freshness honestly").
export function useElapsedSeconds(sinceTimestamp) {
  const [, forceTick] = useState(0);

  useEffect(() => {
    if (!sinceTimestamp) return;
    const id = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [sinceTimestamp]);

  if (!sinceTimestamp) return null;
  return Math.max(0, Math.floor((Date.now() - sinceTimestamp) / 1000));
}
