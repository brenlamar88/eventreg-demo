// Rendered instead of crashing when the deployment is missing its database
// configuration. Turns an opaque 500 into a checklist.
export function SetupRequired({ missing }: { missing: string[] }) {
  return (
    <div style={{ maxWidth: 640, margin: '8vh auto' }}>
      <h1>Almost there — connect your database</h1>
      <p className="sub">
        The app is deployed and running, but it has no database configured yet.
      </p>
      <div className="card">
        <p style={{ marginTop: 0 }}>
          Missing environment {missing.length === 1 ? 'variable' : 'variables'}:
        </p>
        <p>
          {missing.map((m) => (
            <code key={m} style={{ marginRight: 8 }}>
              {m}
            </code>
          ))}
        </p>
        <ol style={{ paddingLeft: 20, lineHeight: 1.9 }}>
          <li>
            In the Supabase SQL editor, run once:{' '}
            <code>alter role app_user with login password &apos;…&apos;;</code>
          </li>
          <li>
            In Vercel → Settings → Environment Variables, set{' '}
            <code>DATABASE_URL_APP</code> to your Supabase connection string with the{' '}
            <code>app_user</code> role, and <code>DATABASE_URL_ADMIN</code> to the{' '}
            <code>postgres</code> one.
          </li>
          <li>Redeploy, then check <a href="/api/health">/api/health</a>.</li>
        </ol>
        <p className="muted" style={{ marginBottom: 0 }}>
          Full instructions: <code>docs/DEPLOY.md</code> in the repository.
        </p>
      </div>
    </div>
  );
}
