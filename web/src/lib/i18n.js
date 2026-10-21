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
        publishing: 'Publishing',
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
        checkingDuplicates: 'Checking duplicates',
        storyUpdate: 'Story update',
        reportedBy: '{{count}} sources',
        reportedByTitle: 'Same story reported by multiple channels — open for the full list',
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
      publishing: {
        mode: 'Mode',
        modes: { off: 'Manual drafts only', review: 'Auto-draft, you approve', auto: 'Auto-post high priority' },
        channels: 'Channels',
        delivery: { bot: 'bot posts', manual: 'you post' },
        allChannels: 'All channels',
        copy: 'Copy', copied: 'Copied ✓', markSent: 'Mark as sent',
        forMyChannels: 'Drafts for my channels',
        draftMissing: 'Draft missing channels',
        pace: 'At most 1 post per {{seconds}}s',
        lastSent: 'Last sent: {{time}}',
        paused: 'Telegram asked the bot to wait until {{time}}',
        lastError: 'Last send error: {{error}}',
        noChannel: 'No channels configured — create server/publish-channels.json (see publish-channels.example.json) or set PUBLISH_CHANNEL',
        noBot: 'TELEGRAM_BOT_TOKEN is not set — approved posts will wait',
        groups: { drafts: 'Drafts', queue: 'Queued', published: 'Published', closed: 'Rejected / failed' },
        empty: {
          drafts: 'No drafts. Use “Draft post” on any item, or set PUBLISH_MODE=review to draft important stories automatically.',
          queue: 'Nothing waiting to be sent.',
          published: 'Nothing published yet.',
          closed: 'Nothing rejected, failed or expired.',
        },
        status: {
          requested: 'Waiting for draft', drafting: 'Drafting…', draft: 'Draft', approved: 'Queued', sending: 'Sending…',
          published: 'Published', sent_manually: 'Sent manually', rejected: 'Rejected', failed: 'Failed', expired: 'Expired',
        },
        drafting: 'Writing a draft in your channel’s style…',
        approve: 'Approve & queue', save: 'Save edit', redraft: 'Redraft', reject: 'Reject', retry: 'Retry',
        showSource: 'Show source', hideSource: 'Hide source', openItem: 'open item',
        score: 'score {{score}}', scoreTitle: 'Why this story was picked: {{detail}}',
        publishedAt: 'Published {{time}}',
        draftPost: 'Draft for my channels',
        draftRequested: 'Draft requested — see Publishing',
      },
      pipeline: {
        title: 'Pipeline',
        queues: 'Queues',
        dedup: 'Dedup',
        translation: 'Translation',
        classification: 'Classification',
        oldest: 'oldest {{age}}',
        latency: 'Latency p50 / p95 (last hour)',
        telegramToObserved: 'Telegram → seen',
        observedToCommitted: 'seen → saved',
        committedToDeduped: 'saved → deduped',
        dedupedToTranslated: 'deduped → translated',
        translatedToReady: 'translated → ready',
        endToEnd: 'end to end',
        throughput: 'Per minute (15m): {{ingested}} in · {{deduped}} deduped · {{translated}} translated · {{ready}} ready',
        ingestion: 'Ingestion: {{due}}/{{enabled}} sources due · max overdue {{overdue}} · last fetch {{lastFetch}} · reconnects {{reconnects}} · open gaps {{gaps}}',
        floodWait: 'Telegram flood-wait active until {{until}}',
        route: 'Telegram route: {{route}} · proxy failovers since start: {{failovers}}',
        notConnected: 'not connected',
        duplicatesLastHour: 'Dedup (last hour): {{unique}} unique · {{duplicate}} duplicates · {{update}} updates',
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
        publishing: 'النشر',
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
        checkingDuplicates: 'جارٍ فحص التكرار',
        storyUpdate: 'تحديث للخبر',
        reportedBy: '{{count}} مصادر',
        reportedByTitle: 'الخبر نفسه نشرته عدة قنوات — افتحه لعرض القائمة الكاملة',
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
      publishing: {
        mode: 'الوضع',
        modes: { off: 'مسودات يدوية فقط', review: 'مسودات تلقائية بموافقتك', auto: 'نشر تلقائي للأولوية العالية' },
        channels: 'القنوات',
        delivery: { bot: 'ينشرها البوت', manual: 'تنشرها أنت' },
        allChannels: 'كل القنوات',
        copy: 'نسخ', copied: 'تم النسخ ✓', markSent: 'تحديد كمرسل',
        forMyChannels: 'مسودات لقنواتي',
        draftMissing: 'صياغة القنوات الناقصة',
        pace: 'منشور واحد كل {{seconds}} ثانية كحد أقصى',
        lastSent: 'آخر إرسال: {{time}}',
        paused: 'طلب تيليجرام من البوت الانتظار حتى {{time}}',
        lastError: 'آخر خطأ في الإرسال: {{error}}',
        noChannel: 'لا توجد قنوات — أنشئ server/publish-channels.json أو اضبط PUBLISH_CHANNEL',
        noBot: 'لم يتم ضبط TELEGRAM_BOT_TOKEN — المنشورات المعتمدة ستنتظر',
        groups: { drafts: 'المسودات', queue: 'في الانتظار', published: 'المنشورة', closed: 'مرفوضة / فاشلة' },
        empty: {
          drafts: 'لا توجد مسودات. استخدم «مسودة منشور» على أي عنصر، أو اضبط PUBLISH_MODE=review.',
          queue: 'لا شيء بانتظار الإرسال.',
          published: 'لم يُنشر شيء بعد.',
          closed: 'لا شيء مرفوض أو فاشل أو منتهي.',
        },
        status: {
          requested: 'بانتظار المسودة', drafting: 'جارٍ الكتابة…', draft: 'مسودة', approved: 'في الطابور', sending: 'جارٍ الإرسال…',
          published: 'منشور', sent_manually: 'أُرسل يدويًا', rejected: 'مرفوض', failed: 'فشل', expired: 'منتهي',
        },
        drafting: 'جارٍ كتابة مسودة بأسلوب قناتك…',
        approve: 'اعتماد وإضافة للطابور', save: 'حفظ التعديل', redraft: 'إعادة الصياغة', reject: 'رفض', retry: 'إعادة المحاولة',
        showSource: 'عرض المصدر', hideSource: 'إخفاء المصدر', openItem: 'فتح العنصر',
        score: 'النقاط {{score}}', scoreTitle: 'سبب اختيار هذا الخبر: {{detail}}',
        publishedAt: 'نُشر {{time}}',
        draftPost: 'مسودات لقنواتي',
        draftRequested: 'تم طلب المسودة — راجع صفحة النشر',
      },
      pipeline: {
        title: 'خط المعالجة',
        queues: 'قوائم الانتظار',
        dedup: 'إزالة التكرار',
        translation: 'الترجمة',
        classification: 'التصنيف',
        oldest: 'الأقدم {{age}}',
        latency: 'زمن الوصول p50 / p95 (آخر ساعة)',
        telegramToObserved: 'تيليجرام ← الرصد',
        observedToCommitted: 'الرصد ← الحفظ',
        committedToDeduped: 'الحفظ ← فحص التكرار',
        dedupedToTranslated: 'فحص التكرار ← الترجمة',
        translatedToReady: 'الترجمة ← الجاهزية',
        endToEnd: 'من البداية للنهاية',
        throughput: 'في الدقيقة (15د): {{ingested}} وارد · {{deduped}} مفحوص · {{translated}} مترجم · {{ready}} جاهز',
        ingestion: 'الاستيعاب: {{due}}/{{enabled}} مصدر مستحق · أقصى تأخير {{overdue}} · آخر جلب {{lastFetch}} · إعادة اتصال {{reconnects}} · فجوات مفتوحة {{gaps}}',
        floodWait: 'حظر مؤقت من تيليجرام حتى {{until}}',
        route: 'مسار تيليجرام: {{route}} · تبديلات الوكيل منذ البدء: {{failovers}}',
        notConnected: 'غير متصل',
        duplicatesLastHour: 'التكرار (آخر ساعة): {{unique}} فريد · {{duplicate}} مكرر · {{update}} تحديث',
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
