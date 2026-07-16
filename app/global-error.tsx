'use client';

// Fallback for errors thrown in the root layout itself (e.g. getUser() when
// Supabase env is misconfigured). Must render its own <html>/<body>.
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body style={{ fontFamily: 'system-ui, sans-serif', maxWidth: 640, margin: '10vh auto', padding: 24 }}>
        <h1>Something went wrong</h1>
        <p>A server error occurred while loading the app shell.</p>
        <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', background: '#f4f4f4', padding: 12, borderRadius: 8 }}>
          {error.message || 'Unknown error'}
          {error.digest ? `\n\ndigest: ${error.digest}` : ''}
        </pre>
        <button onClick={reset}>Try again</button>
      </body>
    </html>
  );
}
