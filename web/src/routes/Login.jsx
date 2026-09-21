import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';

export default function Login() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const login = useMutation({
    mutationFn: () => api.login(username, password),
    onSuccess: (data) => {
      queryClient.setQueryData(['session'], { authenticated: true, username: data.username });
      navigate('/dashboard', { replace: true });
    },
  });

  function handleSubmit(e) {
    e.preventDefault();
    login.mutate();
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg">
      <form
        onSubmit={handleSubmit}
        noValidate
        className="w-80 rounded border border-border bg-panel p-6"
      >
        <h1 className="mb-1 font-mono text-lg text-text">Nightbeacon</h1>
        <p className="mb-5 text-sm text-text-muted">Operator sign-in</p>

        <label className="mb-3 block text-sm text-text-muted">
          Username
          <input
            className="mt-1 w-full rounded border border-border bg-panel-raised px-3 py-2 text-sm text-text outline-none focus:border-accent"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
            autoFocus
          />
        </label>

        <label className="mb-4 block text-sm text-text-muted">
          Password
          <input
            type="password"
            className="mt-1 w-full rounded border border-border bg-panel-raised px-3 py-2 text-sm text-text outline-none focus:border-accent"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>

        {login.isError && (
          <p className="mb-3 text-sm text-priority-high">Invalid username or password.</p>
        )}

        <button
          type="submit"
          disabled={login.isPending}
          className="w-full rounded bg-accent px-3 py-2 text-sm font-medium text-white disabled:opacity-60"
        >
          {login.isPending ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
