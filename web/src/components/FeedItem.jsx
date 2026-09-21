import { Link } from 'react-router-dom';
import StatusBadge from './StatusBadge';
import PriorityBadge, { CategoryBadge } from './PriorityBadge';

function formatTimestamp(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}

export default function FeedItem({ item }) {
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
            Automated translation
          </span>
          <br />
          {item.translated_text}
        </p>
      )}
      <div className="mt-1 font-mono text-xs text-text-muted">
        {formatTimestamp(item.telegram_date)}
      </div>
    </Link>
  );
}
