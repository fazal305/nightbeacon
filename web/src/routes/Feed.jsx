import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useUiStore } from '../store/uiStore';
import FilterBar from '../components/FilterBar';
import FeedItem from '../components/FeedItem';
import SubsystemHealthBar from '../components/SubsystemHealthBar';

const REFRESH_INTERVAL_MS = 30_000;

export default function Feed({ title }) {
  const { t } = useTranslation();
  const { filters } = useUiStore();

  const { data, isLoading, isError, dataUpdatedAt, refetch, isFetching } = useQuery({
    queryKey: ['items', filters],
    queryFn: () => api.items(filters),
    refetchInterval: REFRESH_INTERVAL_MS,
  });

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <h1 className="font-mono text-base text-text">{title}</h1>
        <div className="flex items-center gap-3 text-xs text-text-muted">
          {dataUpdatedAt ? (
            <span>Last updated: {new Date(dataUpdatedAt).toLocaleTimeString()}</span>
          ) : null}
          <button
            onClick={() => refetch()}
            className="rounded border border-border px-2 py-1 hover:text-text"
          >
            {isFetching ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>

      <SubsystemHealthBar />
      <FilterBar />

      <div className="flex-1 overflow-y-auto">
        {isLoading && (
          <div className="p-6 text-sm text-text-muted">{t('feed.loading')}</div>
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
