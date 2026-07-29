import { toneOf } from '@shared/types';

export function Pill({ status }: { status: string }) {
  const tone = toneOf(status);
  return (
    <span className={`pill p-${tone}`}>
      <i />
      {status.replace(/_/g, ' ')}
    </span>
  );
}
