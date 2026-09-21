import { useTranslation } from 'react-i18next';

export default function ComingSoon({ title }) {
  const { t } = useTranslation();
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-10 text-center">
      <h1 className="font-mono text-lg text-text">{title}</h1>
      <p className="text-sm text-text-muted">{t('comingSoon')}</p>
    </div>
  );
}
