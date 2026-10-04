import { X } from 'lucide-react';
import { useUi } from '../../state/ui';

export function Toasts() {
  const { toasts, dismissToast } = useUi();
  return (
    <div className="toasts" role="status">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          <span className="grow">{t.message}</span>
          <button className="icon-btn" onClick={() => dismissToast(t.id)} aria-label="Dismiss">
            <X size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}
