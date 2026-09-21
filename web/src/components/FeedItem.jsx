import { Link } from 'react-router-dom';
import StatusBadge from './StatusBadge';

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
        <StatusBadge status={item.status} />
      </div>
      <p className="line-clamp-3 text-sm text-text">
        {item.raw_text || <span className="text-text-muted italic">No text (media-only post)</span>}
      </p>
      <div className="mt-1 font-mono text-xs text-text-muted">
        {formatTimestamp(item.telegram_date)}
      </div>
    </Link>
  );
}
