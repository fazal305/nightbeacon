import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';

const STATUS_LABEL = {
  success: 'Healthy',
  degraded: 'Degraded',
  failed: 'Failed',
  never_run: 'Never run',
};

const STATUS_DOT = {
  success: 'bg-status-good',
  degraded: 'bg-status-degraded',
  failed: 'bg-status-failed',
  never_run: 'bg-text-muted',
};

const SUBSYSTEM_LABEL = {
  ingestion: 'Ingestion',
  translation: 'Translation',
  classification: 'Classification',
};

function formatRelative(iso) {
  if (!iso) return 'never';
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ago`;
}

export default function SubsystemHealthBar() {
  const { data, isLoading } = useQuery({
    queryKey: ['subsystems'],
    queryFn: api.subsystems,
    refetchInterval: 30_000,
  });

  if (isLoading || !data) return null;

  return (
    <div className="flex flex-wrap items-center gap-4 border-b border-border bg-panel px-4 py-2 text-xs">
      {data.map((s) => (
        <div key={s.subsystem_name} className="flex items-center gap-1.5" title={s.last_error || ''}>
          <span className={`h-2 w-2 rounded-full ${STATUS_DOT[s.status] || 'bg-text-muted'}`} />
          <span className="text-text">{SUBSYSTEM_LABEL[s.subsystem_name] || s.subsystem_name}</span>
          <span className="text-text-muted">
            {STATUS_LABEL[s.status] || s.status} · {formatRelative(s.started_at)}
          </span>
          {s.status !== 'never_run' && (
            <span className="text-text-muted">
              ({s.processed_count} processed{s.error_count > 0 ? `, ${s.error_count} failed` : ''})
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
