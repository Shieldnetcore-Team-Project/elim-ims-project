import { Link } from 'react-router-dom';

export function NotFoundPage() {
  return (
    <div className="empty">
      <h1 style={{ marginTop: 16 }}>Page not found</h1>
      <p className="sub" style={{ marginTop: 6 }}>That screen doesn&apos;t exist in Elim ERP.</p>
      <Link to="/" className="btn btn-secondary btn-sm" style={{ marginTop: 20 }}>Back to Dashboard</Link>
    </div>
  );
}
