import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

const RTL_LANGUAGES = new Set(['ar', 'he', 'fa', 'ur']);

const resources = {
  en: {
    translation: {
      appName: 'Nightbeacon',
      nav: {
        dashboard: 'Dashboard',
        live: 'Live Monitor',
        sources: 'Sources',
        activity: 'Activity',
        settings: 'Settings',
      },
      feed: {
        empty: 'No items match the current filters.',
        loading: 'Loading feed…',
        error: 'Could not load the feed.',
        automatedTranslation: 'Automated translation',
      },
      comingSoon: 'Coming soon',
    },
  },
};

i18n.use(initReactI18next).init({
  resources,
  lng: 'en',
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
});

export function applyDocumentDirection(language) {
  const dir = RTL_LANGUAGES.has(language) ? 'rtl' : 'ltr';
  document.documentElement.dir = dir;
  document.documentElement.lang = language;
}

applyDocumentDirection(i18n.language);
i18n.on('languageChanged', applyDocumentDirection);

export default i18n;
