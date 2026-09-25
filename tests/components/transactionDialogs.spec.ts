// TRANSACTIONS SCREEN — financial transactions are immutable after creation/import.
//
// Renders the dialogs to static HTML (react-dom/server; no browser) and checks
// that no financial field is editable, that the delete dialog explains itself,
// and that the Transactions page source no longer contains the old financial
// Edit path. Rendering is used because the page itself depends on Next.js
// routing hooks; the dialogs hold all of the markup that matters here.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  DeleteTransactionDialog,
  EditNotesDialog,
  TransactionDetailsDialog,
  describeCashEffect,
  transferLinkLabel,
  type TransactionView,
} from '../../src/components/transactions/TransactionDialogs';
import type { DeleteAssessment } from '../../src/lib/transactionDeleteSafety';

const TX: TransactionView = {
  id: 't1',
  portfolio_name: 'HGLD ISA STK',
  ticker: 'VOD.L',
  type: 'BUY',
  date: '2024-01-02T00:00:00+00:00',
  created_at: '2026-09-12T07:21:39.123+00:00',
  quantity: 10,
  price: 10.5,
  fee: 5,
  cash_value: 110,
  cash_ccy: 'GBP',
  settle_value: 110,
  settle_ccy: 'GBP',
  cash_fx_to_portfolio: 1,
  split_factor: null,
  notes: 'EOF1318916196',
};

const noop = () => {};
const html = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(el);
const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;

const allowed: DeleteAssessment = {
  allowed: true,
  reasons: [],
  cashEffect: [{ currency: 'GBP', amount: -110 }],
  transferLink: null,
  holding: { ticker: 'VOD.L', sharesWithRow: 10, sharesWithoutRow: 0 },
};
const blocked: DeleteAssessment = {
  allowed: false,
  reasons: [
    {
      code: 'TRANSFER_LINKED',
      message:
        'This transaction is the incoming side of a recorded transfer (status: matched). Deleting it would break that transfer record and the cost carried between portfolios. Transfer corrections need an admin repair.',
    },
  ],
  cashEffect: [],
  transferLink: { transferId: 'tr', status: 'matched', leg: 'in' },
  holding: null,
};

describe('View Details', () => {
  const out = html(createElement(TransactionDetailsDialog, { tx: TX, transferLink: null, onClose: noop }));

  it('shows every stored field', () => {
    for (const label of [
      'Portfolio', 'Ticker', 'Type', 'Transaction date', 'Created', 'Quantity', 'Price', 'Fee',
      'Cash value', 'Settle value', 'FX rate', 'Split factor', 'Notes', 'Transfer link',
    ]) {
      expect(out).toContain(`>${label}`);
    }
    for (const value of ['HGLD ISA STK', 'VOD.L', 'BUY', '02-01-2024', '2026-09-12 07:21:39 UTC', '10.5', '110 GBP', 'EOF1318916196', 'Not linked to a transfer']) {
      expect(out).toContain(value);
    }
  });

  it('has no editable controls at all', () => {
    expect(count(out, /<(input|textarea|select)\b/g)).toBe(0);
  });

  it('shows stored NULLs as a dash, not as zero', () => {
    const nulls = html(createElement(TransactionDetailsDialog, {
      tx: { ...TX, quantity: null, cash_value: null, cash_ccy: null, split_factor: null, notes: null },
      transferLink: null,
      onClose: noop,
    }));
    expect(nulls).toContain('>Quantity</dt><dd class="font-mono break-all">—<');
    expect(nulls).toContain('>Cash value</dt><dd class="font-mono break-all">—<');
  });

  it('labels transfer-link status, including an unreadable state', () => {
    expect(transferLinkLabel(null)).toBe('Not linked to a transfer');
    expect(transferLinkLabel('unknown')).toContain('Unknown');
    expect(transferLinkLabel({ transferId: 'x', status: 'matched', leg: 'out' })).toBe(
      'Linked to a transfer — outgoing side, status matched'
    );
  });
});

describe('Edit Notes', () => {
  const out = html(createElement(EditNotesDialog, { tx: TX, saving: false, error: null, onSave: noop, onClose: noop }));

  it('offers exactly one editable control: the notes textarea', () => {
    expect(count(out, /<(input|select)\b/g)).toBe(0);
    expect(count(out, /<textarea\b/g)).toBe(1);
    expect(out).toMatch(/<textarea[^>]*name="notes"/);
    expect(out).toContain('EOF1318916196');
  });

  it('shows a save error as readable text', () => {
    const withError = html(createElement(EditNotesDialog, {
      tx: TX, saving: false, error: 'You do not have permission to change this transaction. The notes were not saved.', onSave: noop, onClose: noop,
    }));
    expect(withError).toContain('role="alert"');
    expect(withError).toContain('The notes were not saved.');
  });
});

