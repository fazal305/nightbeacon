import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/api';
import PriorityBadge, { CategoryBadge } from '../components/PriorityBadge';

// Review queue for posts to the operator's channels, one draft per channel in
// that channel's style. Bot channels: approve, then the bot posts at a safe
// pace. Manual channels: copy the text, post it yourself, mark it as sent.
// Statuses: see db/migrations/007_publications.sql.
const GROUPS = ['drafts', 'queue', 'published', 'closed'];

function when(iso) {
  return iso ? new Date(iso).toLocaleString() : '—';
}

function StatusBar({ status, t }) {
  if (!status) return null;
  const problems = [];
  if (status.configError) problems.push(status.configError);
  if (status.channels?.length === 0) problems.push(t('publishing.noChannel'));
  if (status.channels?.some((c) => c.delivery === 'bot') && !status.botConfigured) problems.push(t('publishing.noBot'));
  return (
    <div className="space-y-1 border-b border-border bg-panel px-4 py-2 text-xs text-text-muted">
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        <span>
          {t('publishing.mode')}: <span className="text-text">{t(`publishing.modes.${status.mode}`)}</span>
        </span>
        <span>
          {t('publishing.channels')}:{' '}
          <span className="text-text">
            {(status.channels || []).map((c) => `${c.name} (${t(`publishing.delivery.${c.delivery}`)})`).join(', ') || '—'}
          </span>
        </span>
        <span>{t('publishing.pace', { seconds: status.minIntervalSeconds })}</span>
        <span>{t('publishing.lastSent', { time: when(status.lastSentAt) })}</span>
        {status.pausedUntil && (
          <span className="text-priority-high">{t('publishing.paused', { time: when(status.pausedUntil) })}</span>
        )}
      </div>
      {problems.length > 0 && <div className="text-priority-medium">{problems.join(' · ')}</div>}
      {status.lastError && <div className="text-priority-high">{t('publishing.lastError', { error: status.lastError })}</div>}
    </div>
  );
}

// The source post's photos/videos, fetched from Telegram on request: shown
// as previews with download links, for attaching when posting by hand.
function MediaPanel({ rawItemId, t }) {
  const media = useQuery({
    queryKey: ['itemMedia', rawItemId],
    queryFn: () => api.itemMedia(rawItemId),
    staleTime: 3600_000,
    retry: false,
  });
  if (media.isPending) return <p className="mt-2 text-xs italic text-text-muted">{t('publishing.mediaLoading')}</p>;
  if (media.isError) return <p className="mt-2 text-xs text-priority-high">{media.error.message}</p>;
  const items = media.data.items;
  if (items.length === 0) return <p className="mt-2 text-xs text-text-muted">{t('publishing.mediaNone')}</p>;
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {items.map((m) => (
        <div key={m.index} className="w-40 rounded border border-border bg-panel p-1 text-xs">
          {m.kind === 'photo' ? (
            <img src={api.itemMediaUrl(rawItemId, m.index)} alt="" className="h-28 w-full rounded object-cover" />
          ) : (
            <video src={api.itemMediaUrl(rawItemId, m.index)} controls muted preload="metadata" className="h-28 w-full rounded bg-black" />
          )}
          <a href={api.itemMediaUrl(rawItemId, m.index, true)} className="mt-1 block text-accent hover:underline">
            {t('publishing.mediaDownload', { kind: t(`publishing.mediaKind.${m.kind}`), mb: (m.size / 1048576).toFixed(1) })}
          </a>
        </div>
      ))}
    </div>
  );
}

