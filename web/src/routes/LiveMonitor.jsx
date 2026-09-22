import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/api';
import { useOnlineStatus } from '../lib/useOnlineStatus';
import { useElapsedSeconds } from '../lib/useElapsedSeconds';
import FeedItem from '../components/FeedItem';
import SubsystemHealthBar from '../components/SubsystemHealthBar';

const REFRESH_INTERVAL_MS = 15_000; // faster than Dashboard's configurable interval —
// Live Monitor is the "watch this closely" view; Dashboard is the filterable
// historical one. Both are still scheduled polling, never pretending otherwise.
const LIMIT = 30;
const PRIORITIES = ['', 'high', 'medium', 'low', 'informational'];

function titleCase(str) {
  return str.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export default function LiveMonitor() {
  const { t } = useTranslation();
  const online = useOnlineStatus();
  const [priority, setPriority] = useState('');

  // Two copies of the list on purpose: `data.items` is whatever the last
  // poll returned; `displayedItems` is what's actually on screen. New
  // arrivals surface as a dismissible "N new" banner instead of silently
  // reordering the list under the analyst mid-read — the same principle as
  // "don't auto-scroll a chat the user has scrolled up in".
  const [displayedItems, setDisplayedItems] = useState(null);
  const [newCount, setNewCount] = useState(0);
  const initialized = useRef(false);
  const knownIdsRef = useRef(new Set());

  const { data, isLoading, isError, dataUpdatedAt } = useQuery({
    queryKey: ['live-monitor', priority],
    queryFn: () => api.items({ priority, limit: LIMIT }),
    refetchInterval: online ? REFRESH_INTERVAL_MS : false,
  });

  const elapsedSeconds = useElapsedSeconds(dataUpdatedAt);

  useEffect(() => {
    if (!data?.items) return;
    if (!initialized.current) {
      setDisplayedItems(data.items);
      knownIdsRef.current = new Set(data.items.map((i) => i.id));
      initialized.current = true;
      return;
    }
    const fresh = data.items.filter((i) => !knownIdsRef.current.has(i.id));
    if (fresh.length > 0) {
      setNewCount((n) => n + fresh.length);
    }
  }, [data]);

  useEffect(() => {
    // Filter changed — this is a deliberate new view, not a "new arrival",
    // so reset immediately rather than showing a stale banner.
    initialized.current = false;
    setNewCount(0);
    setDisplayedItems(null);
  }, [priority]);

  function revealNewItems() {
    if (!data?.items) return;
    setDisplayedItems(data.items);
    knownIdsRef.current = new Set(data.items.map((i) => i.id));
    setNewCount(0);
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <h1 className="font-mono text-base text-text">{t('nav.live')}</h1>
        <div className="flex items-center gap-3 text-xs text-text-muted">
          {!online && (
            <span className="rounded border border-priority-medium px-1.5 py-0.5 text-priority-medium">
              {t('feed.offline')}
            </span>
          )}
          {online && elapsedSeconds != null && (
            <span>
              {t('live.checkedAgo', {
                seconds: elapsedSeconds,
                nextIn: Math.max(0, Math.round(REFRESH_INTERVAL_MS / 1000) - elapsedSeconds),
              })}
            </span>
          )}
        </div>
      </div>

      <SubsystemHealthBar />

      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-panel px-4 py-3">
        <span className="text-xs text-text-muted">{t('live.priorityLabel')}</span>
        {PRIORITIES.map((p) => (
          <button
            key={p}
            onClick={() => setPriority(p)}
            className={`rounded border px-2 py-1 text-xs ${
              priority === p ? 'border-accent text-accent' : 'border-border text-text-muted hover:text-text'
            }`}
          >
            {p === '' ? t('live.priorityAll') : titleCase(p)}
          </button>
        ))}
      </div>

      <div className="relative flex-1 overflow-y-auto">
        {newCount > 0 && (
          <button
            onClick={revealNewItems}
            className="sticky top-0 z-10 block w-full border-b border-accent bg-accent/10 px-4 py-2 text-center text-sm text-accent hover:bg-accent/20"
          >
            {t('live.newItems', { count: newCount })}
          </button>
        )}

        {isLoading && (
          <div className="p-6 text-sm text-text-muted">{t('feed.loading')}</div>
        )}

        {isError && (
          <div className="p-6 text-sm text-priority-high">{t('feed.error')}</div>
        )}

        {!isLoading && !isError && displayedItems?.length === 0 && (
          <div className="p-6 text-sm text-text-muted">{t('feed.empty')}</div>
        )}

        {!isLoading && !isError && displayedItems?.map((item) => (
          <FeedItem key={item.id} item={item} />
        ))}
      </div>
    </div>
  );
}
