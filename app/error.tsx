'use client';

// Route-level error boundary. Renders a clear message instead of a blank 500,
// and shows the underlying reason (most deploy failures here are a missing or
// wrong DATABASE_URL_APP, or SSL not enabled for a hosted Postgres).
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const isDbConfig =
    /DATABASE_URL|ECONNREFUSED|password authentication|SSL|self-signed|does not exist/i.test(
      error.message,
    );
  return (
    <div style={{ maxWidth: 640, margin: '10vh auto', padding: 24 }}>
      <h1>Something went wrong</h1>
      {isDbConfig ? (
        <p className="sub">
          The app couldn&apos;t reach its database. Check that <code>DATABASE_URL_APP</code> (and{' '}
          <code>DATABASE_URL_ADMIN</code>) are set to your Supabase connection string, and that the
          migrations have been applied.
        </p>
      ) : (
        <p className="sub">An unexpected server error occurred.</p>
      )}
      <div className="card">
        <code style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
          {error.message || 'Unknown error'}
        </code>
        {error.digest && (
          <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>
            digest: {error.digest}
          </p>
        )}
      </div>
      <div className="spacer" />
      <button onClick={reset}>Try again</button>
    </div>
  );
}
