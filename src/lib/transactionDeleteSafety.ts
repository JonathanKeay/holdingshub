// src/lib/transactionDeleteSafety.ts
//
// Pure delete-safety assessment for a single transaction. Financial
// transactions are immutable after creation/import: a wrong row is deleted and
// the corrected row added/imported again. This module decides whether deleting
// a row is safe, and why not, BEFORE anything is written. No database or
// network access; the caller supplies fresh data (src/lib/transactionMutations.ts).
//
// It never changes how anything is calculated. Holdings are projected with the
// engine's own functions (applyTransactionToHoldingResolvingTransfers,
// compareTransactionsForReplay) and the cash effect with the engine's own
// calculateCashBalancesMulti, so the preview matches the dashboard.
//
// Rules — every one BLOCKS (there is no warn-only outcome):
//   CANNOT_ASSESS        the row, its security, or transfer data is unavailable.
//   TRANSFER_LINKED      the row is referenced by any transfers record (any status).
//   FEEDS_TRANSFER_OUT   a BUY/SELL/TIN/TOT/SPL that replays before a later TOT of the
//                        same holding which has a transfers record: that TOT's cost
//                        parcel was frozen from this history and would not follow.
//   SAME_DAY_ORDERING    a replacement is always replayed after rows already stored for
//                        the same day (later created_at; the Add form stores 12:00 UTC),
//                        so an entry (BUY/TIN) sharing its day with an exit (SELL/TOT)
//                        or split of the same holding, or vice versa, or a split sharing
//                        its day with any other BUY/SELL/TIN/TOT/SPL, cannot be rebuilt.
//   WOULD_OVERSELL       replaying the holding without the row makes a SELL/TOT dispose
//                        of more shares than are held, where it did not before.
// Everything else — cash-only types (DIV, INT, DEP, WIT, FEE, OTR, FXM, BAL), CASH.*
// transfers, and cash-type rows attached to a security — is allowed.

import {
  applyTransactionToHoldingResolvingTransfers,
  calculateCashBalancesMulti,
  isCashTicker,
  type AssetMeta,
  type Ccy,
  type Holding,
  type Txn,
} from './queries';
import { compareTransactionsForReplay } from './transactionOrdering';
import {
  indexResolvedTransfersByOutTransactionId,
  indexResolvedTransfersByTinTransactionId,
  type ResolvedTransferForReplay,
} from './holdingsTransferIntegration';

export type TransferRecord = {
  id: string;
  status: string;
  out_transaction_id: string | null;
  in_transaction_id: string | null;
  quantity?: number | null;
  native_cost?: number | null;
  native_ccy?: string | null;
  base_cost?: number | null;
  base_ccy?: string | null;
};

export type DeleteBlockCode =
  | 'CANNOT_ASSESS'
  | 'TRANSFER_LINKED'
  | 'FEEDS_TRANSFER_OUT'
  | 'SAME_DAY_ORDERING'
  | 'WOULD_OVERSELL';

export type DeleteBlockReason = { code: DeleteBlockCode; message: string };

export type TransferLink = {
  transferId: string;
  status: string;
  leg: 'out' | 'in';
};

export type HoldingProjection = {
  ticker: string;
  sharesWithRow: number;
  sharesWithoutRow: number;
};

export type DeleteAssessment = {
  allowed: boolean;
  reasons: DeleteBlockReason[];
  /** This row's own contribution to portfolio cash (deleting it reverses this). */
  cashEffect: { currency: Ccy; amount: number }[];
  transferLink: TransferLink | null;
  holding: HoldingProjection | null;
};

export type DeleteSafetyInput = {
  target: Txn;
  /** Every transaction of the target's portfolio, the target included. */
  portfolioTxns: Txn[];
  assetMeta: Record<string, AssetMeta>;
  /** Every transfers record visible to the user; null when it could not be read. */
  transfers: TransferRecord[] | null;
  baseCurrency: Ccy;
};

// Types that move shares or open cost in applyTransactionToHolding.
const HOLDING_TYPES = new Set(['BUY', 'SELL', 'TIN', 'TOT', 'SPL']);
const ENTRY_TYPES = new Set(['BUY', 'TIN']);
const EXIT_TYPES = new Set(['SELL', 'TOT']);
// Mirrors ALWAYS_CASH_TYPES in queries.ts: never part of holdings replay.
const NEVER_IN_HOLDINGS = new Set(['DIV', 'INT']);

