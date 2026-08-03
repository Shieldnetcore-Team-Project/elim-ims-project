import { useState } from 'react';
import { Icon } from './Icon';
import { ReverseModal } from './ReverseModal';

export function ReverseButton({ entityType, entityId, entityLabel, reversed, onReversed }: {
  entityType: string;
  entityId: string;
  entityLabel: string;
  /** true if this row already has a reversals row — see useReversedEntities() */
  reversed?: boolean;
  onReversed: () => void;
}) {
  const [open, setOpen] = useState(false);

  if (reversed) {
    return <span className="sub" title="A reversing entry has already been posted for this">Reversed</span>;
  }

  return (
    <>
      <button
        className="iconbtn" style={{ width: 28, height: 28 }}
        onClick={e => { e.stopPropagation(); setOpen(true); }}
        aria-label={`Reverse ${entityLabel}`}
        title="Reverse transaction"
      >
        <Icon name="switch" size={14} />
      </button>
      {open && (
        // Same reasoning as DeleteButton: stop the modal's clicks bubbling into a
        // parent row's onClick — it renders inline, not in a portal.
        <div onClick={e => e.stopPropagation()}>
          <ReverseModal
            entityType={entityType} entityId={entityId} entityLabel={entityLabel}
            onClose={() => setOpen(false)}
            onReversed={() => { setOpen(false); onReversed(); }}
          />
        </div>
      )}
    </>
  );
}
