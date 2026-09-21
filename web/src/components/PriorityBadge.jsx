const PRIORITY_TONE = {
  high: 'text-priority-high border-priority-high',
  medium: 'text-priority-medium border-priority-medium',
  low: 'text-priority-low border-priority-low',
  informational: 'text-text-muted border-border',
};

function titleCase(str) {
  return str.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export default function PriorityBadge({ priority }) {
  if (!priority) return null;
  const tone = PRIORITY_TONE[priority] || 'text-text-muted border-border';
  return (
    <span className={`rounded border px-1.5 py-0.5 font-mono text-xs ${tone}`}>
      {titleCase(priority)}
    </span>
  );
}

export function CategoryBadge({ category }) {
  if (!category) return null;
  return (
    <span className="rounded border border-border px-1.5 py-0.5 font-mono text-xs text-text-muted">
      {titleCase(category)}
    </span>
  );
}
