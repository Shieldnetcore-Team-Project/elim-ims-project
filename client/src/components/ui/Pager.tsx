export function Pager({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (page: number) => void }) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  if (pageCount <= 1) return null;

  const pages = Array.from({ length: pageCount }, (_, i) => i + 1)
    .filter(p => p === 1 || p === pageCount || Math.abs(p - page) <= 1);

  let prev = 0;
  return (
    <div className="pager">
      {pages.map(p => {
        const gap = p - prev > 1;
        prev = p;
        return (
          <span key={p} style={{ display: 'contents' }}>
            {gap && <span className="sub" style={{ padding: '0 4px' }}>…</span>}
            <button className={p === page ? 'on' : ''} onClick={() => onPage(p)} aria-current={p === page ? 'page' : undefined}>{p}</button>
          </span>
        );
      })}
    </div>
  );
}