const SHARE_EPSILON = 1e-6;

const upper = (s?: string | null) => (s ?? '').toString().trim().toUpperCase();
const dayOf = (d?: string | null) => (d ?? '').slice(0, 10);

export function findTransferLink(txnId: string, transfers: TransferRecord[]): TransferLink | null {
  for (const t of transfers) {
    if (t.out_transaction_id === txnId) return { transferId: t.id, status: t.status, leg: 'out' };
    if (t.in_transaction_id === txnId) return { transferId: t.id, status: t.status, leg: 'in' };
  }
  return null;
}

/** The row's own cash contribution, computed by the live cash engine. */
export function cashEffectOf(target: Txn, assetMeta: Record<string, AssetMeta>): { currency: Ccy; amount: number }[] {
  return calculateCashBalancesMulti([target], assetMeta, { requireCashAssetForCashRows: true }).map((c) => ({
    currency: c.currency,
    amount: c.balance,
  }));
}

/** Whether the live engine replays this row into a holding (see getPortfoliosWithHoldingsAndCash). */
function entersHoldingsReplay(tx: Txn, assetMeta: Record<string, AssetMeta>): boolean {
  const meta = assetMeta[tx.asset_id];
  if (!meta) return false;
  if (NEVER_IN_HOLDINGS.has(upper(tx.type))) return false;
  return !isCashTicker(meta.ticker);
}

type ReplayResult = { finalShares: number; oversoldTxnIds: Set<string>; oversells: { txn: Txn; held: number }[] };

/** Replays one holding exactly as the engine does, recording every SELL/TOT that disposes of more than is held. */
function replayHolding(
  txns: Txn[],
  ticker: string,
  meta: AssetMeta,
  baseCurrency: Ccy,
  transfers: TransferRecord[]
): ReplayResult {
  const resolvable = transfers as unknown as ResolvedTransferForReplay[];
  const resolvedTin = indexResolvedTransfersByTinTransactionId(resolvable);
  const resolvedTot = indexResolvedTransfersByOutTransactionId(resolvable);

  const holding: Holding = {
    asset_id: txns[0]?.asset_id ?? '',
    ticker,
    total_shares: 0,
    total_cost: 0,
    avg_price: 0,
    currency: meta.currency || baseCurrency,
    realised_value: 0,
    realised_cost: 0,
    realised_proceeds: 0,
    base_currency: baseCurrency,
  };

  const oversoldTxnIds = new Set<string>();
  const oversells: { txn: Txn; held: number }[] = [];
  for (const tx of [...txns].sort(compareTransactionsForReplay)) {
    const t = upper(tx.type);
    if (EXIT_TYPES.has(t)) {
      const qty = Math.abs(Number(tx.quantity) || 0);
      if (qty > holding.total_shares + SHARE_EPSILON) {
        oversoldTxnIds.add(tx.id);
        oversells.push({ txn: tx, held: holding.total_shares });
      }
    }
    applyTransactionToHoldingResolvingTransfers(holding, tx, resolvedTin, resolvedTot);
  }
  return { finalShares: holding.total_shares, oversoldTxnIds, oversells };
}

const fmtQty = (n: number) => Number(n.toFixed(6)).toString();

