import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useUiStore } from '../store/uiStore';
import SourceCombobox from './SourceCombobox';

const STATUS_OPTIONS = [
  '', 'new', 'translating', 'translated', 'failed_translation', 'tagging', 'ready', 'failed_tagging',
];

function titleCase(str) {
  return str.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export default function FilterBar() {
  const { filters, setFilter, clearFilters } = useUiStore();
  const { data: sources } = useQuery({ queryKey: ['sources'], queryFn: api.sources });
  const { data: taxonomy } = useQuery({ queryKey: ['taxonomy'], queryFn: api.taxonomy });

  const hasActiveFilters = Object.values(filters).some(Boolean);

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border bg-panel px-4 py-3">
      <SourceCombobox
        sources={sources}
        value={filters.source}
        onChange={(id) => setFilter('source', id)}
      />

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

      <select
        value={filters.category}
        onChange={(e) => setFilter('category', e.target.value)}
        className="rounded border border-border bg-panel-raised px-2 py-1 text-sm text-text"
      >
        <option value="">All categories</option>
        {(taxonomy?.categories || []).map((c) => (
          <option key={c} value={c}>
            {titleCase(c)}
          </option>
        ))}
      </select>

      <select
        value={filters.priority}
        onChange={(e) => setFilter('priority', e.target.value)}
        className="rounded border border-border bg-panel-raised px-2 py-1 text-sm text-text"
      >
        <option value="">All priorities</option>
        {(taxonomy?.priorities || []).map((p) => (
          <option key={p} value={p}>
            {titleCase(p)}
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
