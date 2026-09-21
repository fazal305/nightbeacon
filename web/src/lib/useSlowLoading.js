import { useEffect, useState } from 'react';

const SLOW_THRESHOLD_MS = 4000;

// Distinguishes "briefly loading" from "the server is taking unusually long" —
// separate UI states so a slow response doesn't just look like a normal
// loading flicker (per the project's UI-states requirement: distinguish
// normal loading from slow network without creating flashing/anxious UI).
export function useSlowLoading(isLoading) {
  const [isSlow, setIsSlow] = useState(false);

  useEffect(() => {
    if (!isLoading) {
      setIsSlow(false);
      return;
    }
    const timer = setTimeout(() => setIsSlow(true), SLOW_THRESHOLD_MS);
    return () => clearTimeout(timer);
  }, [isLoading]);

  return isSlow;
}
