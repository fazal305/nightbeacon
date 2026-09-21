import { useParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import StatusBadge from '../components/StatusBadge';

export default function ContentInspector() {
  const { id } = useParams();
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['item', id],
    queryFn: () => api.item(id),
  });

  if (isLoading) return <div className="p-6 text-sm text-text-muted">Loading item…</div>;

  if (isError) {
    const notFound = error instanceof ApiError && error.status === 404;
    return (
      <div className="p-6 text-sm text-priority-high">
        {notFound ? 'Item not found.' : 'Could not load this item.'}
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl p-6">
      <Link to="/dashboard" className="mb-4 inline-block text-sm text-accent underline">
        ← Back to feed
      </Link>

      <div className="mb-4 flex items-center justify-between">
        <h1 className="font-mono text-base text-text">
          {data.display_name} · @{data.channel_username}
        </h1>
        <StatusBadge status={data.status} />
      </div>

      <dl className="mb-4 grid grid-cols-2 gap-y-1 text-xs text-text-muted">
        <dt>Telegram message ID</dt>
        <dd className="text-right text-text">{data.telegram_message_id}</dd>
        <dt>Original timestamp</dt>
        <dd className="text-right text-text">{new Date(data.telegram_date).toLocaleString()}</dd>
        <dt>Collected at</dt>
        <dd className="text-right text-text">{new Date(data.collected_at).toLocaleString()}</dd>
        <dt>Has media</dt>
        <dd className="text-right text-text">{data.has_media ? 'Yes' : 'No'}</dd>
      </dl>

      <section className="mb-4 rounded border border-border bg-panel p-4">
        <h2 className="mb-2 font-mono text-xs uppercase tracking-wide text-text-muted">
          Original source text
        </h2>
        <p className="whitespace-pre-wrap text-sm text-text">
          {data.raw_text || <span className="italic text-text-muted">No text (media-only post)</span>}
        </p>
      </section>

      <p className="text-xs text-text-muted">
        Translation and classification are not yet available for this item — they land in a later
        phase.
      </p>
    </div>
  );
}
