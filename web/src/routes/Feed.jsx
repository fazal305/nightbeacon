import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useUiStore } from '../store/uiStore';
import FilterBar from '../components/FilterBar';
import FeedItem from '../components/FeedItem';
import SubsystemHealthBar from '../components/SubsystemHealthBar';
import { useOnlineStatus } from '../lib/useOnlineStatus';
import { useSlowLoading } from '../lib/useSlowLoading';

export default function Feed() {
  const { t } = useTranslation();
  const { filters, refreshIntervalMs } = useUiStore();
  const online = useOnlineStatus();

  const { data, isLoading, isError, dataUpdatedAt, refetch, isFetching } = useQuery({
    queryKey: ['items', filters],
    queryFn: () => api.items(filters),
    refetchInterval: online ? refreshIntervalMs : false,
  });

  const isStale = dataUpdatedAt && Date.now() - dataUpdatedAt > refreshIntervalMs * 3;
  const isSlow = useSlowLoading(isLoading);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <h1 className="font-mono text-base text-text">{t('nav.dashboard')}</h1>
        <div className="flex items-center gap-3 text-xs text-text-muted">
          {!online && (
            <span className="rounded border border-priority-medium px-1.5 py-0.5 text-priority-medium">
              {t('feed.offline')}
            </span>
          )}
          {online && isStale && (
            <span className="rounded border border-priority-medium px-1.5 py-0.5 text-priority-medium">
              {t('feed.stale')}
            </span>
          )}
          {dataUpdatedAt ? (
            <span>{t('feed.lastUpdated', { time: new Date(dataUpdatedAt).toLocaleTimeString() })}</span>
          ) : null}
          <button
            onClick={() => refetch()}
            disabled={!online}
            className="rounded border border-border px-2 py-1 hover:text-text disabled:opacity-50"
          >
            {isFetching ? t('feed.refreshing') : t('feed.refresh')}
          </button>
        </div>
      </div>

      <SubsystemHealthBar />
      <FilterBar />

      <div className="flex-1 overflow-y-auto">
        {isLoading && (
          <div className="p-6 text-sm text-text-muted">
            {isSlow ? t('feed.slowNetwork') : t('feed.loading')}
          </div>
        )}

        {isError && (
          <div className="p-6 text-sm text-priority-high">{t('feed.error')}</div>
        )}

        {!isLoading && !isError && data?.items?.length === 0 && (
          <div className="p-6 text-sm text-text-muted">{t('feed.empty')}</div>
        )}

        {!isLoading && !isError && data?.items?.map((item) => (
          <FeedItem key={item.id} item={item} />
        ))}
      </div>
    </div>
  );
}