describe('Delete confirmation', () => {
  it('while checking: shows the transaction and no Delete button', () => {
    const out = html(createElement(DeleteTransactionDialog, { tx: TX, state: { phase: 'checking' }, deleting: false, error: null, onConfirm: noop, onClose: noop }));
    expect(out).toContain('VOD.L');
    expect(out).toContain('Checking whether this transaction can be deleted safely');
    expect(out).not.toContain('Delete transaction</button>');
  });

  it('when safe: shows the full transaction, its cash effect, the holding change and a Delete button', () => {
    const out = html(createElement(DeleteTransactionDialog, { tx: TX, state: { phase: 'ready', assessment: allowed }, deleting: false, error: null, onConfirm: noop, onClose: noop }));
    expect(out).toContain('data-testid="transaction-fields"');
    expect(out).toContain('Cash effect: -£110.00 (GBP). Deleting it changes GBP cash by +£110.00.');
    expect(out).toContain('VOD.L shares held now: 10; after deleting: 0.');
    expect(out).toContain('data-testid="delete-safe"');
    expect(out).toContain('Delete transaction</button>');
    expect(count(out, /<(input|textarea|select)\b/g)).toBe(0);
  });

  it('when blocked: shows the plain-English reason and NO Delete button', () => {
    const out = html(createElement(DeleteTransactionDialog, { tx: { ...TX, type: 'TIN' }, state: { phase: 'ready', assessment: blocked }, deleting: false, error: null, onConfirm: noop, onClose: noop }));
    expect(out).toContain('data-testid="delete-blocked"');
    expect(out).toContain('This transaction cannot be deleted:');
    expect(out).toContain('incoming side of a recorded transfer (status: matched)');
    expect(out).toContain('Linked to a transfer — incoming side, status matched');
    expect(out).not.toContain('Delete transaction</button>');
  });

  it('when the check could not run: shows the readable error and NO Delete button', () => {
    const out = html(createElement(DeleteTransactionDialog, { tx: TX, state: { phase: 'error', message: 'This transaction could not be found, or you do not have permission to change it. Nothing was changed.' }, deleting: false, error: null, onConfirm: noop, onClose: noop }));
    expect(out).toContain('you do not have permission to change it');
    expect(out).not.toContain('Delete transaction</button>');
  });

  it('shows a failed delete as readable text', () => {
    const out = html(createElement(DeleteTransactionDialog, { tx: TX, state: { phase: 'ready', assessment: allowed }, deleting: false, error: 'Could not reach the database. Check your connection and try again. Nothing was deleted.', onConfirm: noop, onClose: noop }));
    expect(out).toContain('Nothing was deleted.');
  });

  it('describes a transaction with no cash effect', () => {
    expect(describeCashEffect([])).toEqual(['This transaction has no effect on portfolio cash.']);
    expect(describeCashEffect([{ currency: 'USD', amount: 25 }])).toEqual([
      'Cash effect: $25.00 (USD). Deleting it changes USD cash by -$25.00.',
    ]);
  });
});

describe('Transactions page — the financial Edit path is gone', () => {
  const pagePath = path.resolve(__dirname, '../../src/app/transactions/page.tsx');
  const src = readFileSync(pagePath, 'utf8');

  it('no longer contains the financial Edit popup or its save handler', () => {
    for (const gone of ['handleSaveEdit', 'setEditValues', 'editingTx', 'Edit Transaction', 'Split Factor', '-- Select Type --']) {
      expect(src).not.toContain(gone);
    }
  });

  it('never updates or deletes transactions directly; it uses the notes-only and safety-checked helpers', () => {
    expect(src).not.toMatch(/\.update\(/);
    expect(src).not.toMatch(/from\('transactions'\)\s*\.delete\(/);
    expect(src).toContain('updateTransactionNotes(supabase');
    expect(src).toContain('deleteTransactionSafely(supabase');
    expect(src).toContain('loadDeleteAssessment(supabase');
  });

  it('offers View details, Edit notes and Delete for each row', () => {
    expect(src).toContain('title="View details"');
    expect(src).toContain('title="Edit notes"');
    expect(src).toContain('title="Delete"');
  });

  it('reloads the list from the database after a successful delete', () => {
    const confirm = src.slice(src.indexOf('async function handleConfirmDelete'), src.indexOf('async function handleCreate'));
    expect(confirm).toContain('await fetchTransactions()');
    expect(confirm).toContain("kind: 'success'");
  });

  it('nowhere in src/ updates or deletes transactions except src/lib/transactionMutations.ts', () => {
    const root = path.resolve(__dirname, '../../src');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|tsx|js)$/.test(name)) {
          const text = readFileSync(full, 'utf8');
          if (/from\(['"]transactions['"]\)\s*\.(update|delete|upsert)\(/.test(text)) offenders.push(path.relative(root, full));
        }
      }
    };
    walk(root);
    expect(offenders).toEqual(['lib/transactionMutations.ts']);
  });
});
