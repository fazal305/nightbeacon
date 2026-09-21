import { Routes, Route, Navigate } from 'react-router-dom';
import Login from './routes/Login';
import ProtectedRoute from './routes/ProtectedRoute';
import Feed from './routes/Feed';
import Sources from './routes/Sources';
import ContentInspector from './routes/ContentInspector';
import ComingSoon from './components/ComingSoon';
import NotFound from './routes/NotFound';

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/dashboard" replace />} />
      <Route path="/login" element={<Login />} />

      <Route element={<ProtectedRoute />}>
        <Route path="/dashboard" element={<Feed title="Dashboard" />} />
        <Route path="/live" element={<ComingSoon title="Live Monitor" />} />
        <Route path="/sources" element={<Sources />} />
        <Route path="/activity" element={<ComingSoon title="Activity" />} />
        <Route path="/content/:id" element={<ContentInspector />} />
        <Route path="/settings" element={<ComingSoon title="Settings" />} />
      </Route>

      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
