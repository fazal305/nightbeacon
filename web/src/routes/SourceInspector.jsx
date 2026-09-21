import { useParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import StatusBadge from '../components/StatusBadge';
import PriorityBadge, { CategoryBadge } from '../components/PriorityBadge';

function formatTimestamp(iso) {
  if (!iso) return 'Never';
  return new Date(iso).toLocaleString();
}

export default function SourceInspector() {
  const { id } = useParams();
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['source', id],
    queryFn: () => api.source(id),
  });

  if (isLoading) return <div className="p-6 text-sm text-text-muted">Loading source…</div>;

  if (isError) {
    const notFound = error instanceof ApiError && error.status === 404;
    return (
      <div className="p-6 text-sm text-priority-high">
        {notFound ? 'Source not found.' : 'Could not load this source.'}
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl p-6">
      <Link to="/sources" className="mb-4 inline-block text-sm text-accent underline">
        ← Back to sources
      </Link>

      <div className="mb-1 flex items-center justify-between">
        <h1 className="font-mono text-base text-text">{data.display_name}</h1>
        <span
          className={`rounded px-1.5 py-0.5 text-xs ${
            data.enabled ? 'text-status-good' : 'text-text-muted'
          }`}
        >
          {data.enabled ? 'Enabled' : 'Disabled'}
        </span>
      </div>
      <div className="mb-4 font-mono text-xs text-text-muted">@{data.channel_username}</div>

      {data.reliability_note && (
        <p className="mb-4 rounded border border-border bg-panel p-3 text-sm text-text-muted">
          {data.reliability_note}
        </p>
      )}

      <dl className="mb-4 grid grid-cols-2 gap-y-1.5 rounded border border-border bg-panel p-4 text-xs text-text-muted">
        <dt>Language</dt>
        <dd className="text-right text-text">{data.language || '—'}</dd>
        <dt>First tracked</dt>
        <dd className="text-right text-text">{formatTimestamp(data.first_tracked_at)}</dd>
        <dt>Posts collected</dt>
        <dd className="text-right text-text">{data.item_count}</dd>
        <dt>Posts ready (fully processed)</dt>
        <dd className="text-right text-text">{data.ready_count}</dd>
        <dt>Last successful poll</dt>
        <dd className="text-right text-text">{formatTimestamp(data.last_success_at)}</dd>
        <dt>Last poll attempt</dt>
        <dd className="text-right text-text">{formatTimestamp(data.last_poll_at)}</dd>
        <dt>Consecutive poll errors</dt>
        <dd className="text-right text-text">{data.poll_error_count}</dd>
        <dt>Last seen Telegram ID</dt>
        <dd className="text-right text-text">{data.last_seen_id}</dd>
      </dl>

      {data.last_error && (
        <div className="mb-4 rounded border border-priority-high/50 bg-panel p-3">
          <h2 className="mb-1 font-mono text-xs uppercase tracking-wide text-priority-high">
            Most recent polling error
          </h2>
          <p className="text-sm text-text-muted">{data.last_error}</p>
        </div>
      )}

      <h2 className="mb-2 font-mono text-xs uppercase tracking-wide text-text-muted">
        Recent items
      </h2>
      {data.recent_items?.length === 0 && (
        <p className="text-sm text-text-muted">No items collected from this source yet.</p>
      )}
      <div className="rounded border border-border">
        {data.recent_items?.map((item) => (
          <Link
            key={item.id}
            to={`/content/${item.id}`}
            className="flex items-center justify-between gap-3 border-b border-border px-3 py-2 last:border-0 hover:bg-panel-raised"
          >
            <span className="truncate text-sm text-text">
              {item.raw_text || <span className="italic text-text-muted">No text (media)</span>}
            </span>
            <span className="flex shrink-0 items-center gap-1.5">
              <CategoryBadge category={item.category} />
              <PriorityBadge priority={item.priority} />
              <StatusBadge status={item.status} />
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}
