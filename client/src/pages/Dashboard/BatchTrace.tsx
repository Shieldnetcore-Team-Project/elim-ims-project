import { Fragment, useEffect, useState } from 'react';
import type { TraceStop } from '@shared/types';
import { api } from '../../lib/apiClient';
import { Icon } from '../../components/ui/Icon';

export function BatchTrace({ deliveryId, onClose }: { deliveryId: string; onClose: () => void }) {
  const [trace, setTrace] = useState<TraceStop[] | null>(null);

  useEffect(() => {
    let alive = true;
    setTrace(null);
    api<TraceStop[]>(`/dashboard/trace/${encodeURIComponent(deliveryId)}`).then(t => { if (alive) setTrace(t); });
    return () => { alive = false; };
  }, [deliveryId]);

  return (
    <section className="card" style={{ marginTop: 24 }}>
      <div className="card-head">
        <div><h2 className="card-title">Batch trace</h2><p className="card-desc">Source to customer, in one line.</p></div>
        <button className="btn btn-secondary btn-sm no-print" onClick={onClose}>Close</button>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <div className="trace">
          {trace?.map((s, i) => (
            <Fragment key={s.stage}>
              <div className="stop-col" style={{ animationDelay: `${i * 0.07}s` }}>
                <p className="stop-label">{s.stage}</p>
                <p className="stop-ref">{s.ref}</p>
                <p className="stop-detail">{s.detail}</p>
                {s.verdict ? <span className={`pill p-${s.verdict === 'pass' ? 'ok' : 'stop'}`} style={{ marginTop: 8, width: 'fit-content' }}>QC {s.verdict}</span> : <span style={{ height: 26, display: 'block' }} />}
              </div>
              {trace && i < trace.length - 1 && <div className="chev"><Icon name="chevronRight" size={16} /></div>}
            </Fragment>
          ))}
        </div>
      </div>
      <p style={{ borderTop: '1px solid rgb(var(--line))', padding: '10px 20px', fontSize: 11, color: 'rgb(var(--muted))' }}>
        Full lineage for delivery <span className="mono">{deliveryId}</span> — source to customer.
      </p>
    </section>
  );
}
