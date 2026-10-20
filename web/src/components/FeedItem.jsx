import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import StatusBadge from './StatusBadge';
import PriorityBadge, { CategoryBadge } from './PriorityBadge';

function formatTimestamp(iso) {
  if (!iso) return '—';
  // Explicit date + time, not just a relative locale string — this is the
  // Telegram-reported post time specifically (telegram_date), not when
  // Nightbeacon collected it, and that distinction matters enough (see
  // docs/DATABASE.md on feed ordering) to spell out rather than leave
  // ambiguous.
  return new Date(iso).toLocaleString(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

// Shown immediately, before dedup/translation finish: the post is visible as
// soon as it's persisted, with its processing state spelled out rather than
// hidden until it's "ready".
function DedupBadge({ item }) {
  const { t } = useTranslation();
  const base = 'rounded border px-1.5 py-0.5 font-mono text-xs';
  if (item.dedup_status === 'pending') {
    return <span className={`${base} border-border text-text-muted`}>{t('feed.checkingDuplicates')}</span>;
  }
  if (item.dedup_status === 'update') {
    return <span className={`${base} border-accent text-accent`}>{t('feed.storyUpdate')}</span>;
  }
  if (item.story_item_count > 1) {
    return (
      <span className={`${base} border-border text-text-muted`} title={t('feed.reportedByTitle')}>
        {t('feed.reportedBy', { count: item.story_item_count })}
      </span>
    );
  }
  return null;
}

export default function FeedItem({ item }) {
  const { t } = useTranslation();
  return (
    <Link
      to={`/content/${item.id}`}
      className="block border-b border-border px-4 py-3 hover:bg-panel-raised"
    >
      <div className="mb-1 flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2 font-mono text-xs text-text-muted">
          <span className="truncate">{item.display_name}</span>
          <span>·</span>
          <span>@{item.channel_username}</span>
          <span>·</span>
          <span>#{item.telegram_message_id}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <DedupBadge item={item} />
          <CategoryBadge category={item.category} />
          <PriorityBadge priority={item.priority} />
          <StatusBadge status={item.status} />
        </div>
      </div>
      <p className="line-clamp-3 text-sm text-text">
        {item.raw_text || <span className="text-text-muted italic">No text (media-only post)</span>}
      </p>
      {item.translation_status === 'done' && item.translated_text && (
        <p className="mt-1 line-clamp-2 border-s-2 border-accent/40 ps-2 text-sm text-text-muted">
          <span className="mr-1 font-mono text-[10px] uppercase tracking-wide text-accent">
            {t('feed.automatedTranslation')}
          </span>
          <br />
          {item.translated_text}
        </p>
      )}
      <div className="mt-1 flex items-center gap-1 font-mono text-xs text-text-muted">
        <span className="uppercase tracking-wide">{t('feed.posted')}</span>
        <span>{formatTimestamp(item.telegram_date)}</span>
      </div>
    </Link>
  );
}
