'use client';

// Dialogs for the Transactions screen. Financial fields are immutable after
// creation/import: these dialogs only VIEW a transaction, edit its notes, or
// confirm a safety-checked delete (src/lib/transactionDeleteSafety.ts). None of
// them renders an input for a financial field.

import { useState, type ReactNode } from 'react';
import { formatCurrency } from '@/lib/formatCurrency';
import type { DeleteAssessment, TransferLink } from '@/lib/transactionDeleteSafety';

export type TransactionView = {
  id: string;
  portfolio_name: string;
  ticker: string;
  type: string;
  date: string | null;
  created_at: string | null;
  quantity: number | null;
  price: number | null;
  fee: number | null;
  cash_value: number | null;
  cash_ccy: string | null;
  settle_value: number | null;
  settle_ccy: string | null;
  cash_fx_to_portfolio: number | null;
  split_factor: number | null;
  notes: string | null;
};

/** 'unknown' when transfer records could not be read. */
export type TransferLinkState = TransferLink | null | 'unknown';

const dash = '—';

const stored = (v: number | null | undefined) => (v == null ? dash : String(v));

function withCcy(v: number | null | undefined, ccy: string | null | undefined) {
  if (v == null) return dash;
  return ccy ? `${v} ${ccy}` : String(v);
}

function formatDateOnly(iso: string | null) {
  if (!iso) return dash;
  const d = iso.slice(0, 10);
  const [y, m, day] = d.split('-');
  return y && m && day ? `${day}-${m}-${y}` : iso;
}

