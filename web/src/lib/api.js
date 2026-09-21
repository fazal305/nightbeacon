const BASE = '/api';

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function request(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });

  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = await res.json();
      if (body.error) message = body.error;
    } catch {
      // ignore non-JSON error bodies
    }
    // A 401 on any authenticated endpoint means the session expired mid-use
    // (login itself never reaches this branch on bad credentials — it's a
    // distinct 401 path handled by the caller). Signal it directly rather
    // than relying on a query-library callback, so every consumer reacts
    // consistently regardless of which query triggered it.
    if (res.status === 401 && !path.startsWith('/auth/')) {
      window.dispatchEvent(new CustomEvent('nightbeacon:session-expired'));
    }
    throw new ApiError(message, res.status);
  }

  if (res.status === 204) return null;
  return res.json();
}

export const api = {
  login: (username, password) =>
    request('/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
  logout: () => request('/auth/logout', { method: 'POST' }),
  session: () => request('/auth/session'),
  items: (params = {}) => {
    const qs = new URLSearchParams(
      Object.fromEntries(Object.entries(params).filter(([, v]) => v != null && v !== ''))
    ).toString();
    return request(`/items${qs ? `?${qs}` : ''}`);
  },
  item: (id) => request(`/items/${id}`),
  sources: () => request('/sources'),
  source: (id) => request(`/sources/${id}`),
  taxonomy: () => request('/taxonomy'),
  subsystems: () => request('/subsystems'),
  activity: (params = {}) => {
    const qs = new URLSearchParams(
      Object.fromEntries(Object.entries(params).filter(([, v]) => v != null && v !== ''))
    ).toString();
    return request(`/activity${qs ? `?${qs}` : ''}`);
  },
  health: () => request('/health'),
};

export { ApiError };
