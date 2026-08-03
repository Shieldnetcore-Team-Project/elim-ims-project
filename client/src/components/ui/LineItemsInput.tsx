import { Icon } from './Icon';
import { NumberInput } from './NumberInput';

export interface LineItemValue { itemId: string; quantity: string; unitPrice: string; bagQuantity?: string }
export interface LineItemOption { id: string; name: string; unit_cost?: number; pieces_per_bag?: number | null }

export function LineItemsInput({ items, options, onChange }: {
  items: LineItemValue[];
  options: LineItemOption[];
  onChange: (items: LineItemValue[]) => void;
}) {
  function update(i: number, patch: Partial<LineItemValue>) {
    onChange(items.map((it, idx) => (idx === i ? { ...it, ...patch } : it)));
  }
  function add() {
    const first = options[0];
    onChange([...items, {
      itemId: first?.id ?? '', quantity: '1', unitPrice: first?.unit_cost != null ? String(first.unit_cost) : '0',
      bagQuantity: first?.pieces_per_bag ? '1' : undefined,
    }]);
  }
  function remove(i: number) {
    onChange(items.filter((_, idx) => idx !== i));
  }

  return (
    <div className="form-row">
      <label>Line items</label>
      {items.map((it, i) => {
        const option = options.find(o => o.id === it.itemId);
        const piecesPerBag = option?.pieces_per_bag;
        return (
          <div className="lineitem-row" key={i}>
            <div style={{ flex: 2 }}>
              <select
                aria-label="Item" value={it.itemId}
                onChange={e => {
                  const opt = options.find(o => o.id === e.target.value);
                  update(i, {
                    itemId: e.target.value,
                    unitPrice: opt?.unit_cost != null ? String(opt.unit_cost) : it.unitPrice,
                    bagQuantity: opt?.pieces_per_bag ? (it.bagQuantity ?? '1') : undefined,
                  });
                }}
              >
                {options.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
              </select>
            </div>
            {piecesPerBag ? (
              <>
                <div style={{ width: 90 }}>
                  <NumberInput ariaLabel="Bags" allowDecimal={false} value={it.bagQuantity ?? '1'}
                    onChange={v => update(i, { bagQuantity: v, quantity: String(Number(v || 0) * piecesPerBag) })} required />
                </div>
                <p className="sub" style={{ width: 110, fontSize: 12 }}>
                  = {(Number(it.bagQuantity || 0) * piecesPerBag).toLocaleString('en-NG')} pcs
                </p>
              </>
            ) : (
              <div style={{ width: 90 }}>
                <NumberInput ariaLabel="Quantity" allowDecimal={false} value={it.quantity} onChange={v => update(i, { quantity: v })} required />
              </div>
            )}
            <div style={{ width: 130 }}>
              <NumberInput ariaLabel="Unit price" value={it.unitPrice} onChange={v => update(i, { unitPrice: v })} required />
            </div>
            <button type="button" className="iconbtn" onClick={() => remove(i)} aria-label="Remove line item" disabled={items.length <= 1}>
              <Icon name="x" size={16} />
            </button>
          </div>
        );
      })}
      <button type="button" className="btn btn-secondary btn-sm" onClick={add} style={{ marginTop: 4 }}>
        <Icon name="plus" size={12} /> Add line
      </button>
    </div>
  );
}
