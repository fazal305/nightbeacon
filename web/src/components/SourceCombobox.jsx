import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

// A plain <select> stops being usable once there are hundreds of sources —
// no way to type-to-find, just scroll-and-scan. This is a minimal
// search-filtered listbox (no external UI library in this project) that
// keeps the same value/onChange contract as the <select> it replaces.
export default function SourceCombobox({ sources, value, onChange }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const rootRef = useRef(null);
  const inputRef = useRef(null);

  const selected = useMemo(
    () => (sources || []).find((s) => s.id === value) || null,
    [sources, value]
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = sources || [];
    if (!q) return list;
    return list.filter(
      (s) =>
        s.display_name?.toLowerCase().includes(q) ||
        s.channel_username?.toLowerCase().includes(q)
    );
  }, [sources, query]);

  useEffect(() => {
    if (!open) return;
    function handleClickOutside(e) {
      if (rootRef.current && !rootRef.current.contains(e.target)) {
        setOpen(false);
        setQuery('');
      }
    }
    function handleKey(e) {
      if (e.key === 'Escape') {
        setOpen(false);
        setQuery('');
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKey);
    };
  }, [open]);

  function openDropdown() {
    setOpen(true);
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  function select(id) {
    onChange(id);
    setOpen(false);
    setQuery('');
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => (open ? setOpen(false) : openDropdown())}
        className="flex min-w-[10rem] items-center justify-between gap-2 rounded border border-border bg-panel-raised px-2 py-1 text-sm text-text"
      >
        <span className="truncate">
          {selected ? selected.display_name : t('filters.allSources')}
        </span>
        <span className="text-text-muted">▾</span>
      </button>

      {open && (
        <div className="absolute z-20 mt-1 w-64 rounded border border-border bg-panel-raised shadow-lg">
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('filters.searchSources')}
            className="w-full border-b border-border bg-transparent px-2 py-1.5 text-sm text-text outline-none"
          />
          <div className="max-h-64 overflow-y-auto">
            <button
              type="button"
              onClick={() => select('')}
              className={`block w-full px-2 py-1.5 text-left text-sm hover:bg-panel ${
                value === '' ? 'text-accent' : 'text-text'
              }`}
            >
              {t('filters.allSources')}
            </button>
            {filtered.length === 0 && (
              <div className="px-2 py-1.5 text-sm text-text-muted">{t('filters.noSourcesMatch')}</div>
            )}
            {filtered.map((s) => (
              <button
                type="button"
                key={s.id}
                onClick={() => select(s.id)}
                className={`block w-full truncate px-2 py-1.5 text-left text-sm hover:bg-panel ${
                  value === s.id ? 'text-accent' : 'text-text'
                }`}
                title={`${s.display_name} · @${s.channel_username}`}
              >
                {s.display_name}
                <span className="ml-1 text-xs text-text-muted">@{s.channel_username}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
