# HoldingsHub Accounting & Calculation Specification

**Subtitle:** Validated Accounting Contract — Post IBKR Production Reconciliation

| | |
|---|---|
| **Document version** | 1.0 |
| **Date** | 2026-09-23 |
| **Status** | Validated after IBKR PROD reconciliation |
| **Scope** | Describes what HoldingsHub's implementation actually does today, as established by reading the source code and the automated test suite — not what an investment application "ought" to do |
| **Author** | Produced via code-level audit; no application code, schema, migrations, tests, calculations, or PROD data were modified in producing this document |

## Validation statement

This specification was validated by tracing the implementation described below against the completed IBKR production rebuild, which reconciled:

- **458** transactions across both IBKR portfolios (IBKR ISA STK, IBKR TRD STK), spanning 2021–2026
- **8** transfer records (5 `external_in`, 3 `matched`)
- Exact year-end cash checkpoints for every year 2021–2026
- Final IBKR ISA cash: **£16,496.71**
- Final IBKR TRD cash: **£1,366.63**
- **35/35** checks passed in the final PROD reconciliation script, covering transaction counts/types, transfer state, cash (via the live application's own cash function), retained DEV cost/P&L comparisons, and reference-data aliases

**This validation does not prove correctness for transaction types, currencies, or scenarios that were never exercised by the IBKR data.** In particular: no EUR-denominated activity, no BAL rows, no manual Add/Edit-path transactions, and no non-IBKR broker (Trading 212, HL, eToro) data were part of this reconciliation. Section 15 identifies specific gaps and untested paths discovered during this audit.

---

## Table of contents

1. [Transaction accounting contract](#1-transaction-accounting-contract)
2. [Cash-leg precedence](#2-cash-leg-precedence)
3. [FX model](#3-fx-model)
4. [Holdings and quantity](#4-holdings-and-quantity)
5. [Cost basis](#5-cost-basis)
6. [P&L](#6-pl)
7. [Transfers](#7-transfers)
8. [Portfolio cash](#8-portfolio-cash)
9. [Portfolio and Global calculations](#9-portfolio-and-global-calculations)
10. [Reliability model](#10-reliability-model)
11. [Precision and rounding](#11-precision-and-rounding)
12. [Import versus accounting responsibilities](#12-import-versus-accounting-responsibilities)
13. [Source-code traceability](#13-source-code-traceability)
14. [Worked examples](#14-worked-examples)
15. [Known technical debt / edge cases](#15-known-technical-debt--edge-cases)
16. [Verification report](#16-verification-report)

---

## 1. Transaction accounting contract

HoldingsHub's core accounting engine recognises transaction rows by a `type` column (free text, no DB constraint on allowed values). The canonicalisation of broker/CSV input into these types happens in the importer (`canonicalizeType`, `src/app/api/import-transactions/route.ts`); the accounting engine itself (`src/lib/queries.ts`) works only with the canonical types below.

A row's downstream treatment is governed by four sets, all defined in `src/lib/queries.ts`:

- `TRANSACTION_TYPE_META` — `{ units, cost, realised }` flags per type, consulted by `applyTransactionToHolding`.
- `ALWAYS_CASH_TYPES = {DIV, INT}` — types that never touch holdings replay at all (income only).
- `REALISED_AFFECTING_TYPES = {SELL, DIV, INT, FEE}` — the exact set that actually computes a `realised_value` contribution (narrower than `TRANSACTION_TYPE_META[type].realised`, which is also true for BUY even though BUY never affects realised P&L).
- `OPEN_COST_AFFECTING_TYPES = {BUY, SELL, TIN, TOT}` — types that touch `total_cost`/`base_total_cost`.

### BUY

| Effect | Behaviour |
|---|---|
| Quantity | `total_shares += qty` |
| Cash | Decreases cash by `abs(cash_value)` in `cash_ccy`. The value is stored at write time by `resolveCashLeg` (§2). Only if it is NULL does the cash calculation fall back to `qty*price+fee` in the **asset** currency (§8) |
| Cost basis | `total_cost += settle_value` (if `settle_ccy` = asset ccy) else `qty*price+fee` |
| Realised cost | Not affected (BUY enters the realised branch's outer `if` per `TRANSACTION_TYPE_META` but matches none of the inner `DIV/INT/FEE/SELL` cases) |
| Realised P&L | Not affected |
| FX | Governed by the cash-leg gate (§2) for the cash side; cost-basis side uses `settle_value`/`settle_ccy` directly, never FX-converted |
| Fee | Added to cost (`qty*price+fee`) |
| Transfer | N/A |
| Reliability | Definition B (base-currency ledger) marks the position unreliable unless `cash_value` is present, in the portfolio base currency, and (if cross-currency) `cash_fx_to_portfolio` is present and positive |

### SELL

| Effect | Behaviour |
|---|---|
| Quantity | `total_shares -= qty` |
| Cash | Increases cash by `abs(cash_value)` in `cash_ccy`. The write-time fallbacks overstate a SELL by 2 × fee (§2). Only if the stored value is NULL does the cash calculation use `qty*price-fee` in the asset currency (§8) |
| Cost basis | Proportional removal: `costOut = total_cost * (qty / total_shares_before)` |
| Realised cost | `realised_cost += costBasisCash` (cost basis converted to proceeds currency via the SELL row's own implied FX if currencies differ) |
| Realised P&L | `realised_value += proceedsAmount - costBasisCash` |
| FX | Same cash-leg gate as BUY for the cash side; realised-cost currency conversion uses `impliedFxFromSellRow` (`|cash_value| / |settle_value|`), a **SELL-row-specific implied rate**, never the cached/spot FX table |
| Fee | Deducted from proceeds (`qty*price-fee`); commission is **not** double-counted (see §2) |
| Transfer | N/A |
| Reliability | Same Definition B gating as BUY; an unreliable SELL also permanently taints `base_realised_reliable` |

### DIV

| Effect | Behaviour |
|---|---|
| Quantity | None — `ALWAYS_CASH_TYPES` excludes DIV from holdings replay entirely |
| Cash | `cash[ccy] += abs(cash_value)` (always added, sign forced positive) |
| Cost basis | None |
| Realised P&L | `realised_value += proceedsAmount`, `realised_proceeds += proceedsAmount` — **but only reachable via `applyTransactionToHolding` directly; in the live per-portfolio/Global replay, DIV rows never reach holdings replay at all** because `getPortfoliosWithHoldingsAndCash`/`getAllHoldingsAndCashSummary` filter them out via `ALWAYS_CASH_TYPES` before building `holdingsTxns`. The DIV branch inside `applyTransactionToHolding` is exercised only by unit tests that call it directly. |
| FX | Cash-leg gate applies (`CASH_LEG_TRANSACTION_TYPES` includes DIV); signed explicit cash allowed (the sign is preserved in the stored value, §2, but the cash calculation ignores it) |
| Fee | N/A |
| Transfer | N/A |
| Reliability | N/A (not part of Definition B's open-cost ledger) |

### INT

Identical treatment to DIV in every respect (same `ALWAYS_CASH_TYPES` exclusion from holdings replay, same cash-leg gate membership, same signed-explicit-cash allowance).

### DEP

| Effect | Behaviour |
|---|---|
| Quantity | None |
| Cash | `cash[ccy] += abs(cash_value)` (the stored sign is ignored), **only when the row's asset is a `CASH.*` ticker** (`requireCashAssetForCashRows` default `true`) |
| Cost basis / Realised | None |
| FX | Cash-leg gate applies; signed explicit cash allowed (the sign is preserved in the stored value, §2, but the cash calculation ignores it) |
| Transfer | None |
| Reliability | N/A |

### WIT

Same shape as DEP, but `cash[ccy] -= abs(cash_value)`.

### FEE

| Effect | Behaviour |
|---|---|
| Quantity | None |
| Cash (`calculateCashBalancesMulti`) | `cash[ccy] -= abs(cash_value)`, **gated on `isCashAsset`** — a FEE attached to an ordinary security ticker has **zero cash effect** |
| Cost basis | None |
| Realised P&L (`applyTransactionToHolding`) | `realised_value -= abs(fee)` — this branch is **not** gated on `isCashAsset`, so a security-attached FEE **does** reduce that holding's native `realised_value`, even though it has no cash effect |
| FX | Cash-leg gate applies for the cash-bucket side; signed explicit cash allowed (the sign is preserved in the stored value, §2, but the cash calculation ignores it) |
| Reliability | The Definition B block does not have a FEE case at all — a security-attached FEE changes native `realised_value` but leaves `base_realised_value` completely unchanged |

**This FEE asymmetry (native realised_value affected, cash and base-currency realised both unaffected, when the FEE is attached to a security rather than a CASH.\* ticker) is a known, explicitly documented gap** — see `tests/financial/current-behaviour.cash.spec.ts` "T12b" and `tests/financial/target-spec.pending.spec.ts` ("FEE workstream — stabilisation plan decision 1"). It is not fixed by this document; see §15.

### OTR

| Effect | Behaviour |
|---|---|
| Quantity | None |
| Cash | `cash[ccy] += cash_value` — **signed, added exactly as supplied, never gated on `isCashAsset`**. OTR is HoldingsHub's generic catch-all cash event (withholding tax, ADR fees, account fees, sweep transfers) and is routinely recorded against the security that caused it, not a `CASH.*` row |
| Cost basis / Realised | None |
| FX | Cash-leg gate applies; signed explicit cash allowed |
| Reliability | N/A |

### FXM (Foreign Exchange Movement)

| Effect | Behaviour |
|---|---|
| Quantity | None |
| Cash | `cash[ccy] += cash_value`, **unconditional**, never gated on `isCashAsset`, never derived from quantity/price |
| Cost basis / Realised (holdings) | None — FXM is listed in `TRANSACTION_TYPE_META` with `realised: 0`, so it never contributes to realised P&L |
| FX | **FXM is deliberately excluded from the cash-leg gate.** Its `cash_value` already **is** the final, signed, portfolio-base-currency realised FX gain/loss — there is no native-currency settlement leg to convert. Routing it through `resolveCashLeg` would be wrong: the same-currency branch discards sign via `Math.abs`, and a realised FX loss must stay negative. FXM instead uses `resolveUngatedCashValue`, which passes an explicit value through completely unchanged. |
| Reliability | N/A |

### TIN (security transfer in) — ordinary security ticker

| Effect | Behaviour |
|---|---|
| Quantity | `total_shares += qty` |
| Cash | **None** — an ordinary security TIN's `cash_value`/`cash_ccy` are never consulted by any downstream calculation |
| Cost basis | **Legacy path** (no resolved transfer record): `deriveAssetCostForTIN` — (a) `settle_value` in asset ccy if present, else (b) `cash_value` in asset ccy if present, else (c) `qty*price+fee`, else (d) zero. **Resolved-transfer path** (a `matched`/`external_in` transfer record exists for this transaction id): the frozen `CostParcel.nativeCost` is credited instead, via `applyTransferIn` — see §7 |
| Realised P&L | None (`TRANSACTION_TYPE_META.TIN.realised = 0`) |
| FX | Not gated — an in-kind transfer's settlement cost is asset-currency-denominated and never FX-converted at import or replay time |
| Transfer | Creates a `pending_in` transfer row at import time (via `processImportedTransfers`) unless the row is a `CASH.*` ticker, in which case no transfer row is created at all |
| Reliability | Legacy TIN unconditionally sets `base_cost_reliable = false` (no linked-transfer persistence trusted); a resolved TIN's reliability instead depends on whether the parcel carries a `baseCost` (see §10) |

### TIN — CASH.\* ticker (cash transfer)

A structurally different transaction: **no holdings effect at all** (`isCashTicker(ticker)` excludes it from `holdingsTxns` in both `getPortfoliosWithHoldingsAndCash` and `getAllHoldingsAndCashSummary`). Its only effect is cash: `cash[ccy] += abs(cash_value)` in `calculateCashBalancesMulti`, gated on `isCashAsset` being true (which it is, by definition, for a `CASH.*` ticker). No transfer row is created for it (`selectTransferRelevantRows` explicitly excludes `CASH.*` tickers from the transfer-persistence integration entirely).

### TOT (security transfer out) — ordinary security ticker

| Effect | Behaviour |
|---|---|
| Quantity | `total_shares -= qty` |
| Cash | None |
| Cost basis | Proportional removal, unconditionally: `costOut = total_cost * (qty / total_shares_before)` — this happens via ordinary `applyTransactionToHolding` replay regardless of whether a transfer resolves |
| Realised P&L | None — a transfer is never a disposal |
| FX | Not gated |
| Transfer | Creates a `pending_out` transfer row at import time, capturing a frozen `CostParcel` via `applyTransferOut` at that exact moment |
| Reliability | Legacy/unresolved TOT unconditionally marks `base_cost_reliable = false`; a resolved TOT (matched/external_out) corrects this back to reliable via the frozen parcel's `baseCost`, unless the holding was already unreliable for an unrelated reason, or the position fully closed on this TOT (see §7, §10) |

### TOT — CASH.\* ticker

Mirror of the cash TIN: no holdings effect, cash effect only (`cash[ccy] -= abs(cash_value)`), no transfer row created.

### SPL (stock split)

| Effect | Behaviour |
|---|---|
| Quantity | `total_shares = round(total_shares * split_factor)` |
| Cash | None |
| Cost basis | `total_cost` is **unchanged** — a split creates no value; only `avg_price` (a derived figure) moves |
| Realised P&L | None |
| FX | N/A |
| Transfer | N/A |
| Reliability | Definition B: `base_total_cost` unchanged, `base_avg_cost` recomputed the same way as the native `avg_price` |

`split_factor` is validated by DB CHECK constraint `chk_spl_factor`: required (and `> 0`) exactly when `type = 'SPL'`, forbidden otherwise.

---

## 2. Cash-leg precedence

`resolveCashLeg` (`src/lib/cashLeg.ts`) is the single decision function that sets the stored `cash_value` for every **gated** type: BUY, SELL, DIV, INT, DEP, WIT, FEE, OTR, and `CASH.*` TIN/TOT (`shouldApplyCashLegGate`). The import route reaches it through `resolveRowCashLeg`. The manual Add form (BUY/SELL only) calls `resolveCashLeg` directly. FXM and ordinary-security TIN/TOT are not gated and use `resolveUngatedCashValue`. BAL is not importable and never passes through either function. The function runs at **write time**. It decides the stored value only; the read-time cash calculation (§8) then applies its own per-type sign rules. Current precedence, in order:

```
0. assetCcy/baseCcy known?              -> else BLOCKED
1. settleAbs is a positive finite value? -> else BLOCKED
2. allowSignedExplicitCash && explicitCashValue is finite (any sign, incl. 0)?
      -> OK, cash_value = explicitCashValue exactly as supplied
3. explicitCashValue is POSITIVE finite?
      -> OK, cash_value = explicitCashValue (magnitude only)
4. assetCcy === baseCcy?
      -> OK, cash_value = settleAbs (same-currency fallback — TRUE LAST RESORT)
5. explicitFxRate is POSITIVE finite?
      -> OK, cash_value = settleAbs * explicitFxRate
6. cachedRateAssetToBase (from fx_rates table, that trade date) is POSITIVE finite?
      -> OK, cash_value = settleAbs * cachedRateAssetToBase
7. Nothing usable -> BLOCKED (row is skipped, reported in skippedCashLeg)
```

Notes on the steps:

- `settleAbs` is always `|quantity × price + fee|`, computed by the caller for **every** gated type, SELL included. It is never net proceeds.
- Step 1 runs before any explicit-value step. A gated row whose `quantity × price + fee` is zero is therefore BLOCKED even when it carries a valid explicit `cash_value`.
- For BUY/SELL and `CASH.*` TIN/TOT, step 3 accepts only a strictly positive value. A blank, zero or negative explicit `cash_value` is ignored, and the row falls through to steps 4–7.
- In the import route, the cached rate (step 6) is looked up only when `cash_value` is **blank** and no positive `fxrate` was supplied. A zero or negative explicit `cash_value` on a cross-currency BUY/SELL without an `fxrate` is therefore BLOCKED, even if a cached rate exists.

This exact ordering is the outcome of **three separate fixes made during the IBKR PROD rebuild engagement** (commits `2d03e36`, `d1cd511`, `509fe75`), each triggered by real DEV data:

1. **Cross-currency sign bug** (`2d03e36`): step 3 originally required a strictly positive `explicitCashValue` even for signed cash-impact types, silently flipping a negative explicit value (e.g. a −£1.39 WYNN withholding tax) to positive. Fixed by introducing step 2 (`allowSignedExplicitCash`).
2. **Same-currency-before-signed-explicit bug** (`d1cd511`): step 4 (same-currency) originally ran *before* step 2, so a same-currency signed row (e.g. a −£0.02 `CASH.GBP` OTR) still fell into the same-currency branch's `Math.abs(settleAbs)`, losing its sign. Fixed by moving step 2 ahead of step 4.
3. **Same-currency BUY/SELL fee overstatement** (`509fe75`): step 3 (positive explicit value) also originally ran *after* step 4, so a same-currency SELL with non-zero commission was overstated by exactly 2× the fee (`settleAbs = qty*price+fee` is only correct for BUY; SELL's true net proceeds are `qty*price-fee`, but the same-currency shortcut used `settleAbs` unconditionally). Fixed by moving step 3 ahead of step 4 as well, leaving step 4 as a true last resort. Signed-flag types reach it only when no explicit cash value was supplied. BUY/SELL and `CASH.*` TIN/TOT also reach it when the explicit value is zero or negative.

### Which types get `allowSignedExplicitCash`

`CASH_LEG_TRANSACTION_TYPES = {DIV, INT, DEP, WIT, FEE, OTR}`. The import route passes `allowSignedExplicitCash = CASH_LEG_TRANSACTION_TYPES.has(type)` to `resolveRowCashLeg`. (`shouldApplyCashLegGate` only decides whether a row is gated at all; it does not set this flag.) For these types, `resolveCashLeg` stores an explicit `cash_value` exactly as supplied: positive, negative or zero.

**Preserving the sign when storing is not the same as using it when calculating.** At read time, `calculateCashBalancesMulti` (and `applyCashTxn`) uses the stored sign **only for OTR**. DIV, INT and DEP add `abs(cash_value)`; WIT and FEE subtract `abs(cash_value)`. For those five types the transaction type sets the direction, and a stored negative value has the same cash effect as its positive magnitude (see §14 WIT/FEE and §15).

**BUY/SELL and CASH.\* TIN/TOT never set this flag.** Their `cash_value` is always a magnitude; direction comes from the transaction type/quantity, never from the sign of `cash_value`. Setting `allowSignedExplicitCash` for these would be wrong — a BUY's cash effect is always a decrease regardless of what sign a broker export happens to record.

### Avoiding double-counted commission on BUY/SELL

The commission is added to cost on a **BUY** (`quantity*price + fee`) and deducted from proceeds on a **SELL** (`quantity*price - fee`).

The write-time fallback does not apply that asymmetry. `settleAbs` is always `|quantity*price + fee|`, whatever the type. That is correct for a BUY. For a SELL it is wrong by exactly `2 × fee`: the fee is added where it should have been subtracted. The error appears in **every** SELL fallback that starts from `settleAbs`:

- same-currency (step 4): `cash_value = qty*price + fee`, overstated by `2 × fee`;
- explicit FX (step 5) and cached FX (step 6): `cash_value = (qty*price + fee) × rate`, overstated by `2 × fee × rate`.

The third fix does not change these fallbacks. It makes sure a strictly positive explicit `cash_value` is used **before** any of them. A SELL is therefore correct only when a positive explicit `cash_value` (net proceeds, in base currency) is supplied. There is no separate "double-fee" defence elsewhere. The read-time fallback in `calculateCashBalancesMulti` (`qty*price - fee`, §8) does have the correct sign. However, it is reached only when the stored `cash_value` is NULL, which the import route never produces for BUY/SELL. The `mirror_settle_to_cash` trigger also fills a NULL `cash_value` from `settle_value` (`qty*price + fee`) whenever `settle_value` is present.

---

## 3. FX model

| Field | Meaning | Populated by |
|---|---|---|
| `cash_ccy` | Currency of `cash_value` — the portfolio-base-currency cash movement | `resolveRowCashLeg` (import), `mirror_settle_to_cash` DB trigger (BUY/SELL fallback), manual Add form |
| `settle_ccy` | Currency of `settle_value` — the asset/native settlement currency | Import route (`assetMeta[tickerKey]?.currency`) |
| `cash_fx_to_portfolio` | The rate actually used to derive `cash_value` from `settle_value`, when one was used | `resolveCashLeg`'s outcome (`cash_value / settleAbs`, or the explicit/cached rate used) |
| Asset/native currency | The security's own trading currency | `assets.currency` |
| Portfolio base currency | The portfolio's reporting currency | `portfolios.base_currency` |
| Historical/cached FX | A per-trade-date rate from the local `fx_rates` table (`quotes` JSON, GBP-per-unit-foreign keys e.g. `GBPUSD`) | `deriveAssetToBaseRate`, consulted only when no explicit cash value or FX rate exists |

### Authoritative vs. mechanical fields

- **`cash_value`/`cash_ccy` are authoritative** for every cash calculation (`calculateCashBalancesMulti`, `applyCashTxn`) and for Definition B's base-currency cost ledger. They are never re-derived from `settle_value` at read time.
- **`settle_value`/`settle_ccy` are authoritative for native-currency cost basis** (`total_cost`, `avg_price`) and for a resolved SELL's realised-cost conversion basis (via `impliedFxFromSellRow`).
- **`cash_fx_to_portfolio` is never used to recalculate a value, but it _is_ read at replay time as a reliability check** — it is stored as an audit/display field recording what rate was used, and every value consumer reads `cash_value` directly. However, Definition B marks a cross-currency BUY/SELL unreliable unless `cash_fx_to_portfolio` is present and > 0 (§10). On the signed-explicit path it is `cash_value / settleAbs`, which is negative when `cash_value` is negative. On ungated rows (FXM, ordinary TIN/TOT) and SPL it is simply the CSV `fxrate`, unvalidated. The one place a rate is *derived fresh from FX inputs* rather than read back is `deriveAssetToBaseRate`, used only at write time (import/manual-add) to compute what `cash_value` should be when no explicit one exists.
- The `trg_transactions_mirror_settle_to_cash` DB trigger mirrors `settle_value`→`cash_value` (and `settle_ccy`→`cash_ccy`) for BUY/SELL rows **only when `cash_value` is still NULL at write time** — a defensive backstop for direct/manual inserts that bypass the cash-leg resolution entirely; the normal import path always supplies `cash_value` explicitly, so this trigger rarely fires for imported data.

### Same-currency handling

When `assetCcy === baseCcy`, no FX conversion is structurally possible or needed; `cash_fx_to_portfolio` is `1` whenever this path is exercised. As of the third cash-leg fix (§2), this is a **last-resort fallback only** — an explicit `cash_value` (signed or positive-only, depending on type) is always preferred even when currencies match.

### What happens when FX cannot be reliably established

`resolveCashLeg` returns `{status: 'blocked', reason}` rather than fabricating a 1:1 conversion. The import route collects every blocked row into `skippedCashLeg` and **excludes it from the insert batch** — the transaction is simply not imported, reported back to the caller, never silently defaulted. `resolveCashLeg` never invents an FX rate. One engine exception exists: `impliedFxFromSellRow` returns `1` when a SELL's `cash_value` or `settle_value` is zero or missing, even if the currencies differ (§1 SELL, §5). The display layer also defaults a missing FX rate to `1` (`MobilePortfolioView`: `fxRates[ccy] ?? 1`).

---

## 4. Holdings and quantity

All formulas below are from `applyTransactionToHolding` (`src/lib/queries.ts`), the single function responsible for holdings replay; `qty = abs(quantity)` throughout.

| Type | Quantity formula |
|---|---|
| BUY | `total_shares += qty` |
| SELL | `total_shares -= qty` |
| SPL | `total_shares = round(total_shares * split_factor, 6)` |
| TIN (security) | `total_shares += qty` |
| TOT (security) | `total_shares -= qty` |

**Normalisation**: after every transaction, if `total_shares <= 1e-6` it is snapped to exactly `0`, and both `total_cost` and `avg_price` are forced to `0` as well — this prevents floating-point residue from leaving a fully-closed position with a non-zero phantom cost or share count.

### Stock splits and cost basis

A split **never changes `total_cost`**. `avg_price` is purely derived (`total_cost / total_shares`) and moves inversely to the share-count change. A 2-for-1 forward split (`split_factor = 2`) doubles shares and halves `avg_price`; a 1-for-5 reverse split (`split_factor = 0.2`) reduces shares to a fifth and multiplies `avg_price` by 5. Definition B's `base_total_cost` is likewise unchanged; only `base_avg_cost` is rederived.

---

## 5. Cost basis

**HoldingsHub uses weighted-average cost, not FIFO.** This is established directly from `applyTransactionToHolding`'s SELL/TOT branches: cost removed on a disposal is always a *proportion of the single running `total_cost` figure*, never a queue of individual lots.

### Total cost

- BUY: `total_cost += (settle_value in asset ccy, if present) else qty*price+fee`
- TIN (legacy, unresolved): `total_cost += deriveAssetCostForTIN(...)` (settle_value → same-ccy cash_value → qty*price+fee → 0, in that order)
- TIN (resolved transfer): `total_cost += parcel.nativeCost` (frozen — see §7)

### Cost removed on a SELL/TOT (remaining cost)

```
proportion = qty / total_shares_before
costOut    = total_cost_before * proportion
total_cost = total_cost_before - costOut
total_shares = total_shares_before - qty
```

This is exact weighted-average-cost disposal: every unit sold/transferred out is assumed to carry the *current average* cost, not the cost of any specific earlier lot.

### Unit/average cost

`avg_price = total_shares > 0 ? total_cost / total_shares : 0`, recomputed after every transaction (never stored independently).

### Realised cost

Booked only on SELL: `realised_cost += costBasisCash`, where `costBasisCash` is the weighted-average cost basis removed by this SELL, converted into the proceeds currency via `impliedFxFromSellRow` if the proceeds currency differs from the asset currency (`impliedFX = |cash_value| / |settle_value|`, or `1` if currencies match or data is missing).

### Transferred cost basis

See §7 in full. In summary: a **resolved** TIN/TOT (matched or external) inherits/removes cost via a frozen `CostParcel`, captured once at the moment the TOT was first recorded, and applied unconditionally to the destination — never re-derived from transfer-date market value, never dependent on import order.

**Nothing in the codebase implements or references FIFO, LIFO, or specific-lot identification anywhere in the holdings/cost-basis engine.** This was established by reading `applyTransactionToHolding`, `applyTransferOut`/`applyTransferIn`, and the full `tests/financial/current-behaviour.positions.spec.ts` suite (explicitly: "T2 — multiple BUYs / average cost... blends two lots by weighted average cost, not FIFO").

---

## 6. P&L

All formulas from `applyTransactionToHolding`'s realised branch (native ledger) and its Definition B block (base-currency ledger).

| Figure | Native formula | Base-currency (Definition B) formula |
|---|---|---|
| Realised proceeds | `realised_proceeds += proceedsAmount` (SELL/DIV/INT) | `base_realised_proceeds += cashVal` (SELL only) |
| Realised cost | `realised_cost += costBasisCash` (SELL only) | `base_realised_cost += costOut` (SELL only, proportional to `base_total_cost`) |
| Realised P&L | `realised_value += proceedsAmount - costBasisCash` (SELL); `+= proceedsAmount` (DIV/INT); `-= abs(fee)` (FEE) | `base_realised_value += cashVal - costOut` (SELL only, when reliable) |
| Unrealised P&L | **Not computed anywhere in the accounting engine.** Computed independently at the display layer — see below. | Same — no base-currency unrealised figure exists in the engine either |
| Current market value | **Not computed in the accounting engine.** | — |
| Total P&L | No single "total P&L" field exists. The display layer computes `marketValue - totalCost` (unrealised) independently of `realised_value`; nothing sums the two into one figure in the engine. | — |

### Market value / unrealised P&L — a display-layer calculation, not an engine calculation

Unlike every other figure in this document, **market value and unrealised P&L are not produced by `queries.ts`**. They are computed independently, using live prices, in **three separate presentation components**:

- `src/components/PerPortfolioTable.tsx`: `marketValue = h.total_shares * price * multiplier`; `profitLoss = marketValue - totalCost`
- `src/components/TotalHoldingsTable.tsx`: same formula via a local `calcMarketValue(h, prices)` helper
- `src/app/mobile/MobilePortfolioView.tsx`: same formula via a local `mv(h)` callback; `unrealised = mv(h) - h.total_cost`

All three use the identical `total_shares × livePrice × price_multiplier` formula, but as three independent implementations rather than one shared, tested function. See §15.

### Sign conventions

- A BUY's cash effect is always negative (outflow); a SELL's is always positive (inflow).
- `realised_value` is positive for a gain, negative for a loss, in every branch (SELL, DIV/INT, FEE).
- FXM's `cash_value` carries its own natural sign: a realised FX gain is positive, a realised FX loss is negative, passed through completely unchanged.
- `base_realised_value`/`base_realised_cost`/`base_realised_proceeds` follow the same sign conventions as their native counterparts, denominated in the portfolio's base currency instead.

### Native vs. portfolio-base values

Every `Holding` in principle carries two parallel sets of figures:

- **Native**: `total_cost`, `avg_price`, `realised_cost/proceeds/value` — denominated in the *asset's own* currency (except `realised_*`, which is actually denominated in the *contributing transaction's proceeds currency* — usually, but not necessarily, the portfolio base currency; see `Holding.realised_ccy` and §9).
- **Base (Definition B)**: `base_total_cost`, `base_avg_cost`, `base_realised_cost/proceeds/value` — denominated in the *portfolio's* base currency, sourced only from `cash_value`/`cash_ccy` (never retranslated from the native ledger using a spot rate).

---

## 7. Transfers

The `transfers` table (see `supabase/migrations/20260913091500_create_transfers_table.sql`) models an in-specie security transfer with a five-state machine, enforced by DB CHECK constraints as well as the pure builder functions in `src/lib/transfers.ts`.

### States

| Status | `in_transaction_id` | `out_transaction_id` | `native_cost`/`native_ccy` | Meaning |
|---|---|---|---|---|
| `pending_out` | NULL | required | required (frozen at capture) | A TOT has been imported; its source-side cost is captured, awaiting a matching TIN |
| `pending_in` | required | NULL | NULL (enforced by `chk_native_cost_by_status`) | A TIN has been imported; shares/quantity known, **no cost yet** |
| `matched` | required | required | required | Both legs confirmed as the same transfer — an in-app-to-in-app move |
| `external_in` | required | NULL | required | A TIN whose source is outside HoldingsHub (or otherwise unlinkable), with an explicit, asserted historical cost |
| `external_out` | NULL | required | required | A TOT whose destination is outside HoldingsHub (or temporarily unlinked), cost already captured |

Additional fields: `base_cost`/`base_ccy` (optional, portfolio-base equivalent), `base_cost_status` ∈ {`verified`, `unreliable`} (required exactly when `base_cost` is non-null — `chk_base_cost_status_pairing`; also `base_cost` requires `native_cost` non-null — `chk_base_cost_requires_native`), `linked_by` ∈ {`manual`, `import_suggested`, `historical_repair`}.

Both `in_transaction_id` and `out_transaction_id` carry a UNIQUE constraint (`uq_transfers_in_transaction`, `uq_transfers_out_transaction`) — a transaction can never participate in more than one transfer record.

### How a matched transfer preserves cost basis between portfolios

1. At TOT-import time, `captureTransferOut` (`src/lib/transfers.ts`) calls `applyTransferOut` (`src/lib/transferCostBasis.ts`) against the source holding's state *at that exact point in its replay history* — removing shares/cost via the identical weighted-average formula `applyTransactionToHolding`'s own TOT branch would use, and returning a self-contained `CostParcel { quantity, nativeCost, nativeCcy, baseCost?, baseCcy? }`. This parcel is a plain data snapshot — later changes to the source holding cannot retroactively affect it.
2. The parcel is persisted as the `pending_out` row's `native_cost`/`native_ccy`(/`base_cost`/`base_ccy`).
3. When the matching TIN is confirmed (`matchTransfer`), the row transitions to `matched`, carrying the frozen cost fields forward **completely unchanged** — matching never recomputes cost.
4. At holdings-replay time, `resolveTransferParcelForTin` (`src/lib/holdingsTransferIntegration.ts`) looks up the resolved transfer by the TIN's transaction id and returns the same frozen parcel; `applyTransactionToHoldingResolvingTransfers` (`src/lib/queries.ts`) applies it via `applyTransferIn` **instead of** the legacy TIN branch — crediting the destination with exactly the cost that left the source, regardless of how much time passed or in what order the two legs were imported.

The TOT side's ordinary `applyTransactionToHolding` replay still runs unconditionally (removing shares/cost from the source exactly as always) — what a *resolved* TOT additionally gets is a Definition B reliability correction (§10), not a different native-cost calculation.

### How an `external_in` obtains its historical cost basis

`confirmExternalIn` (`src/lib/transfers.ts`) requires an **explicit** `nativeCost`/`nativeCcy` — there is no code path that derives an `external_in` cost from transfer-date market value, price lookups, or any other automatic source. The cost must be supplied by a human (or a script acting under explicit human authorisation) asserting a known historical figure. `base_cost`/`base_ccy` are optional; if supplied, `base_cost_status` is set to `'verified'` — the same trust level as a manual entry anywhere else in the app.

This is exactly how the five March-2024 migrated-ISA parcels (HVO, UKW, PYPL, TSLA, VOD) were repaired during this engagement: their historical costs were independently reconstructed from recovered raw broker Flex exports, cross-checked against externally-supplied figures, and only then written via this exact mechanism.

### Legitimate £0 cost-basis transfers (the POLB.L case)

`confirmExternalIn`'s validation is `cost.nativeCost == null || !isFinite(cost.nativeCost)` — **`0` passes this check** (`0 != null` and `isFinite(0)` is true). A transfer whose genuine historical cost is £0 (POLB.L: an in-specie distribution received at zero cost) is recorded with `native_cost = 0`, `base_cost_status = 'verified'` — **reliable**, not missing. The reliability model (§10) treats "verified zero" and "unknown/missing" as structurally distinct states: `base_cost_status IS NULL` (no cost ever supplied) is different from `base_cost = 0 AND base_cost_status = 'verified'` (a cost was explicitly asserted, and it happens to be zero).

### Which statuses live holdings replay actually consults

`RESOLVED_STATUSES = {matched, external_in}` (TIN side) and `RESOLVED_OUT_STATUSES = {matched, external_out}` (TOT side) — defined in `holdingsTransferIntegration.ts`. `pending_in`/`pending_out` rows are **never** fetched for holdings replay at all (`getPortfoliosWithHoldingsAndCash`'s transfers query filters `.in('status', ['matched','external_in','external_out'])`) — they simply have no effect on holdings, and the underlying TIN/TOT falls through to legacy `applyTransactionToHolding` behaviour exactly as if no transfer record existed.

Separately, `transferImportIntegration.ts`'s candidate-suggestion pool for future-import matching is filtered to `.in('status', ['pending_out','pending_in'])` only — once a row reaches `matched`/`external_in`/`external_out`, it is permanently excluded from ever being resurfaced as a match candidate.

---

## 8. Portfolio cash

### The live algorithm

`calculateCashBalancesMulti` (`src/lib/queries.ts`), called by both `getPortfoliosWithHoldingsAndCash` and `getAllHoldingsAndCashSummary`. Per transaction, in a multi-currency map (`{GBP, USD, EUR}`):

| Type | Sign / rule | Gated on `isCashAsset`? |
|---|---|---|
| BAL | `cash[ccy] += cash_value` (signed, magnitude and sign both from `cash_value`; quantity **not** consulted) | No |
| DIV, INT | `cash[ccy] += abs(cash_value)` | No |
| DEP | `cash[ccy] += abs(cash_value)` | Yes (`requireCashAssetForCashRows`, default true) |
| WIT | `cash[ccy] -= abs(cash_value)` | Yes |
| FEE | `cash[ccy] -= abs(cash_value)` | Yes |
| OTR | `cash[ccy] += cash_value` (signed) | **No** |
| FXM | `cash[ccy] += cash_value` (signed) | **No** |
| BUY | `cash[ccy] -= abs(cash_value)`, else fallback `-(price*qty+fee)` in asset ccy | N/A (not asset-gated) |
| SELL | `cash[ccy] += abs(cash_value)`, else fallback `+(price*qty-fee)` in asset ccy | N/A |
| TIN (CASH.\*) | `cash[ccy] += abs(cash_value)` | Yes (true by definition for this row) |
| TOT (CASH.\*) | `cash[ccy] -= abs(cash_value)` | Yes |
| TIN/TOT (ordinary security), SPL | No cash effect | — |

Final balances are rounded to 2dp and any currency bucket within `1e-9` of zero is dropped from the result entirely.

### All implementations found, and their status

| Implementation | File | Status |
|---|---|---|
| `calculateCashBalancesMulti` | `src/lib/queries.ts` | **Live** — the canonical implementation, used by every current dashboard/API cash figure |
| `applyCashTxn` | `src/lib/portfolio-series-cash.ts` | **Live, duplicated but equivalent** — extracted from `src/app/api/portfolio-series/route.ts` for unit-testability (Next.js route files may only export HTTP handlers). Powers the historical cash-series/charting feature. Each type branch is a line-for-line match of `calculateCashBalancesMulti`'s corresponding branch. `tests/financial/portfolio-series-cash.spec.ts` compares the two functions directly for FXM only; the other branches are tested separately. |
| `calculateCashBalancesISA_GBP` | `src/lib/queries.ts` | **Dead code** — zero call sites found anywhere in `src/`. A GBP-only, single-currency precursor to `calculateCashBalancesMulti`. Contains an inert sign-handling divergence for BAL rows (`sign = quantity >= 0 ? +1 : -1`, vs. the live implementation's `cash_value`-only signed BAL) that has no effect on anything since the function is never called. |

Per instruction, none of these duplicates were removed or altered in producing this document.

---

## 9. Portfolio and Global calculations

### Security market value

`total_shares × livePrice × price_multiplier`, computed independently in each of the three display components named in §6 — not part of the accounting engine.

### Portfolio market value / total portfolio value

Not computed as a single named function anywhere found in the audit; the per-portfolio tables sum each holding's independently-computed market value plus that portfolio's cash balance at the presentation layer.

### Portfolio cash

§8, scoped to `portfolioTxns = txns.filter(t => t.portfolio_id === pid)` before being passed to `calculateCashBalancesMulti`.

### Cost / gain-loss

Per-holding, from §5/§6 (`total_cost`, `realised_value`, and the display-layer `marketValue - totalCost` unrealised figure).

### Global aggregation across portfolios

`getAllHoldingsAndCashSummary` (`src/lib/queries.ts`) **does blend holdings across every portfolio** — one `Holding` entry per ticker, built by replaying every transaction for that ticker from every portfolio together (excluding `DIV`/`INT` and `CASH.*` rows, same as the per-portfolio path), sorted by the same `compareTxForHoldings` ordering.

Cost/P&L handling when blending:

- **Native ledger** (`total_cost`, `realised_cost/proceeds/value`): blended without any currency reconciliation — this function does not attempt to convert between currencies at all in the native ledger; a ticker traded in two portfolios with different base currencies still produces one native `total_cost` figure (in the *asset's own* currency, which is unambiguous even across portfolios, since an asset has exactly one currency).
- **`realised_ccy`**: explicitly tracked per ticker via `resolveRealisedCcy` — a single ISO code if every contributing portfolio's realised-affecting transactions shared one base currency, `'MIXED'` if genuinely not, `undefined` if no realised-affecting activity exists. Never silently guessed.
- **Definition B base-currency ledger** (`base_total_cost`, `base_realised_*`): only activated for a ticker (`holding.base_currency` set) when a pre-scan (`resolveDefinitionBBaseCurrencies`) proves every portfolio that ever fed it a BUY/SELL/TIN/TOT shares exactly one base currency. A genuinely mixed-base-currency ticker is left with `base_currency` unset entirely — the dormant/legacy path, never a guessed blended figure.

### Per-portfolio vs. Global Definition B activation — an important asymmetry

**Per-portfolio** (`getPortfoliosWithHoldingsAndCash`): Definition B is **unconditionally live** for every holding — `base_currency` is set to the portfolio's own `base_currency` before replay begins, since a single portfolio has exactly one base currency by construction. Every holding returned by this function in production today carries populated `base_total_cost`, `base_cost_reliable`, `base_realised_*` fields.

**Global** (`getAllHoldingsAndCashSummary`): Definition B is **conditionally** activated per ticker, only when unambiguous, as described above.

Several code comments elsewhere in the codebase (`holdingsTransferIntegration.ts:85`, `transferCostBasis.ts:57–60`, `queries.ts:46`, `queries.ts:1031`, `definitionBDisplay.ts:11`) describe Definition B as "dormant" or state "no live Holding sets base_currency" — **this is stale relative to the current implementation** for the per-portfolio path. See §15.

---

## 10. Reliability model

Reliability is tracked at two independent granularities per holding, both defined on the `Holding` type (`src/lib/queries.ts`):

### `base_cost_reliable` — governs the CURRENT OPEN POSITION only

- Starts `true`.
- Set `false` the moment a contributing BUY/SELL lacks a reliable base-currency cash leg: `cash_value` missing, wrong currency, or (cross-currency) `cash_fx_to_portfolio` missing/non-positive.
- Set `false` unconditionally by any **legacy** (unresolved) TIN/TOT.
- Corrected back to `true` by a **resolved** TOT (matched/external_out) with a known `baseCost`, *unless* the holding was already unreliable before this TOT for an unrelated reason, or this TOT closed the position to exactly zero (the full-close reset already handles that case).
- **Legitimately resets to `true`** whenever `total_shares` reaches exactly `0` — there is no open cost left to distrust, and a later fresh BUY starts an independently-verifiable snapshot.
- Says nothing about past realised figures — that is `base_realised_reliable`'s job.

### `base_realised_reliable` — governs the CUMULATIVE, LIFETIME realised total

- Starts `true`.
- Set `false` permanently the moment any disposal's contribution to `base_realised_value/_cost/_proceeds` had to be skipped because the open cost basis was unreliable at that moment.
- **Never resets** — unlike `base_cost_reliable`, a skipped contribution is a permanent, unrecoverable gap in a running lifetime total, even across a full close and later reopening of the same ticker.

### Definitions

| State | Meaning |
|---|---|
| **Reliable** | `base_cost_reliable`/`base_realised_reliable` is `true`; the figure is safe to display as verified |
| **Unreliable** | The flag is `false`; the corresponding `base_*` figure must never be displayed as verified (`baseCostContribution`/`baseRealisedContribution` in `definitionBDisplay.ts` return `{value: 0, incomplete: true}` for these — callers must treat `incomplete` as a hard signal, not silently sum a real zero) |
| **Provisional** | Not a distinct engine state; a `pending_in`/`pending_out` transfer is the closest analogue — its TIN/TOT falls through to legacy behaviour (unreliable base ledger) until resolved |
| **Blocked** | A `resolveCashLeg` outcome (§2), not a holdings-reliability state — the *transaction itself* is refused import, never reaching the ledger at all |

### Specific states covered

- **Missing FX**: a cross-currency BUY/SELL with no usable `cash_fx_to_portfolio` marks `base_cost_reliable = false` for that contribution.
- **Unmatched transfer** (`pending_in`/`pending_out`): TIN/TOT falls through to legacy `applyTransactionToHolding`, which unconditionally sets `base_cost_reliable = false`.
- **Frozen transfer cost**: a `matched`/`external_in`/`external_out` transfer's `CostParcel` is trusted as reliable (native side always; base side only if `parcel.baseCost` is present).
- **Confirmed zero cost**: `base_cost = 0` with `base_cost_status = 'verified'` is reliable — see §7's POLB.L discussion. This is structurally distinct from `base_cost_status IS NULL` (never asserted).
- **Currency mismatch**: `applyTransferIn` throws (rather than silently converting) if the destination holding's currency doesn't match the parcel's — caught by `applyTransactionToHoldingResolvingTransfers` and logged, falling back to legacy TIN behaviour for that row rather than crashing the whole replay.

---

## 11. Precision and rounding

- **Holdings figures**: `total_shares`, `total_cost` and (only while `base_cost_reliable` is true) `base_total_cost` are rounded to **6 decimal places** after every transaction, as are the `CostParcel` figures produced by `applyTransferOut`. The helper is `round(n, dp=6)` (`Math.round(n * 10^dp) / 10^dp`), with identical local copies in `queries.ts` and `transferCostBasis.ts`. Rounding is skipped when a position fully closes, because the figures are then forced to exactly `0`. `avg_price` and `base_avg_cost` are **not** rounded; each is recalculated as cost ÷ shares from the already-rounded figures.
- **Cash balances** (`calculateCashBalancesMulti`, `calculateCashBalancesISA_GBP`): rounded to **2 decimal places** (`Math.round(n * 100) / 100`) — this is output-level rounding, applied once, at the point the balance map is returned, not repeatedly through intermediate steps. It is separate from display formatting (below).
- **Display formatting**: `formatCurrency` (`src/lib/formatCurrency.ts`) formats every displayed money figure to 2 dp. This is a third, presentation-only rounding layer.
- **Realised P&L figures**: not independently rounded in `applyTransactionToHolding` — they accumulate at full floating-point precision across every contributing transaction (visible directly in retained DEV figures used for the PROD reconciliation, e.g. `realised_cost: 26162.773912580295`).
- Rounding is **calculation-level for holdings** (6dp, baked into the replay so subsequent proportional calculations use an already-rounded base), **output-level for cash** (2 dp, applied once when the balance map is returned), and **presentation-level** for every displayed figure (`formatCurrency`).
- **Tolerance used by tests/reconciliation**: unit tests predominantly use `toBeCloseTo(expected, 6)` for native/base cost figures and `toBeCloseTo(expected, 2)` (or looser, e.g. `1`) for cash/display-oriented figures. The PROD reconciliation script used a `1e-4` tolerance for cost/P&L comparisons and `1e-2` (one penny) for cash comparisons.

### Could a displayed £0.01 difference be presentation rather than accounting?

**Yes, plausibly.** Because native/base cost accumulates at up to 6dp of precision through the full transaction history but cash is rounded to 2dp at each `calculateCashBalancesMulti` call, and because `total_cost` is only rounded (not truncated) when non-zero, a genuine sub-penny residue can exist in the underlying `total_cost`/`realised_*` figures that only becomes visible as a 1p rounding difference when two different code paths format the same underlying (slightly different at the 6th decimal) figure to 2dp for display. This was not independently proven with a constructed example during this audit — flagged as a plausible mechanism based on the precision model, not a confirmed defect. See §15.

---

## 12. Import versus accounting responsibilities

### Core accounting responsibility (never the importer's)

- Weighted-average cost-basis maintenance (§5)
- Realised P&L computation, in both the native ledger and the Definition B base-currency ledger (§6). Unrealised P&L and market value are **not** calculated by the accounting engine. The display layer calculates them from engine outputs (`total_shares`, `total_cost`) and live prices (§6, §9, §15 item 5).
- Cash-leg FX resolution precedence and blocking (§2)
- Transfer cost-parcel freezing and crediting (§7)
- Reliability-flag maintenance (§10)
- Calculation-level rounding of holdings figures to 6 dp (`total_shares`, `total_cost`, `base_total_cost` while reliable, and transfer `CostParcel` figures), and the single 2 dp rounding of cash balances when `calculateCashBalancesMulti` returns them (§11). Display formatting, such as `formatCurrency`'s 2 dp output, belongs to the presentation layer. It is not an accounting responsibility.

### Importer responsibility

The importer (`src/app/api/import-transactions/route.ts`) is responsible for:

1. **Canonicalising** whatever type label a broker export uses into one of the twelve canonical types (§1).
2. **Ticker resolution**: exact match against `assets.ticker`/`resolved_ticker` (including a `.L`-suffix toggle), then an explicit `asset_aliases` row, else treated as a new ticker requiring metadata confirmation (`src/lib/assetResolution.ts`). The importer never guesses or heuristically strips a suffix.
3. **Supplying `cash_value`** (the CSV `cash_value` column), which the route treats as already being in the portfolio's base currency. `cash_ccy` is not read from the CSV. It is always set to the portfolio's base currency. For BUY/SELL it must be the positive net cash amount; for a SELL, that is net proceeds after commission (§2).
4. **`settle_value`/`settle_ccy` are not importer inputs.** The route reads no such CSV columns. It always sets `settle_value = quantity × price + fee` (0 for SPL) and `settle_ccy` to the asset's currency. For imported rows, native BUY/TIN cost basis therefore always comes from `quantity × price + fee`. `deriveAssetCostForTIN`'s fallbacks (b)–(d) are reachable only for rows written by other means.
5. **Assigning strictly-increasing `created_at` timestamps** within one import batch (1ms apart, in CSV row order) — required because `compareTxForHoldings`/`compareForReplay` use `(date, created_at, type-priority, id)` as their ordering key, and a single-batch INSERT would otherwise give every row an identical `created_at`, collapsing the ordering to an unpredictable UUID tiebreak that can misplace a same-day TOT relative to its intended position.
6. **Never deleting or replacing existing transaction rows** — the import route is purely additive (verified directly: zero `DELETE`/`UPDATE` statements against `transactions` anywhere in the route). "Replacing a year's data" is exclusively an external, separately-scoped operation.

### Minimum/optional fields per transaction type (the contract for Trading 212 and future brokers) (guidance, not enforced by the route)

| Type | Required | Optional but recommended when broker supplies it |
|---|---|---|
| BUY/SELL | `portfolio`, `ticker`, `type`, `date_time`, `quantity`, `price` | `fee`; `cash_value` (positive, base ccy; for a SELL, net proceeds); `fxrate` |
| DIV/INT/DEP/WIT/FEE/OTR | `portfolio`, `ticker`, `type`, `date_time`, `cash_value`, **and** `quantity`/`price`/`fee` such that `quantity × price + fee ≠ 0` (else BLOCKED, §2) | `fxrate` (used only when `cash_value` is blank) |
| FXM | `portfolio`, `ticker` (a `CASH.*` ticker), `type`, `date_time`, `cash_value` (signed, already in base ccy) | none. Not enforced: the route does not check the ticker is `CASH.*`. If `cash_value` is blank, `resolveUngatedCashValue` falls back to `quantity × price + fee` |
| TIN/TOT (security) | `portfolio`, `ticker`, `type`, `date_time`, `quantity` | `price`/`fee`. `settle_value`/`settle_ccy` are not read from the CSV. An unresolved TIN's native cost is `quantity × price + fee`, and is zero if price and fee are blank. A resolved transfer uses the frozen parcel (§7) |
| TIN/TOT (`CASH.*`) | `portfolio`, `ticker` (`CASH.GBP`/`CASH.USD`/`CASH.EUR`), `type`, `date_time`, `cash_value` (must be positive); also needs `quantity × price + fee ≠ 0` | — |
| SPL | `portfolio`, `ticker`, `type`, `date_time`, `quantity` holding the split ratio (`> 0`). There is no `split_factor` CSV column | quantity/price/fee are zeroed regardless of input |

For every gated cash-moving type, a usable explicit `cash_value` is the field that most determines correctness. The importer treats `cash_value` as already being in the portfolio's base currency. It reads no `cash_ccy` column. "Usable" means present, for DIV/INT/DEP/WIT/FEE/OTR, and strictly positive for BUY/SELL and `CASH.*` TIN/TOT. Without one, `resolveCashLeg` falls back in this order:

1. **Same currency** (asset ccy = base ccy): `cash_value = |qty*price + fee|`.
2. **Cross currency**: explicit `fxrate` × `|qty*price + fee|`, else cached `fx_rates` rate × `|qty*price + fee|`, else the row is BLOCKED and not imported.

For a SELL, every one of these fallbacks overstates net proceeds by `2 × fee` (× rate when cross-currency), because the fallback amount always adds the fee (§2). Nothing warns about this at import time: a same-currency SELL is imported silently at the wrong value. For signed-flag types, a missing `cash_value` gives a positive magnitude derived from `qty*price + fee`. For OTR, whose stored sign is used at read time, that means a charge would be stored as an inflow.

---

## 13. Source-code traceability

| Calculation | File | Function(s) | Purpose | Test coverage |
|---|---|---|---|---|
| Cash-leg FX resolution | `src/lib/cashLeg.ts` | `resolveCashLeg`, `resolveRowCashLeg`, `shouldApplyCashLegGate`, `resolveUngatedCashValue`, `deriveAssetToBaseRate` | Decide the base-currency cash effect of any cash-moving row | `tests/financial/cash-leg.spec.ts` |
| Holdings replay (native + Definition B) | `src/lib/queries.ts` | `applyTransactionToHolding` | Per-transaction quantity/cost/realised update | `tests/financial/current-behaviour.positions.spec.ts`, `tests/financial/current-behaviour.fx-realised.spec.ts`, `tests/financial/definitionB-base-cost.spec.ts`, `tests/financial/realisedValueCurrencyDomain.spec.ts` |
| Transfer-aware holdings dispatch | `src/lib/queries.ts` | `applyTransactionToHoldingResolvingTransfers` | Choose frozen-parcel vs. legacy TIN/TOT behaviour | `tests/financial/holdingsTransferIntegration.spec.ts` |
| Cash balances (live) | `src/lib/queries.ts` | `calculateCashBalancesMulti` | Multi-currency portfolio cash | `tests/financial/current-behaviour.cash.spec.ts`, `tests/financial/reconciliation.spec.ts` |
| Cash balances (series/duplicate) | `src/lib/portfolio-series-cash.ts` | `applyCashTxn` | Historical cash-series charting | `tests/financial/portfolio-series-cash.spec.ts` |
| BAL reconciliation preview | `src/lib/queries.ts` | `computeBalancePreview` | Cash-balance-adjustment tool | `tests/financial/reconciliation.spec.ts` |
| Per-portfolio holdings+cash | `src/lib/queries.ts` | `getPortfoliosWithHoldingsAndCash` | Dashboard/mobile per-portfolio view; supports `asOf` point-in-time cutoff | Exercised throughout the PROD reconciliation script; no dedicated unit spec file |
| Global holdings+cash | `src/lib/queries.ts` | `getAllHoldingsAndCashSummary` | Cross-portfolio blended view | `tests/integration/transferAuthorizationAndFinancial.spec.ts` (partial, via real DEV data) |
| Transfer cost-parcel arithmetic | `src/lib/transferCostBasis.ts` | `applyTransferOut`, `applyTransferIn` | Freeze/credit cost basis across a linked transfer | `tests/financial/transfer-cost-basis.spec.ts` |
| Transfer state-machine builders | `src/lib/transfers.ts` | `captureTransferOut`, `capturePendingIn`, `matchTransfer`, `confirmExternalOut`, `confirmExternalIn` | Pure validators/constructors for each transfer status transition | `tests/financial/transfers.spec.ts` |
| Transfer/holdings bridge (pure lookups) | `src/lib/holdingsTransferIntegration.ts` | `indexResolvedTransfersByTinTransactionId`, `indexResolvedTransfersByOutTransactionId`, `resolveTransferParcelForTin`, `resolveTransferParcelForTot` | Resolve a transaction id to its frozen parcel, if any | `tests/financial/holdingsTransferIntegration.spec.ts` |
| Import → transfer persistence | `src/lib/transferImportIntegration.ts` | `selectTransferRelevantRows`, `captureTransferOutsForGroup`, `processImportedTransfers` | Create `pending_in`/`pending_out` rows for newly-imported TIN/TOT | `tests/financial/transferImportIntegration.spec.ts` |
| Match suggestion ranking | `src/lib/transferMatching.ts` | `suggestTransferMatches` | Rank opposite-leg pending candidates (never auto-confirms) | `tests/financial/transferMatching.spec.ts` |
| Definition B currency/activation rules | `src/lib/definitionBDisplay.ts` | `baseCostContribution`, `baseRealisedContribution`, `resolveDefinitionBBaseCurrencies`, `resolveRealisedCcy`, `resolveUnambiguousBaseCurrency` | Aggregation-safe base-currency contribution rules | `tests/financial/definitionBDisplay.spec.ts`, `tests/financial/definitionBActivation.spec.ts` |
| Import route (canonicalisation, insert, wiring) | `src/app/api/import-transactions/route.ts` | `POST` (preview/confirm stages), `canonicalizeType` | End-to-end CSV → transaction rows → transfer persistence | Exercised live throughout the PROD rebuild; no isolated unit spec (integration-level only) |
| Ticker resolution | `src/lib/assetResolution.ts` | `resolveImportTicker` | Broker ticker → canonical asset | `tests/import/asset-resolution.spec.ts` |
| Market value / unrealised P&L | `src/components/PerPortfolioTable.tsx`, `src/components/TotalHoldingsTable.tsx`, `src/app/mobile/MobilePortfolioView.tsx` | inline (`marketValue`/`mv`) | Display-layer live-price valuation | No dedicated unit test found for the market-value/unrealised formula itself |
| DB-level cash mirror | `supabase/migrations` (schema function) | `trg_transactions_mirror_settle_to_cash` | Backstop: mirror `settle_value`→`cash_value` for BUY/SELL when `cash_value` is NULL | No application-level test (DB trigger) |

---

## 14. Worked examples

All figures follow the formulas documented above exactly; none introduce a new rule.

### GBP BUY

BUY, qty 100, price £10.00, fee £5.00, GBP portfolio, GBP asset.
`total_cost += 100*10 + 5 = £1,005.00`; `total_shares = 100`; `avg_price = £10.05`.
Cash: `-£1,005.00` (explicit `cash_value` if supplied, else the same fallback formula).

### GBP SELL including commission

Position: 100 shares, `total_cost = £1,005.00` (avg £10.05). SELL qty 40, price £12.00, fee £3.00, explicit `cash_value = £477.00` (`40*12 - 3`).
Cost removed: `proportion = 40/100 = 0.4`; `costOut = £1,005.00 * 0.4 = £402.00`.
`realised_cost += £402.00`; `realised_proceeds += £477.00`; `realised_value += £477.00 - £402.00 = £75.00`.
Cash: `+£477.00` (the explicit, correctly-signed value — **not** the naive `40*12+3 = £483.00`, which would overstate cash by 2×fee if the same-currency fallback were used instead of the explicit value).

### USD security bought from a GBP portfolio

BUY, qty 10, price $150.00, fee $2.00 (AAPL, USD asset), GBP portfolio. Broker-supplied `cash_value = £1,185.98`, `cash_ccy = GBP`, implied `cash_fx_to_portfolio = 1,185.98 / 1,502.00 ≈ 0.7896`.
Native cost: `settle_value` if present in USD, else `10*150+2 = $1,502.00`; `total_cost = $1,502.00` (native ledger, USD).
Base (Definition B): `base_total_cost += £1,185.98` (from `cash_value`, since `cash_ccy = baseCcy = GBP` and `cash_fx_to_portfolio` is present and positive → `reliableRow = true`).

### DIV

DIV, `cash_value = £42.50`, `cash_ccy = GBP`, attached to a GBP holding.
Cash: `+£42.50`. `resolveCashLeg` stores `cash_value = 42.50` via the signed-explicit path. `calculateCashBalancesMulti` then adds `abs(cash_value)`, so a stored `-42.50` would also give `+£42.50`. The CSV row also needs a non-zero `quantity × price + fee`, or the row is BLOCKED (§2). If called directly via `applyTransactionToHolding` (not the live per-portfolio replay, which excludes DIV via `ALWAYS_CASH_TYPES`): `realised_value += £42.50`, `realised_proceeds += £42.50`.

### WIT / FEE

WIT, CSV `cash_value = -200.00`, `CASH.GBP` ticker, GBP portfolio.
*Write time:* WIT is in `CASH_LEG_TRANSACTION_TYPES`, so `resolveCashLeg` takes step 2 (signed explicit) and stores `cash_value = -200.00` exactly as supplied, `cash_ccy = GBP`.
*Read time:* `calculateCashBalancesMulti` does not use the stored sign for WIT. It applies WIT's own direction: `cash[GBP] -= abs(-200.00)`, giving **−£200.00**.
The stored sign therefore makes no difference to cash. A WIT stored as `+200.00` (as all WIT rows in the 2026-09-12 DEV snapshot are) gives the same −£200.00.

FEE, CSV `cash_value = -5.00`, `CASH.USD` ticker, **USD-base** portfolio. Stored `cash_value = -5.00`, `cash_ccy = USD`. Cash: `cash[USD] -= abs(-5.00)`, giving **−$5.00**. In a GBP-base portfolio, `resolveCashLeg` would store `cash_ccy = GBP`, because the importer treats `cash_value` as already in base currency. The debit would then hit the GBP bucket, not USD.

### FXM

FXM, `cash_value = -£12.34` (a realised FX loss), `CASH.GBP` ticker, GBP portfolio.
`resolveUngatedCashValue(-12.34, ...)` returns `-12.34` unchanged. Cash: `cash[GBP] += -£12.34`. Never routed through `resolveCashLeg`; never `Math.abs`'d.

### Stock split

Position: 200 shares, `total_cost = £2,000.00` (avg £10.00). SPL, `split_factor = 2` (2-for-1).
`total_shares = round(200 * 2) = 400`; `total_cost` unchanged at `£2,000.00`; `avg_price = £2,000.00 / 400 = £5.00`.

### Matched security transfer

Source holding (portfolio A): 1,000 shares, `total_cost = £5,000.00` (avg £5.00). TOT of 200 shares.
`applyTransferOut`: `proportion = 200/1000 = 0.2`; `nativeCost = round(£5,000.00 * 0.2) = £1,000.00`. Source holding: `800 shares, £4,000.00 cost`. Parcel: `{quantity: 200, nativeCost: £1,000.00, nativeCcy: 'GBP'}`.
Destination holding (portfolio B, same asset, empty before this TIN): `applyTransferIn` credits `total_shares += 200`, `total_cost += £1,000.00` — destination avg cost `£5.00`, exactly matching the source's average at the moment of transfer, regardless of what portfolio B's own price history might otherwise have suggested.

### External-in security transfer

`external_in` confirmation with `nativeCost = £11,974.536`, `nativeCcy = 'GBP'` (the real HVO March-2024 parcel from this engagement). Destination holding credited `total_shares += 44,000`, `total_cost += £11,974.536` via `applyTransferIn` — cost sourced entirely from the explicitly-asserted historical figure, never from any market-price lookup at the transfer date.

### Genuine zero-cost transfer

`external_in` confirmation with `nativeCost = 0`, `nativeCcy = 'GBP'`, `base_cost = 0`, `base_ccy = 'GBP'` (the real POLB.L parcel: 48,337 shares received via in-specie distribution). `confirmExternalIn` accepts `0` (passes `isFinite(0)` and `0 != null`). Destination holding: `total_shares += 48,337`, `total_cost += 0` — the holding is fully valid and `base_cost_reliable` stays `true`; `total_cost = 0` is a verified fact, not a data gap.

---

## 15. Known technical debt / edge cases

1. **FEE attached directly to a security — inconsistent cash/native/base effect.** A security-attached FEE reduces native `realised_value` (via `applyTransactionToHolding`) but has **zero cash effect** (`calculateCashBalancesMulti`'s FEE branch is gated on `isCashAsset`) and **zero effect on `base_realised_value`** (the Definition B block has no FEE case). This is explicitly self-documented in the codebase as a known, deliberately-unfixed gap: `tests/financial/current-behaviour.cash.spec.ts` "T12b" and `tests/financial/target-spec.pending.spec.ts` ("FEE workstream — stabilisation plan decision 1", currently `it.skip`). Not fixed by this audit.

2. **BUY/SELL no-explicit-cash fallback — coverage exists at the cash-leg unit level, not in the read-time cash calculation.** Neither the BUY nor the SELL fallback inside `calculateCashBalancesMulti` has a test (no test found). `cash-leg.spec.ts` (79 tests in total, covering all of `resolveCashLeg`) tests the write-time fallbacks in isolation. `tests/financial/current-behaviour.positions.spec.ts`'s T1 BUY test does not supply an explicit `cash_value` and exercises the `qty*price+fee` fallback for **cost basis** only. The read-time fallback is also largely shadowed: the import route never stores a NULL `cash_value` for BUY/SELL, and the `mirror_settle_to_cash` trigger fills NULLs from `settle_value`. Flagged as a coverage gap, not a confirmed defect — the third cash-leg fix's own investigation found every real same-currency BUY row in the six-year IBKR dataset already numerically identical either way.

3. **Manual Add/Edit transaction paths.**
   - The manual **Add** form (`src/app/transactions/page.tsx`, `handleCreate`) is genuinely restricted to BUY/SELL only (`<select>` hardcoded to those two options, TypeScript-typed `'BUY'|'SELL'`), so its `resolveCashLeg` call omits `allowSignedExplicitCash`. Leaving out the signed flag is correct. However, the Add form lets a user save a same-currency SELL with a blank `cash_value`, and that is stored as `qty*price+fee`: the 2 × fee overstatement (§2), live today through the UI. The form calls `resolveCashLeg` directly, not `resolveRowCashLeg`, and its cache-lookup condition differs slightly (`explicitFxRate == null` rather than a positive-rate check).
   - The manual **Edit** path (`handleSaveEdit`) performs a **direct `transactions.update()` with whatever the edit form supplied**, with **no call to `resolveCashLeg` and no re-validation of `cash_value`/`settle_value` consistency at all**. A user editing `cash_value`, `price`, `quantity`, `fee`, or `type` through this UI bypasses every cash-leg safety rule documented in §2. This is a real, live gap — not exercised by the IBKR PROD reconciliation (which only used the import route) and not covered by any test found in this audit. Edit also never recalculates `settle_value`. Changing a BUY's quantity or price leaves native cost basis based on the old `settle_value`. The Edit type list offers BAL but not FXM, and the `mirror_settle_to_cash` trigger fires on UPDATE as well as INSERT.

4. **Duplicate/legacy cash calculation implementations.** Three implementations exist (§8): `calculateCashBalancesMulti` (live), `applyCashTxn` (live, duplicated; branch logic matches, but `tests/financial/portfolio-series-cash.spec.ts` compares the two functions directly for FXM only; the other branches are tested separately), `calculateCashBalancesISA_GBP` (dead code, zero call sites, contains an inert BAL sign-handling divergence). Also, `src/app/api/portfolio-series/route.ts` has its own share-count replay (`applyHoldingTxn`) and its own `TYPE_PRIORITY` ordering, which lacks FXM. It uses no 6 dp rounding and no `1e-6` snap. None removed per instruction.

5. **Market value / unrealised P&L is triplicated at the display layer, not centralised in the accounting engine.** `PerPortfolioTable.tsx`, `TotalHoldingsTable.tsx`, and `MobilePortfolioView.tsx` each independently implement the identical `total_shares × livePrice × price_multiplier` formula. No shared `src/lib` function, no dedicated unit test for this formula was found. The `portfolio-series` and `portfolio-changes` API routes also value holdings (shares × price × multiplier) server-side, for charts and daily change. They were not audited in detail.

6. **Stale "dormant Definition B" documentation.** Code comments at `holdingsTransferIntegration.ts:85`, `transferCostBasis.ts:57–60`, `queries.ts:46`, `queries.ts:1031` and `definitionBDisplay.ts:11` describe the Definition B base-currency ledger as dormant / "no live Holding sets base_currency". This is no longer accurate for the per-portfolio path (`getPortfoliosWithHoldingsAndCash`), where `base_currency` has been unconditionally set for every holding since the per-portfolio activation was wired in — confirmed directly, and confirmed empirically by every `base_cost_reliable`/`base_realised_*` figure populated throughout this entire IBKR PROD engagement. It remains accurate only for the Global/blended path's *unresolved* (mixed-currency) tickers. This is a documentation-vs-implementation inconsistency, not a code defect — not corrected in the source by this audit.

7. **`cash_fx_to_portfolio` is largely a write-time audit field, never used to recalculate a value, but read at replay time as a Definition B reliability check.** No holdings/cash calculation reads it back to reconstruct a value; every value consumer reads `cash_value` directly. Definition B does read it to decide whether a cross-currency BUY/SELL is reliable (present and > 0, §10). Worth confirming this is the intended design before any future refactor treats it as load-bearing.

8. **No dedicated unit test suite exists for `getPortfoliosWithHoldingsAndCash` or `getAllHoldingsAndCashSummary` in isolation** (only exercised via integration tests against real DEV data, and via the ad-hoc scripts used throughout the IBKR rebuild). Their correctness for this engagement rests on the PROD reconciliation's 35/35 pass, not on a unit-test suite covering their own branch logic directly.

9. **Possible presentation-level penny differences** — see §11. Plausible mechanism identified (6dp accumulation vs. 2dp display rounding across different code paths); not confirmed with a constructed failing example during this audit.

10. **Broker-dependent assumptions baked into the importer, not the engine.** The `CASH.GBP`/`CASH.USD`/`CASH.EUR` pseudo-ticker convention for representing cash movements as pseudo-security rows is an IBKR-importer-era design choice that the accounting engine now depends on structurally (`isCashTicker`, used throughout §1/§7/§8) — any future broker importer (Trading 212) must either reuse this convention or the accounting engine will need new gating logic. This is not itself a defect, but is the single largest design assumption a new broker importer must respect, per §12.

11. **Latent sign issue: negative DIV/INT/DEP values increase cash.** For DIV, INT and DEP, `resolveCashLeg` stores a negative explicit `cash_value` exactly as supplied (signed-explicit path, §2), but `calculateCashBalancesMulti` and `applyCashTxn` add `abs(cash_value)`. A negative dividend or interest adjustment, or a negative deposit, would therefore *increase* cash instead of reducing it. (WIT and FEE are unaffected in direction because they always subtract `abs(cash_value)`.) `tests/financial/cash-leg.spec.ts` asserts only that the negative value is stored ("negative-adjustment INT"); no test covers its cash effect. A read-only query of the DEV database (2026-09-24) found **zero** negative DIV/INT/DEP/WIT/FEE rows, so this has no effect on current data. It is a latent defect for future imports (for example, broker debit interest or dividend reversals). Not fixed; the current behaviour is frozen pending an approved decision.

---

## 16. Verification report

A second pass was performed comparing every material statement above against the implementation and the test suite.

**Files/functions read and traced (full-file reads unless noted):** `src/lib/queries.ts` (in full, 1211 lines — `TRANSACTION_TYPE_META`, `applyTransactionToHolding`, `applyTransactionToHoldingResolvingTransfers`, `calculateCashBalancesISA_GBP`, `calculateCashBalancesMulti`, `computeBalancePreview`, `getPortfoliosWithHoldingsAndCash`, `getAllHoldingsAndCashSummary`, `fetchAllTable`, `impliedFxFromSellRow`, `deriveAssetCostForTIN`); `src/lib/cashLeg.ts` (in full, current post-three-fix state); `src/lib/transferCostBasis.ts` (in full); `src/lib/transfers.ts` (in full); `src/lib/holdingsTransferIntegration.ts` (in full); `src/lib/transferImportIntegration.ts` (in full); `src/lib/definitionBDisplay.ts` (in full); `src/lib/portfolio-series-cash.ts` (in full); `src/lib/cash.ts` (in full); `src/lib/assetResolution.ts` (excerpt — resolution-order documentation header + `resolveImportTicker`); `src/app/api/import-transactions/route.ts` (in full); `src/app/transactions/page.tsx` (`handleCreate`, `handleSaveEdit`, the Add form's type `<select>`); `src/components/PerPortfolioTable.tsx`, `src/components/TotalHoldingsTable.tsx`, `src/app/mobile/MobilePortfolioView.tsx` (market-value/unrealised formulas only); live PostgreSQL schema for `transactions` and `transfers` (`\d`, plus `pg_get_functiondef` for `trg_transactions_mirror_settle_to_cash`).

**Tests reviewed:** every file under `tests/financial/`, `tests/import/`, and `tests/integration/` was listed and its `describe`/`it` structure inspected; `cash-leg.spec.ts`, `current-behaviour.positions.spec.ts`, `current-behaviour.cash.spec.ts`, `target-spec.pending.spec.ts`, and `reconciliation.spec.ts` were read in detail for the specific claims in §1, §2, §11, and §15.

**Tests executed:** `npx vitest run` (full suite) — **32 test files passed, 1 skipped (`target-spec.pending.spec.ts`, intentionally, containing the known FEE-on-security gap), 442 tests passed, 1 skipped, 4 todo, 0 failed.** No code was changed to achieve this result; it is the suite's pre-existing state, identical to the state confirmed earlier in this engagement after the PROD reconciliation completed.

**Places where implementation and tests disagree:** none found. Every claim traced to a specific test either matches that test's assertions exactly, or (§15 item 1) is explicitly self-documented in the test file itself as a known, deliberate gap rather than a silent disagreement.

**Calculations whose behaviour cannot be established with full confidence:**
- The exact interaction of `calculateCashBalancesISA_GBP`'s dead-code BAL sign divergence with any *hypothetical* future call site — moot while it has zero call sites, but flagged so a future reader does not assume it is equivalent to the live implementation if it is ever revived.
- Whether a genuine £0.01 presentation-vs-accounting discrepancy (§11) can actually occur in practice — a plausible mechanism was identified from the precision model, but no constructed example was built or run to confirm it, per this task's read-only/no-new-test-writing scope.
- The full behaviour of `getAllHoldingsAndCashSummary`'s Global P&L blending for a ticker that is genuinely mixed-currency across portfolios in the *user's actual data* — no such ticker exists in the current IBKR-only PROD dataset, so this path's real-world behaviour is proven only by unit tests with synthetic data (`definitionBActivation.spec.ts`), not by the PROD reconciliation.

**Technical debt discovered:** see §15 in full (11 items).

**git diff --stat and git status:**

```
$ git status
On branch legacy-baseline-2026-09-11
Your branch is up to date with 'origin/legacy-baseline-2026-09-11'.

Untracked files:
  (use "git add <file>..." to include in what will be committed)
	docs/ACCOUNTING.md

nothing added to commit but untracked files present (use "git add" to track)
```

The only repository change made in producing this document is the new, untracked file `docs/ACCOUNTING.md` itself. No tracked file was modified. This document has not been committed.

**PDF generation:** skipped. No PDF-capable tooling (`pandoc`, `wkhtmltopdf`, `weasyprint`, a headless Chromium/Chrome binary) is present on this DEV host, and no such package is already cached for `npx` to run without a fresh install. Per instruction, no package was installed and the development environment was not altered to produce one. `docs/ACCOUNTING.md` is the sole, authoritative deliverable; a PDF can be generated separately once appropriate tooling is available, from this file unchanged.

ACCOUNTING SPECIFICATION READY FOR REVIEW — NO ACCOUNTING CODE CHANGED
