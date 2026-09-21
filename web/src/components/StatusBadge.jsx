const STATUS_LABEL = {
  new: 'New',
  translating: 'Translating',
  translated: 'Translated',
  failed_translation: 'Translation failed',
  tagging: 'Tagging',
  ready: 'Ready',
  failed_tagging: 'Tagging failed',
};

const STATUS_TONE = {
  new: 'text-text-muted border-border',
  translating: 'text-priority-medium border-priority-medium',
  translated: 'text-status-good border-status-good',
  failed_translation: 'text-priority-high border-priority-high',
  tagging: 'text-priority-medium border-priority-medium',
  ready: 'text-status-good border-status-good',
  failed_tagging: 'text-priority-high border-priority-high',
};

export default function StatusBadge({ status }) {
  const tone = STATUS_TONE[status] || 'text-text-muted border-border';
  return (
    <span className={`rounded border px-1.5 py-0.5 font-mono text-xs ${tone}`}>
      {STATUS_LABEL[status] || status}
    </span>
  );
}
