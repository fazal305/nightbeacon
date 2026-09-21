import { Routes, Route, Navigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Login from './routes/Login';
import ProtectedRoute from './routes/ProtectedRoute';
import Feed from './routes/Feed';
import Sources from './routes/Sources';
import SourceInspector from './routes/SourceInspector';
import Activity from './routes/Activity';
import ContentInspector from './routes/ContentInspector';
import Settings from './routes/Settings';
import ComingSoon from './components/ComingSoon';
import NotFound from './routes/NotFound';

export default function App() {
  const { t } = useTranslation();

  return (
    <Routes>
      <Route path="/" element={<Navigate to="/dashboard" replace />} />
      <Route path="/login" element={<Login />} />

      <Route element={<ProtectedRoute />}>
        <Route path="/dashboard" element={<Feed />} />
        <Route path="/live" element={<ComingSoon title={t('nav.live')} />} />
        <Route path="/sources" element={<Sources />} />
        <Route path="/sources/:id" element={<SourceInspector />} />
        <Route path="/activity" element={<Activity />} />
        <Route path="/content/:id" element={<ContentInspector />} />
        <Route path="/settings" element={<Settings />} />
      </Route>

      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
