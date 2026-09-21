import { Link } from 'react-router-dom';

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-bg text-center">
      <h1 className="font-mono text-3xl text-text">404</h1>
      <p className="text-text-muted">This route doesn't exist.</p>
      <Link to="/dashboard" className="text-sm text-accent underline">
        Back to dashboard
      </Link>
    </div>
  );
}
