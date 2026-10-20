// Readable one-line description of a connection/query error. Needed because
// when "localhost" resolves to both ::1 and 127.0.0.1 (the default on
// Windows) and nothing is listening, Node rejects with an AggregateError
// whose own message is empty — the details are only on its inner errors.
export function describeError(err) {
  if (!err) return 'Unknown error';
  if (Array.isArray(err.errors) && err.errors.length > 0) {
    const inner = err.errors.map((e) => e?.message || e?.code || String(e)).join('; ');
    return err.message ? `${err.message} (${inner})` : inner;
  }
  return err.message || err.code || String(err);
}

// Extra guidance for the most common local-setup failure.
export function connectionHint(err) {
  const codes = [err?.code, ...(err?.errors || []).map((e) => e?.code)];
  return codes.includes('ECONNREFUSED')
    ? 'Nothing is accepting connections at the host/port in DATABASE_URL — is PostgreSQL running, and on that port?'
    : null;
}
