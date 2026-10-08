import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

const RTL_LANGUAGES = new Set(['ar', 'he', 'fa', 'ur']);
const STORAGE_KEY = 'nightbeacon-language';

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
        slowNetwork: 'Still waiting for the server…',
        error: 'Could not load the feed.',
        automatedTranslation: 'Automated translation',
        lastUpdated: 'Last updated: {{time}}',
        refresh: 'Refresh',
        refreshing: 'Refreshing…',
        offline: 'Offline — showing cached data',
        stale: 'Stale',
        posted: 'Posted',
      },
      live: {
        checkedAgo: 'Checked {{seconds}}s ago · next check in {{nextIn}}s',
        priorityLabel: 'Priority:',
        priorityAll: 'All',
        newItems: '{{count}} new item — show',
        newItems_other: '{{count}} new items — show',
      },
      filters: {
        allSources: 'All sources',
        searchSources: 'Search sources…',
        noSourcesMatch: 'No sources match.',
      },
      settings: {
        title: 'Settings',
        language: 'Language',
        languageHelp: 'Changes the interface language and text direction.',
        refreshInterval: 'Feed refresh interval',
        refreshIntervalHelp:
          'How often the dashboard polls for new items. Nightbeacon is a scheduled-polling system, not a live push feed — this only controls how often the browser checks.',
        defaultFilters: 'Default filters',
        defaultFiltersHelp: 'Your current dashboard filters, remembered for next time.',
        noFiltersActive: 'No filters currently active.',
        clearDefaultFilters: 'Clear saved filters',
        pipelineConfig: 'Pipeline configuration (read-only)',
        pipelineConfigHelp:
          'Set via server environment variables — never exposed in the browser for security.',
        translationModel: 'Translation model',
        operator: 'Operator',
      },
      comingSoon: 'Coming soon',
    },
  },
  ar: {
    translation: {
      appName: 'نايت بيكون',
      nav: {
        dashboard: 'لوحة التحكم',
        live: 'المراقبة الحية',
        sources: 'المصادر',
        activity: 'النشاط',
        settings: 'الإعدادات',
      },
      feed: {
        empty: 'لا توجد عناصر مطابقة للمرشحات الحالية.',
        loading: 'جارٍ تحميل الموجز…',
        slowNetwork: 'لا يزال في انتظار الخادم…',
        error: 'تعذر تحميل الموجز.',
        automatedTranslation: 'ترجمة آلية',
        lastUpdated: 'آخر تحديث: {{time}}',
        refresh: 'تحديث',
        refreshing: 'جارٍ التحديث…',
        offline: 'غير متصل — يتم عرض بيانات مخزنة',
        stale: 'قديم',
        posted: 'نُشر',
      },
      live: {
        checkedAgo: 'تم الفحص منذ {{seconds}} ث · الفحص التالي خلال {{nextIn}} ث',
        priorityLabel: 'الأولوية:',
        priorityAll: 'الكل',
        newItems: 'عنصر جديد واحد — عرض',
        newItems_other: '{{count}} عناصر جديدة — عرض',
      },
      filters: {
        allSources: 'كل المصادر',
        searchSources: 'ابحث عن مصدر…',
        noSourcesMatch: 'لا توجد مصادر مطابقة.',
      },
      settings: {
        title: 'الإعدادات',
        language: 'اللغة',
        languageHelp: 'يغيّر لغة الواجهة واتجاه النص.',
        refreshInterval: 'فاصل تحديث الموجز',
        refreshIntervalHelp:
          'عدد مرات فحص لوحة التحكم بحثًا عن عناصر جديدة. نايت بيكون نظام استطلاع مجدول وليس بثًا حيًا — هذا يتحكم فقط في وتيرة الفحص من المتصفح.',
        defaultFilters: 'المرشحات الافتراضية',
        defaultFiltersHelp: 'مرشحات لوحة التحكم الحالية، محفوظة للمرة القادمة.',
        noFiltersActive: 'لا توجد مرشحات مفعّلة حاليًا.',
        clearDefaultFilters: 'مسح المرشحات المحفوظة',
        pipelineConfig: 'إعدادات خط المعالجة (للقراءة فقط)',
        pipelineConfigHelp: 'تُضبط عبر متغيرات بيئة الخادم — لا تُعرض أبدًا في المتصفح لأسباب أمنية.',
        translationModel: 'نموذج الترجمة',
        operator: 'المشغّل',
      },
      comingSoon: 'قريبًا',
    },
  },
};

i18n.use(initReactI18next).init({
  resources,
  lng: localStorage.getItem(STORAGE_KEY) || 'en',
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
});

export function applyDocumentDirection(language) {
  const dir = RTL_LANGUAGES.has(language) ? 'rtl' : 'ltr';
  document.documentElement.dir = dir;
  document.documentElement.lang = language;
}

export function changeLanguage(language) {
  i18n.changeLanguage(language);
  localStorage.setItem(STORAGE_KEY, language);
}

export const SUPPORTED_LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'ar', label: 'العربية' },
];

applyDocumentDirection(i18n.language);
i18n.on('languageChanged', applyDocumentDirection);

export default i18n;
