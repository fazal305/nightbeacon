import { useState } from 'react';
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
  const [subsystemFilter, setSubsystemFilter] = useState('');
  const [cursors, setCursors] = useState([undefined]); // stack of cursors visited
  const cursor = cursors[cursors.length - 1];

  const { data, isLoading, isError } = useQuery({
    queryKey: ['activity', cursor, subsystemFilter],
    queryFn: () => api.activity({ limit: 50, cursor, subsystem: subsystemFilter }),
    refetchInterval: cursors.length === 1 ? 30_000 : false,
  });

  const items = data?.items || [];

  return (
    <div className="p-4">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="font-mono text-base text-text">Activity</h1>
        <select
          value={subsystemFilter}
          onChange={(e) => {
            setSubsystemFilter(e.target.value);
            setCursors([undefined]);
          }}
          className="rounded border border-border bg-panel-raised px-2 py-1 text-sm text-text"
        >
          <option value="">All subsystems</option>
          <option value="ingestion">Ingestion</option>
          <option value="translation">Translation</option>
          <option value="classification">Classification</option>
        </select>
      </div>

      {isLoading && <p className="text-sm text-text-muted">Loading activity…</p>}
      {isError && <p className="text-sm text-priority-high">Could not load activity.</p>}
      {!isLoading && !isError && items.length === 0 && (
        <p className="text-sm text-text-muted">
          No pipeline runs recorded yet — the ingestion, translation, and classification jobs
          write here after every scheduled tick.
        </p>
      )}

      {items.length > 0 && (
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
              {items.map((run) => (
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
                  <td
                    className="max-w-xs truncate px-3 py-2 text-text-muted"
                    title={run.last_error || ''}
                  >
                    {run.last_error || '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="mt-3 flex items-center gap-2">
        {cursors.length > 1 && (
          <button
            onClick={() => setCursors((c) => c.slice(0, -1))}
            className="rounded border border-border px-3 py-1.5 text-sm text-text-muted hover:text-text"
          >
            ← Newer
          </button>
        )}
        {data?.nextCursor && (
          <button
            onClick={() => setCursors((c) => [...c, data.nextCursor])}
            className="rounded border border-border px-3 py-1.5 text-sm text-text-muted hover:text-text"
          >
            Older →
          </button>
        )}
      </div>
    </div>
  );
}
