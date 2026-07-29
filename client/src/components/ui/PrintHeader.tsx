import { useEffect, useState } from 'react';
import { todayLagos } from '../../lib/format';

export function PrintHeader() {
  const [date, setDate] = useState('');
  useEffect(() => { setDate(todayLagos.format(new Date())); }, []);
  return (
    <div className="print-only" style={{ marginBottom: 16 }}>
      <p style={{ fontFamily: "'Plus Jakarta Sans'", fontSize: 16, fontWeight: 700 }}>Elim Water Factory Ltd.</p>
      <p style={{ fontSize: 11, color: '#555' }}>Plot 14, Industrial Layout, Idu, Abuja FCT — Dashboard report, {date}</p>
    </div>
  );
}
