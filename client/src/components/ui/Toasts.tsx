import { useUi } from '../../lib/uiState';

export function Toasts() {
  const { toasts } = useUi();
  return (
    <div className="toasts">
      {toasts.map(t => <div key={t.id} className="toast">{t.message}</div>)}
    </div>
  );
}