export function PublicationCard({ pub, t, compact = false }) {
  const queryClient = useQueryClient();
  const [text, setText] = useState(pub.final_text || '');
  const [showSource, setShowSource] = useState(false);
  const [copied, setCopied] = useState(false);
  const [showMedia, setShowMedia] = useState(false);
  const [saved, setSaved] = useState(false);
  const [lastSynced, setLastSynced] = useState(pub.final_text);
  // Server copy changed (e.g. redraft finished): adopt it.
  if (pub.final_text !== lastSynced) {
    setLastSynced(pub.final_text);
    setText(pub.final_text || '');
  }

  const act = useMutation({
    mutationFn: ({ action }) => api.updatePublication(pub.id, { action, text: text.trim() || undefined }),
    onSuccess: (_data, { action }) => {
      if (action === 'save') {
        setSaved(true);
        setTimeout(() => setSaved(false), 3000);
      }
      return queryClient.invalidateQueries({ queryKey: ['publications'] });
    },
  });

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked (e.g. non-HTTPS origin): the text is selectable in the box.
    }
  }

  const manual = pub.delivery === 'manual';
  const digest = pub.kind === 'digest';
  const editable = pub.status === 'draft' || pub.status === 'approved';
  const busy = act.isPending;
  // Edited but not saved yet (Approve / Mark as sent save the edit too).
  const dirty = text.trim() !== (pub.final_text || '').trim();
  const button = (action, label, tone = 'border-border text-text-muted hover:text-text', disabled = false) => (
    <button
      key={action}
      disabled={busy || disabled}
      onClick={() => act.mutate({ action })}
      className={`rounded border px-2 py-1 text-xs disabled:opacity-50 ${tone}`}
    >
      {label}
    </button>
  );

  return (
    <div className="border-b border-border px-4 py-3">
      <div className="mb-2 flex flex-wrap items-center gap-2 font-mono text-xs text-text-muted">
        <span className="rounded border border-accent/50 px-1.5 py-0.5 text-text">
          {pub.channel_name} · {t(`publishing.delivery.${pub.delivery}`)}
        </span>
        <span className="rounded border border-border px-1.5 py-0.5">{t(`publishing.status.${pub.status}`)}</span>
        {digest && (
          <span className="rounded border border-accent px-1.5 py-0.5 text-accent">
            {t('publishing.digest', { time: when(pub.digest_slot) })}
          </span>
        )}
        {digest && pub.score_detail && <span>{pub.score_detail}</span>}
        <PriorityBadge priority={pub.item_priority} />
        <CategoryBadge category={pub.category} />
        {pub.dedup_status === 'update' && <span className="text-accent">{t('feed.storyUpdate')}</span>}
        {pub.story_item_count > 1 && <span>{t('feed.reportedBy', { count: pub.story_item_count })}</span>}
        {pub.score != null && (
          <span className="text-accent" title={t('publishing.scoreTitle', { detail: pub.score_detail || '' })}>
            {t('publishing.score', { score: Math.round(pub.score) })}
          </span>
        )}
        {!compact && !digest && (
          <>
            <span>· @{pub.channel_username} · {when(pub.telegram_date)}</span>
            <Link to={`/content/${pub.raw_item_id}`} className="text-accent hover:underline">
              {t('publishing.openItem')}
            </Link>
          </>
        )}
      </div>

      {pub.status === 'requested' || pub.status === 'drafting' ? (
        <p className="text-sm italic text-text-muted">{t('publishing.drafting')}</p>
      ) : editable ? (
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={Math.min(14, Math.max(4, text.split('\n').length + 1))}
          maxLength={4096}
          dir="auto"
          className="w-full rounded border border-border bg-panel p-2 text-sm text-text"
        />
      ) : (
        <p dir="auto" className="whitespace-pre-wrap text-sm text-text">
          {pub.final_text || pub.draft_text || '—'}
        </p>
      )}

      {editable && dirty && <p className="mt-1 text-xs text-accent">{t('publishing.unsaved')}</p>}
      {saved && !dirty && <p className="mt-1 text-xs text-status-good">{t('publishing.savedNote')}</p>}
      {pub.last_error && <p className="mt-1 text-xs text-priority-high">{pub.last_error}</p>}
      {['published', 'sent_manually'].includes(pub.status) && (
        <p className="mt-1 text-xs text-text-muted">
          {t('publishing.publishedAt', { time: when(pub.published_at) })}
          {pub.media_count > 0 && ` · ${t('publishing.postedWithMedia', { count: pub.media_count })}`}
        </p>
      )}
      {pub.status === 'published' && pub.media_note && <p className="mt-1 text-xs text-priority-medium">{pub.media_note}</p>}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        {editable && manual && (
          <button onClick={copy} className="rounded border border-accent px-2 py-1 text-xs text-accent hover:bg-accent/10">
            {copied ? t('publishing.copied') : t('publishing.copy')}
          </button>
        )}
        {pub.status === 'draft' && [
          manual
            ? button('mark_sent', t('publishing.markSent'), 'border-status-good text-status-good')
            : button('approve', t('publishing.approve'), 'border-accent text-accent hover:bg-accent/10'),
          button('save', saved ? t('publishing.saved') : t('publishing.save'), dirty ? 'border-accent text-accent' : undefined, !dirty),
          !digest && button('redraft', t('publishing.redraft')),
          button('reject', t('publishing.reject'), 'border-priority-high text-priority-high'),
        ]}
        {pub.status === 'approved' && [button('save', saved ? t('publishing.saved') : t('publishing.save'), dirty ? 'border-accent text-accent' : undefined, !dirty), button('reject', t('publishing.reject'), 'border-priority-high text-priority-high')]}
        {['failed', 'expired'].includes(pub.status) && [
          manual
            ? button('mark_sent', t('publishing.markSent'), 'border-status-good text-status-good')
            : button('approve', t('publishing.retry'), 'border-accent text-accent'),
          !digest && button('redraft', t('publishing.redraft')),
        ]}
        {pub.status === 'rejected' && !digest && button('redraft', t('publishing.redraft'))}
        {!compact && !digest && (
          <button onClick={() => setShowSource((v) => !v)} className="text-xs text-text-muted hover:text-text">
            {showSource ? t('publishing.hideSource') : t('publishing.showSource')}
          </button>
        )}
        {pub.has_media && (
          <button onClick={() => setShowMedia((v) => !v)} className="text-xs text-text-muted hover:text-text">
            {showMedia ? t('publishing.hideMedia') : t('publishing.showMedia')}
          </button>
        )}
        {act.isError && <span className="text-xs text-priority-high">{act.error.message}</span>}
      </div>
      {showMedia && <MediaPanel rawItemId={pub.raw_item_id} t={t} />}

      {showSource && !compact && (
        <div className="mt-2 space-y-2 rounded border border-border bg-panel p-2 text-xs">
          <p dir="auto" className="whitespace-pre-wrap text-text">{pub.raw_text}</p>
          {pub.translated_text && pub.translated_text !== pub.raw_text && (
            <p className="whitespace-pre-wrap border-s-2 border-accent/40 ps-2 text-text-muted">{pub.translated_text}</p>
          )}
          <a href={pub.source_url} target="_blank" rel="noreferrer noopener" className="text-accent hover:underline">
            {pub.source_url}
          </a>
        </div>
      )}
    </div>
  );
}

