import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useUiStore } from '../store/uiStore';

const STATUS_OPTIONS = [
  '', 'new', 'translating', 'translated', 'failed_translation', 'tagging', 'ready', 'failed_tagging',
];

export default function FilterBar() {
  const { filters, setFilter, clearFilters } = useUiStore();
  const { data: sources } = useQuery({ queryKey: ['sources'], queryFn: api.sources });

  const hasActiveFilters = Object.values(filters).some(Boolean);

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border bg-panel px-4 py-3">
      <select
        value={filters.source}
        onChange={(e) => setFilter('source', e.target.value)}
        className="rounded border border-border bg-panel-raised px-2 py-1 text-sm text-text"
      >
        <option value="">All sources</option>
        {(sources || []).map((s) => (
          <option key={s.id} value={s.id}>
            {s.display_name}
          </option>
        ))}
      </select>

      <select
        value={filters.status}
        onChange={(e) => setFilter('status', e.target.value)}
        className="rounded border border-border bg-panel-raised px-2 py-1 text-sm text-text"
      >
        {STATUS_OPTIONS.map((s) => (
          <option key={s} value={s}>
            {s === '' ? 'All statuses' : s}
          </option>
        ))}
      </select>

      {hasActiveFilters && (
        <button
          onClick={clearFilters}
          className="rounded px-2 py-1 text-sm text-text-muted hover:text-text"
        >
          Clear filters
        </button>
      )}
    </div>
  );
}
