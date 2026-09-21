import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';

const STATUS_TONE = {
  success: 'text-status-good border-status-good',
  degraded: 'text-priority-medium border-priority-medium',
  failed: 'text-priority-high border-priority-high',
};

const SUBSYSTEM_LABEL = {
  ingestion: 'Ingestion',
  translation: 'Translation',
  classification: 'Classification',
};

export default function Activity() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['activity'],
    queryFn: () => api.activity({ limit: 50 }),
    refetchInterval: 30_000,
  });

  return (
    <div className="p-4">
      <h1 className="mb-4 font-mono text-base text-text">Activity</h1>

      {isLoading && <p className="text-sm text-text-muted">Loading activity…</p>}
      {isError && <p className="text-sm text-priority-high">Could not load activity.</p>}
      {!isLoading && !isError && data?.items?.length === 0 && (
        <p className="text-sm text-text-muted">
          No pipeline runs recorded yet — the ingestion, translation, and classification jobs
          write here after every scheduled tick.
        </p>
      )}

      <div className="overflow-x-auto rounded border border-border">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-border bg-panel text-xs text-text-muted">
            <tr>
              <th className="px-3 py-2">Subsystem</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Started</th>
              <th className="px-3 py-2">Duration</th>
              <th className="px-3 py-2">Processed</th>
              <th className="px-3 py-2">Errors</th>
              <th className="px-3 py-2">Last error</th>
            </tr>
          </thead>
          <tbody>
            {data?.items?.map((run) => (
              <tr key={run.id} className="border-b border-border last:border-0">
                <td className="px-3 py-2 font-mono text-text">
                  {SUBSYSTEM_LABEL[run.subsystem_name] || run.subsystem_name}
                </td>
                <td className="px-3 py-2">
                  <span
                    className={`rounded border px-1.5 py-0.5 font-mono text-xs ${
                      STATUS_TONE[run.status] || 'text-text-muted border-border'
                    }`}
                  >
                    {run.status}
                  </span>
                </td>
                <td className="px-3 py-2 text-text-muted">
                  {new Date(run.started_at).toLocaleString()}
                </td>
                <td className="px-3 py-2 text-text-muted">{run.duration_ms}ms</td>
                <td className="px-3 py-2 text-text">{run.processed_count}</td>
                <td className="px-3 py-2 text-text">{run.error_count}</td>
                <td className="max-w-xs truncate px-3 py-2 text-text-muted" title={run.last_error || ''}>
                  {run.last_error || '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
