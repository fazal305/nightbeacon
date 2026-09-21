import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';

function formatTimestamp(iso) {
  if (!iso) return 'Never';
  return new Date(iso).toLocaleString();
}

export default function Sources() {
  const { data, isLoading, isError } = useQuery({ queryKey: ['sources'], queryFn: api.sources });

  return (
    <div className="p-4">
      <h1 className="mb-4 font-mono text-base text-text">Sources</h1>

      {isLoading && <p className="text-sm text-text-muted">Loading sources…</p>}
      {isError && <p className="text-sm text-priority-high">Could not load sources.</p>}
      {!isLoading && !isError && data?.length === 0 && (
        <p className="text-sm text-text-muted">No sources configured yet.</p>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        {data?.map((s) => (
          <Link
            key={s.id}
            to={`/sources/${s.id}`}
            className="block rounded border border-border bg-panel p-4 hover:border-accent/50"
          >
            <div className="mb-1 flex items-center justify-between">
              <span className="font-mono text-sm text-text">{s.display_name}</span>
              <span
                className={`rounded px-1.5 py-0.5 text-xs ${
                  s.enabled ? 'text-status-good' : 'text-text-muted'
                }`}
              >
                {s.enabled ? 'Enabled' : 'Disabled'}
              </span>
            </div>
            <div className="mb-2 font-mono text-xs text-text-muted">@{s.channel_username}</div>
            <dl className="grid grid-cols-2 gap-y-1 text-xs text-text-muted">
              <dt>Items collected</dt>
              <dd className="text-right text-text">{s.item_count}</dd>
              <dt>Last poll</dt>
              <dd className="text-right text-text">{formatTimestamp(s.last_poll_at)}</dd>
              <dt>Poll errors</dt>
              <dd className="text-right text-text">{s.poll_error_count}</dd>
            </dl>
            {s.last_error && (
              <p className="mt-2 truncate text-xs text-priority-high">{s.last_error}</p>
            )}
          </Link>
        ))}
      </div>
    </div>
  );
}