export function assessTransactionDelete(input: DeleteSafetyInput): DeleteAssessment {
  const { target, portfolioTxns, assetMeta, transfers, baseCurrency } = input;
  const reasons: DeleteBlockReason[] = [];
  const meta = assetMeta[target.asset_id];
  const cashEffect = meta ? cashEffectOf(target, assetMeta) : [];

  if (!meta) {
    reasons.push({
      code: 'CANNOT_ASSESS',
      message: "This transaction's security could not be found, so the effect of deleting it cannot be checked.",
    });
  }
  if (transfers == null) {
    reasons.push({
      code: 'CANNOT_ASSESS',
      message: 'Transfer records could not be read, so it is not possible to confirm this transaction is not part of a transfer.',
    });
  }
  if (!meta || transfers == null) {
    return { allowed: false, reasons, cashEffect, transferLink: null, holding: null };
  }

  const transferLink = findTransferLink(target.id, transfers);
  if (transferLink) {
    reasons.push({
      code: 'TRANSFER_LINKED',
      message:
        `This transaction is the ${transferLink.leg === 'out' ? 'outgoing' : 'incoming'} side of a recorded ` +
        `transfer (status: ${transferLink.status}). Deleting it would break that transfer record and the ` +
        `cost carried between portfolios. Transfer corrections need an admin repair.`,
    });
  }

  const type = upper(target.type);
  let holding: HoldingProjection | null = null;

  if (HOLDING_TYPES.has(type) && entersHoldingsReplay(target, assetMeta)) {
    const sameHolding = portfolioTxns.filter(
      (t) => t.asset_id === target.asset_id && entersHoldingsReplay(t, assetMeta)
    );
    if (!sameHolding.some((t) => t.id === target.id)) sameHolding.push(target);

    // FEEDS_TRANSFER_OUT — a later TOT of this holding whose parcel is frozen.
    const frozenTotIds = new Set(transfers.filter((t) => t.out_transaction_id).map((t) => t.out_transaction_id as string));
    const laterFrozenTot = sameHolding
      .filter((t) => t.id !== target.id && upper(t.type) === 'TOT' && frozenTotIds.has(t.id))
      .filter((t) => compareTransactionsForReplay(target, t) < 0)
      .sort(compareTransactionsForReplay)[0];
    if (laterFrozenTot) {
      reasons.push({
        code: 'FEEDS_TRANSFER_OUT',
        message:
          `${meta.ticker} was later transferred out of this portfolio (${dayOf(laterFrozenTot.date)}), and the ` +
          `cost carried by that transfer was fixed from the history that includes this transaction. Deleting ` +
          `it would leave the transferred cost out of step with this portfolio. Changing this history needs an admin repair.`,
      });
    }

    // SAME_DAY_ORDERING — a replacement could not be replayed in the same position.
    const day = dayOf(target.date);
    const sameDayOthers = sameHolding.filter((t) => t.id !== target.id && dayOf(t.date) === day);
    const conflicting = sameDayOthers.filter((t) => {
      const o = upper(t.type);
      if (!HOLDING_TYPES.has(o)) return false;
      if (type === 'SPL' || o === 'SPL') return true;
      return (ENTRY_TYPES.has(type) && EXIT_TYPES.has(o)) || (EXIT_TYPES.has(type) && ENTRY_TYPES.has(o));
    });
    if (conflicting.length > 0) {
      const others = [...new Set(conflicting.map((t) => upper(t.type)))].join('/');
      reasons.push({
        code: 'SAME_DAY_ORDERING',
        message:
          `There is also a ${others} of ${meta.ticker} on ${day} in this portfolio. A replacement added later ` +
          `would be processed after it rather than in its original position, which can change shares, cost ` +
          `and realised profit. Deleting this transaction is blocked until same-day ordering is fixed.`,
      });
    }

    // WOULD_OVERSELL — project the holding without this row.
    const withRow = replayHolding(sameHolding, meta.ticker, meta, baseCurrency, transfers);
    const withoutRow = replayHolding(
      sameHolding.filter((t) => t.id !== target.id),
      meta.ticker,
      meta,
      baseCurrency,
      transfers
    );
    holding = { ticker: meta.ticker, sharesWithRow: withRow.finalShares, sharesWithoutRow: withoutRow.finalShares };
    const newOversell = withoutRow.oversells.find((o) => !withRow.oversoldTxnIds.has(o.txn.id));
    if (newOversell) {
      reasons.push({
        code: 'WOULD_OVERSELL',
        message:
          `Without this transaction, the ${upper(newOversell.txn.type)} of ${fmtQty(Math.abs(Number(newOversell.txn.quantity) || 0))} ` +
          `${meta.ticker} on ${dayOf(newOversell.txn.date)} would dispose of more shares than are held ` +
          `(${fmtQty(newOversell.held)}). Deleting it would leave an invalid holding.`,
      });
    }
  }

  return { allowed: reasons.length === 0, reasons, cashEffect, transferLink, holding };
}