export default function Publishing() {
  const { t } = useTranslation();
  const [group, setGroup] = useState('drafts');
  const [channel, setChannel] = useState('');
  const status = useQuery({ queryKey: ['publications', 'status'], queryFn: api.publicationStatus, refetchInterval: 10_000 });
  const list = useQuery({
    queryKey: ['publications', group, channel],
    queryFn: () => api.publications(channel ? { group, channel } : { group }),
    refetchInterval: 10_000,
  });
  const counts = status.data?.counts || {};
  const groupCount = {
    drafts: (counts.requested || 0) + (counts.drafting || 0) + (counts.draft || 0),
    queue: (counts.approved || 0) + (counts.sending || 0),
    published: (counts.published || 0) + (counts.sent_manually || 0),
    closed: (counts.rejected || 0) + (counts.failed || 0) + (counts.expired || 0),
  };

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border px-4 py-3">
        <h1 className="font-mono text-base text-text">{t('nav.publishing')}</h1>
      </div>
      <StatusBar status={status.data} t={t} />
      <div className="flex flex-wrap gap-2 border-b border-border bg-panel px-4 py-2">
        {GROUPS.map((g) => (
          <button
            key={g}
            onClick={() => setGroup(g)}
            className={`rounded border px-2 py-1 text-xs ${group === g ? 'border-accent text-accent' : 'border-border text-text-muted hover:text-text'}`}
          >
            {t(`publishing.groups.${g}`)} ({groupCount[g]})
          </button>
        ))}
        <select
          value={channel}
          onChange={(e) => setChannel(e.target.value)}
          className="ms-auto rounded border border-border bg-panel px-2 py-1 text-xs text-text"
        >
          <option value="">{t('publishing.allChannels')}</option>
          {(status.data?.channels || []).map((c) => (
            <option key={c.key} value={c.key}>
              {c.name}
            </option>
          ))}
        </select>
      </div>
      <div className="flex-1 overflow-y-auto">
        {list.isLoading && <div className="p-6 text-sm text-text-muted">{t('feed.loading')}</div>}
        {list.isError && <div className="p-6 text-sm text-priority-high">{t('feed.error')}</div>}
        {list.data?.items.length === 0 && <div className="p-6 text-sm text-text-muted">{t(`publishing.empty.${group}`)}</div>}
        {list.data?.items.map((pub) => (
          <PublicationCard key={pub.id} pub={pub} t={t} />
        ))}
      </div>
    </div>
  );
}
