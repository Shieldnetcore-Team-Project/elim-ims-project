import { useState } from 'react';
import { Icon } from './Icon';
import { RequestDeletionModal } from './RequestDeletionModal';

export function DeleteButton({ entityType, entityId, entityLabel, pending, onRequested }: {
  entityType: string;
  entityId: string;
  entityLabel: string;
  /** true if a PENDING deletion request already exists for this row — see usePendingDeletions() */
  pending?: boolean;
  onRequested: () => void;
}) {
  const [open, setOpen] = useState(false);

  if (pending) {
    return <span className="sub" title="Awaiting admin approval in Delete requests">Pending deletion</span>;
  }

  return (
    <>
      <button
        className="iconbtn" style={{ width: 28, height: 28 }}
        onClick={e => { e.stopPropagation(); setOpen(true); }}
        aria-label={`Request deletion of ${entityLabel}`}
        title="Request deletion"
      >
        <Icon name="trash" size={14} />
      </button>
      {open && (
        // Stops the modal's own clicks (including backdrop-to-close) from bubbling up
        // into a parent row's onClick — the modal renders inline, not in a portal.
        <div onClick={e => e.stopPropagation()}>
          <RequestDeletionModal
            entityType={entityType} entityId={entityId} entityLabel={entityLabel}
            onClose={() => setOpen(false)}
            onRequested={() => { setOpen(false); onRequested(); }}
          />
        </div>
      )}
    </>
  );
}