function formatDateTime(iso: string | null) {
  if (!iso) return dash;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

export function transferLinkLabel(link: TransferLinkState): string {
  if (link === 'unknown') return 'Unknown (transfer records could not be read)';
  if (!link) return 'Not linked to a transfer';
  return `Linked to a transfer — ${link.leg === 'out' ? 'outgoing' : 'incoming'} side, status ${link.status}`;
}

/** Plain-English cash effect, with the direction deleting would move cash. */
export function describeCashEffect(cashEffect: DeleteAssessment['cashEffect']): string[] {
  if (cashEffect.length === 0) return ['This transaction has no effect on portfolio cash.'];
  return cashEffect.map((c) => {
    const now = formatCurrency(c.amount, c.currency);
    const reversed = formatCurrency(-c.amount, c.currency);
    const signedReversed = -c.amount > 0 ? `+${reversed}` : reversed;
    return `Cash effect: ${now} (${c.currency}). Deleting it changes ${c.currency} cash by ${signedReversed}.`;
  });
}

function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50" role="dialog" aria-modal="true" aria-label={title}>
      <div className="bg-background rounded p-6 w-full max-w-lg shadow-xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-start justify-between mb-4">
          <h3 className="text-lg font-semibold">{title}</h3>
          <button onClick={onClose} className="text-foreground/60 hover:text-foreground px-2" aria-label="Close">✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function TransactionFields({ tx, transferLink }: { tx: TransactionView; transferLink: TransferLinkState }) {
  const rows: [string, string][] = [
    ['Portfolio', tx.portfolio_name],
    ['Ticker', tx.ticker],
    ['Type', tx.type],
    ['Transaction date', formatDateOnly(tx.date)],
    ['Created', formatDateTime(tx.created_at)],
    ['Quantity', stored(tx.quantity)],
    ['Price', stored(tx.price)],
    ['Fee', stored(tx.fee)],
    ['Cash value', withCcy(tx.cash_value, tx.cash_ccy)],
    ['Settle value', withCcy(tx.settle_value, tx.settle_ccy)],
    ['FX rate (cash_fx_to_portfolio)', stored(tx.cash_fx_to_portfolio)],
    ['Split factor', stored(tx.split_factor)],
    ['Notes', tx.notes && tx.notes !== '' ? tx.notes : dash],
    ['Transfer link', transferLinkLabel(transferLink)],
  ];
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm" data-testid="transaction-fields">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-foreground/70">{k}</dt>
          <dd className="font-mono break-all">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function TransactionDetailsDialog({
  tx,
  transferLink,
  onClose,
}: {
  tx: TransactionView;
  transferLink: TransferLinkState;
  onClose: () => void;
}) {
  return (
    <Modal title="Transaction details" onClose={onClose}>
      <TransactionFields tx={tx} transferLink={transferLink} />
      <p className="text-xs text-foreground/60 mt-4">
        Financial details cannot be edited. If this transaction is wrong, delete it and add or import the corrected one.
      </p>
      <div className="flex justify-end mt-4">
        <button onClick={onClose} className="px-4 py-2 rounded bg-gray-back text-foreground hover:bg-Thoverlight-tint">Close</button>
      </div>
    </Modal>
  );
}

export function EditNotesDialog({
  tx,
  saving,
  error,
  onSave,
  onClose,
}: {
  tx: TransactionView;
  saving: boolean;
  error: string | null;
  onSave: (notes: string) => void;
  onClose: () => void;
}) {
  const [notes, setNotes] = useState(tx.notes ?? '');
  return (
    <Modal title="Edit notes" onClose={onClose}>
      <p className="text-sm text-foreground/70 mb-3">
        {formatDateOnly(tx.date)} · {tx.portfolio_name} · {tx.ticker} · {tx.type}
      </p>
      <label className="block text-sm mb-1" htmlFor="tx-notes">Notes</label>
      <textarea
        id="tx-notes"
        name="notes"
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        rows={3}
        className="border px-2 py-1 w-full rounded"
      />
      <p className="text-xs text-foreground/60 mt-1">Only the notes are saved. Financial details cannot be edited.</p>
      {error && <p className="text-sm text-tred mt-3" role="alert">{error}</p>}
      <div className="flex justify-end gap-2 mt-4">
        <button onClick={onClose} className="px-4 py-2 rounded bg-gray-back text-foreground hover:bg-Thoverlight-tint">Cancel</button>
        <button
          onClick={() => onSave(notes)}
          disabled={saving}
          className="px-4 py-2 rounded bg-themeblue text-white hover:bg-themeblue-hover disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save notes'}
        </button>
      </div>
    </Modal>
  );
}

export type DeleteDialogState =
  | { phase: 'checking' }
  | { phase: 'ready'; assessment: DeleteAssessment }
  | { phase: 'error'; message: string };

export function DeleteTransactionDialog({
  tx,
  state,
  deleting,
  error,
  onConfirm,
  onClose,
}: {
  tx: TransactionView;
  state: DeleteDialogState;
  deleting: boolean;
  error: string | null;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const assessment = state.phase === 'ready' ? state.assessment : null;
  const transferLink: TransferLinkState = assessment ? assessment.transferLink : 'unknown';
  return (
    <Modal title="Delete transaction" onClose={onClose}>
      <TransactionFields tx={tx} transferLink={state.phase === 'ready' ? transferLink : 'unknown'} />

      <div className="mt-4 text-sm space-y-2">
        {state.phase === 'checking' && <p>Checking whether this transaction can be deleted safely…</p>}

        {state.phase === 'error' && (
          <p className="text-tred" role="alert">{state.message}</p>
        )}

        {assessment && (
          <>
            {describeCashEffect(assessment.cashEffect).map((line) => (
              <p key={line}>{line}</p>
            ))}
            {assessment.holding && (
              <p>
                {assessment.holding.ticker} shares held now: {assessment.holding.sharesWithRow}; after deleting:{' '}
                {assessment.holding.sharesWithoutRow}.
              </p>
            )}
            {assessment.allowed ? (
              <p className="text-tgreen font-medium" data-testid="delete-safe">
                Safe to delete. Afterwards, add or import the corrected transaction if needed.
              </p>
            ) : (
              <div className="text-tred" role="alert" data-testid="delete-blocked">
                <p className="font-medium">This transaction cannot be deleted:</p>
                <ul className="list-disc pl-5 mt-1 space-y-1">
                  {assessment.reasons.map((r) => (
                    <li key={r.code + r.message}>{r.message}</li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}

        {error && <p className="text-tred" role="alert">{error}</p>}
      </div>

      <div className="flex justify-end gap-2 mt-4">
        <button onClick={onClose} className="px-4 py-2 rounded bg-gray-back text-foreground hover:bg-Thoverlight-tint">
          {assessment?.allowed ? 'Cancel' : 'Close'}
        </button>
        {assessment?.allowed && (
          <button
            onClick={onConfirm}
            disabled={deleting}
            className="px-4 py-2 rounded bg-tred text-white hover:bg-tred-hover disabled:opacity-50"
          >
            {deleting ? 'Deleting…' : 'Delete transaction'}
          </button>
        )}
      </div>
    </Modal>
  );
}
