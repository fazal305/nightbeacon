import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/api';

// Compact view of GET /api/pipeline/metrics: queue depth and age per stage,
// per-stage latency, throughput and Telegram ingestion health — so a growing
// backlog can be pinned on the stage actually causing it.

function formatDuration(seconds) {
  if (seconds == null || Number.isNaN(seconds)) return '—';
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${s % 60 ? ` ${s % 60}s` : ''}`;
  const h = Math.floor(s / 3600);
  return `${h}h ${Math.floor((s % 3600) / 60)}m`;
}

function ageSince(iso) {
  return iso ? formatDuration((Date.now() - new Date(iso).getTime()) / 1000) : '—';
}

const LATENCY_KEYS = [
  ['telegram_to_observed', 'telegramToObserved'],
  ['observed_to_committed', 'observedToCommitted'],
  ['committed_to_deduped', 'committedToDeduped'],
  ['deduped_to_translated', 'dedupedToTranslated'],
  ['translated_to_ready', 'translatedToReady'],
  ['end_to_end', 'endToEnd'],
];

export default function PipelinePanel() {
  const { t } = useTranslation();
  const { data } = useQuery({
    queryKey: ['pipeline-metrics'],
    queryFn: api.pipelineMetrics,
    refetchInterval: 15_000,
  });

  if (!data) return null;
  const { queues, latencySeconds, throughputPerMinute, ingestion, dedupLastHour } = data;
  const tg = ingestion.telegram;

  const queueCell = (label, q) => (
    <span>
      <span className="text-text">{label}</span> {q.depth}
      {q.depth > 0 && <span className="text-text-muted"> ({t('pipeline.oldest', { age: ageSince(q.oldest_collected_at) })})</span>}
    </span>
  );

  return (
    <details className="border-b border-border bg-panel px-4 py-2 text-xs text-text-muted">
      <summary className="cursor-pointer select-none">
        <span className="font-mono text-text">{t('pipeline.title')}</span>
        <span className="ms-3 inline-flex flex-wrap gap-x-4">
          {queueCell(t('pipeline.dedup'), queues.deduplication)}
          {queueCell(t('pipeline.translation'), queues.translation)}
          {queueCell(t('pipeline.classification'), queues.classification)}
          <span>
            {t('pipeline.endToEnd')} p50 {formatDuration(latencySeconds.end_to_end.p50)}
          </span>
        </span>
        {tg.floodWaitActiveUntil && (
          <span className="ms-3 text-priority-high">
            {t('pipeline.floodWait', { until: new Date(tg.floodWaitActiveUntil).toLocaleTimeString() })}
          </span>
        )}
      </summary>

      <div className="mt-2 space-y-1">
        <div>{t('pipeline.latency')}</div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono">
          {LATENCY_KEYS.map(([key, label]) => (
            <span key={key}>
              {t(`pipeline.${label}`)}: {formatDuration(latencySeconds[key].p50)} / {formatDuration(latencySeconds[key].p95)}
            </span>
          ))}
        </div>
        <div>{t('pipeline.throughput', throughputPerMinute)}</div>
        <div>
          {t('pipeline.duplicatesLastHour', {
            unique: dedupLastHour.unique || 0,
            duplicate: dedupLastHour.duplicate || 0,
            update: dedupLastHour.update || 0,
          })}
        </div>
        <div>
          {t('pipeline.ingestion', {
            due: ingestion.sources.due,
            enabled: ingestion.sources.enabled,
            overdue: formatDuration(ingestion.sources.max_overdue_seconds),
            lastFetch: ageSince(ingestion.sources.last_successful_fetch_at),
            reconnects: tg.reconnects,
            gaps: ingestion.gaps.open,
          })}
        </div>
      </div>
    </details>
  );
}
