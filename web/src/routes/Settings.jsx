import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { changeLanguage, SUPPORTED_LANGUAGES } from '../lib/i18n';
import { useUiStore } from '../store/uiStore';
import { useSession } from '../lib/useSession';
import { api } from '../lib/api';

const REFRESH_OPTIONS = [
  { value: 15_000, label: '15s' },
  { value: 30_000, label: '30s' },
  { value: 60_000, label: '1m' },
  { value: 300_000, label: '5m' },
];

export default function Settings() {
  const { t, i18n } = useTranslation();
  const { filters, refreshIntervalMs, setRefreshIntervalMs, clearFilters } = useUiStore();
  const { data: session } = useSession();
  const { data: taxonomy } = useQuery({ queryKey: ['taxonomy'], queryFn: api.taxonomy });

  const activeFilterCount = Object.values(filters).filter(Boolean).length;

  return (
    <div className="mx-auto max-w-xl p-6">
      <h1 className="mb-6 font-mono text-base text-text">{t('settings.title')}</h1>

      <section className="mb-6 rounded border border-border bg-panel p-4">
        <h2 className="mb-1 text-sm font-medium text-text">{t('settings.language')}</h2>
        <p className="mb-3 text-xs text-text-muted">{t('settings.languageHelp')}</p>
        <div className="flex gap-2">
          {SUPPORTED_LANGUAGES.map((lang) => (
            <button
              key={lang.code}
              onClick={() => changeLanguage(lang.code)}
              className={`rounded border px-3 py-1.5 text-sm ${
                i18n.language === lang.code
                  ? 'border-accent text-accent'
                  : 'border-border text-text-muted hover:text-text'
              }`}
            >
              {lang.label}
            </button>
          ))}
        </div>
      </section>

      <section className="mb-6 rounded border border-border bg-panel p-4">
        <h2 className="mb-1 text-sm font-medium text-text">{t('settings.refreshInterval')}</h2>
        <p className="mb-3 text-xs text-text-muted">{t('settings.refreshIntervalHelp')}</p>
        <div className="flex gap-2">
          {REFRESH_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setRefreshIntervalMs(opt.value)}
              className={`rounded border px-3 py-1.5 text-sm ${
                refreshIntervalMs === opt.value
                  ? 'border-accent text-accent'
                  : 'border-border text-text-muted hover:text-text'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </section>

      <section className="mb-6 rounded border border-border bg-panel p-4">
        <h2 className="mb-1 text-sm font-medium text-text">{t('settings.defaultFilters')}</h2>
        <p className="mb-3 text-xs text-text-muted">{t('settings.defaultFiltersHelp')}</p>
        {activeFilterCount === 0 ? (
          <p className="text-sm text-text-muted">{t('settings.noFiltersActive')}</p>
        ) : (
          <button
            onClick={clearFilters}
            className="rounded border border-border px-3 py-1.5 text-sm text-text-muted hover:text-text"
          >
            {t('settings.clearDefaultFilters')} ({activeFilterCount})
          </button>
        )}
      </section>

      <section className="rounded border border-border bg-panel p-4">
        <h2 className="mb-1 text-sm font-medium text-text">{t('settings.pipelineConfig')}</h2>
        <p className="mb-3 text-xs text-text-muted">{t('settings.pipelineConfigHelp')}</p>
        <dl className="grid grid-cols-2 gap-y-1.5 text-xs text-text-muted">
          <dt>{t('settings.operator')}</dt>
          <dd className="text-right text-text">{session?.username || '—'}</dd>
          <dt>{t('settings.translationModel')}</dt>
          <dd className="text-right text-text">server-configured (.env)</dd>
          <dt>Classification categories</dt>
          <dd className="text-right text-text">{taxonomy?.categories?.length ?? '—'}</dd>
        </dl>
      </section>
    </div>
  );
}
