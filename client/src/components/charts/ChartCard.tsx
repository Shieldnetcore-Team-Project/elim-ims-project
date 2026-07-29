import type { ReactNode } from 'react';
import { Card } from '../ui/Card';

export function ChartCard({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <Card title={title} description={description}>
      <div style={{ padding: 20 }}>
        <div style={{ height: 240, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>{children}</div>
      </div>
    </Card>
  );
}
