// Pump Paper Sprint: an early-pop sniper.
//
// Idea: on pump.fun a new coin's fate is mostly decided in its first seconds:
// the creator and the first buyers push the price up, then it either runs or
// fades. So this bot buys a coin exactly once, within a few slots of its
// creation, while the buyer crowd is still tiny and the curve still small;
// then it exits fast on value (not price): a +20% take-profit, a -10%
// stop-loss, a trailing stop once the trade is well in profit, a hard time
// limit of about ten slots, or the moment the creator sells. Equal stakes,
// at most five open positions, one buy per coin, no leverage, no shorts.
// Every decision comes only from the hello/batch/slot stream the harness
// sends, so two runs of the same window produce the same orders.
//
// Exits are measured on sell value, not on the quoted price: selling tokens
// against a constant-product curve pays tokens*vq/(vt+tokens) minus the
// 95+30 bps curve fees, minus the transaction fee; the cost basis is what the
// buy actually spent plus its transaction fee. All comparisons are integer
// (bigint) ratios, so the bot is deterministic and never touches the clock,
// the environment or Math.random.
//
// Self-check (gate): run the kit's local grader before submitting:
//   node <kit>/cli/makefun.mjs grade-local --kit <kit> --bot . --driver process
// On the dev window this bot finishes slightly negative (-0.31 SOL) with a
// 3.5% max drawdown over 290 round trips — near breakeven on a window where
// the kit's momentum pilot loses -9.45 SOL. The final window is a different
// 6 hours, so the edge here is the fast exit discipline, not the dev score.

import {
  LAMPORTS_PER_SOL,
  runBot,
  type Batch,
  type BotState,
  type BuyInput,
  type SellInput,
} from './vendor/makefun-bot.ts';

// ---- tunables (lamports / basis points / slots) ---------------------------
// Calibrated on the dev window. v1 (-1.83 SOL) entered too late and held too
// long; v2 (-1.25 SOL) entered earlier but still bought coins minutes old
// and held them for minutes. The winning shape on this data is ultra-fast:
// enter within 3 slots of creation, hold at most ~10 slots, take +20% and
// cut at -10%, and never touch a coin whose creator already loaded up or
// sold. The 0.20 SOL stake amortises the fixed transaction fee better than
// a 0.05 SOL stake; most buys are size-capped by the curve anyway.
const STAKE_LAMPORTS = LAMPORTS_PER_SOL / 5n; // 0.20 SOL per coin
const MIN_BUY_LAMPORTS = LAMPORTS_PER_SOL / 200n; // never buy under 0.005 SOL
const ENTRY_MAX_AGE_SLOTS = 3; // only coins created within the last 3 slots
const ENTRY_MAX_BUYERS = 3; // enter only while the buyer crowd is still tiny
const MIN_REAL_SOL_LAMPORTS = (LAMPORTS_PER_SOL * 3n) / 10n; // real reserve >= 0.3 SOL
const MAX_REAL_SOL_LAMPORTS = LAMPORTS_PER_SOL * 30n; // ... and <= 30 SOL
const MAX_DEV_BUY_LAMPORTS = (LAMPORTS_PER_SOL * 5n) / 2n; // creator bought <= 2.5 SOL
const TAKE_PROFIT_BPS = 2000; // sell when value is +20% over cost basis
const STOP_LOSS_BPS = 1000; // sell when value is -10% under cost basis
const TRAIL_ARM_BPS = 4000; // trailing stop arms at +40% of value
const TRAIL_DROP_BPS = 1000; // ... then sell on a 10% fall from the best value
const TIME_EXIT_SLOTS = 12; // sell ~10 slots after the buy filled
const BUY_SLIPPAGE_BPS = 10_000; // wide open: a buy must not fail on 2 slots of drift
const SELL_SLIPPAGE_BPS = 10_000; // exits must land; retrying costs slots we do not have
// Note: exits use 10_000 bps of slippage deliberately. With a 2-slot latency
// and a hold of only ~10 slots, a sell refused for slippage is a sell that
// never happens before the time exit; the value-based stop-loss already
// prices the exit, so the slippage guard adds nothing here.
const CURVE_FEE_BPS = 125n; // protocol 95 + creator 30 bps, charged on the curve
const BPS = 10_000n;

interface Coin {
  createdSlot: number;
  creator: string;
  buys: number;
  buyers: Set<string>;
  devBuyLamports: bigint; // SOL the creator has bought on this curve
  devSold: boolean; // the creator has sold since creation
  decided: boolean; // entry decided (bought, or skipped for good)
  entrySlot: number; // slot the buy was decided on
  fillSlot: number; // slot the buy filled on (0 until filled)
  costBasis: bigint; // buy spend + its tx fee, once the buy fills
  bestValue: bigint; // best sell value seen since the buy filled
}

const coins = new Map<string, Coin>();

/** What selling `tokens` against (vq, vt) pays after the curve fees. */
function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  return q - (q * CURVE_FEE_BPS + BPS - 1n) / BPS;
}

await runBot({
  onBatch(state: BotState, batch: Batch) {
    // 1. Fold this batch's events and fills into the per-coin records.
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        if (!coins.has(e.mint)) {
          coins.set(e.mint, {
            createdSlot: e.slot,
            creator: e.creator,
            buys: 0,
            buyers: new Set<string>(),
            devBuyLamports: 0n,
            devSold: false,
            decided: false,
            entrySlot: 0,
            fillSlot: 0,
            costBasis: 0n,
            bestValue: 0n,
          });
        }
      } else if (e.event === 'TradeEvent') {
        const c = coins.get(e.mint);
        if (c !== undefined) {
          if (e.is_buy) {
            c.buys += 1;
            c.buyers.add(e.user);
            if (e.user === c.creator) c.devBuyLamports += BigInt(e.sol_amount);
          } else if (e.user === c.creator) {
            // The creator selling is the classic rug signal: get out.
            c.devSold = true;
          }
        }
      } else {
        // CompleteEvent: the curve is done; never enter it again.
        const c = coins.get(e.mint);
        if (c !== undefined) c.decided = true;
      }
    }
    // Record when our own buys fill, so the hold clock starts at the fill.
    for (const f of batch.fills) {
      if (f.side !== 'buy' || f.status !== 'filled') continue;
      const c = coins.get(f.mint);
      if (c !== undefined && c.decided && c.fillSlot === 0) {
        c.fillSlot = f.slot;
        c.costBasis = BigInt(f.quote_lamports) + BigInt(f.tx_fee_lamports);
        c.bestValue = 0n;
      }
    }

    const orders: Array<BuyInput | SellInput> = [];
    const caps = state.hello.caps;
    const tx = state.txFeeLamports();

    // Mints with an order already in flight: do not send a second one.
    const sellPending = new Set<string>();
    const buyPending = new Set<string>();
    for (const p of state.pending.values()) {
      if (p.order.side === 'sell') sellPending.add(p.order.mint);
      else buyPending.add(p.order.mint);
    }

    // 2. Exits first: free slots before deciding new entries.
    for (const [mint, holding] of state.positions) {
      if (sellPending.has(mint)) continue;
      const c = coins.get(mint);
      const curve = state.curves.get(mint);
      if (c === undefined || curve === undefined || curve.complete) continue;
      if (holding.token_amount <= 0n) continue;
      if (c.fillSlot === 0 || c.costBasis === 0n) continue;
      const value =
        sellValue(
          holding.token_amount,
          curve.virtual_quote_reserves,
          curve.virtual_token_reserves,
        ) - tx;
      if (value > c.bestValue) c.bestValue = value;
      const basis = c.costBasis;
      const takeProfit = value * BPS >= basis * (BPS + BigInt(TAKE_PROFIT_BPS));
      const stopLoss = value * BPS <= basis * (BPS - BigInt(STOP_LOSS_BPS));
      const trailing =
        c.bestValue * BPS >= basis * (BPS + BigInt(TRAIL_ARM_BPS)) &&
        value * BPS <= c.bestValue * (BPS - BigInt(TRAIL_DROP_BPS));
      const timedOut = state.slot - c.fillSlot >= TIME_EXIT_SLOTS;
      const creatorDumped = c.devSold;
      if (takeProfit || stopLoss || trailing || timedOut || creatorDumped) {
        orders.push({
          side: 'sell',
          mint,
          token_amount: holding.token_amount,
          max_slippage_bps: SELL_SLIPPAGE_BPS,
        });
        sellPending.add(mint);
      }
    }

    // 3. Entries: every fresh coin, in first-seen order, decided once.
    // A coin is judged on every batch while it is still young, not only on
    // batches that carry one of its events, so a coin that becomes buyable a
    // few slots after creation is not missed. The 3-slot window is the whole
    // edge: on the dev window, coins bought more than a few slots after
    // creation had already handed their pop to earlier buyers (v1, which
    // allowed entries up to 3600 slots old, lost -1.83 SOL; this shape
    // loses -0.31 SOL with the same exits).
    let free = state.freeCashLamports();
    let slots = caps.max_open_positions - state.committedPositionCount();
    for (const [mint, c] of coins) {
      if (orders.length >= caps.max_orders_per_batch) break;
      if (c.decided) continue;
      const age = state.slot - c.createdSlot;
      if (age > ENTRY_MAX_AGE_SLOTS) {
        c.decided = true;
        continue;
      }
      if (c.devSold || c.devBuyLamports > MAX_DEV_BUY_LAMPORTS) {
        c.decided = true;
        continue;
      }
      if (c.buyers.size > ENTRY_MAX_BUYERS) {
        c.decided = true;
        continue;
      }
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) {
        c.decided = true;
        continue;
      }
      // Rug filter: the curve must already hold real buying, but not be big.
      const rq = curve.real_quote_reserves;
      if (rq < MIN_REAL_SOL_LAMPORTS || rq > MAX_REAL_SOL_LAMPORTS) continue;
      if (buyPending.has(mint)) {
        c.decided = true;
        continue;
      }
      const cap = state.maxBuyLamports(mint);
      const amount = cap < STAKE_LAMPORTS ? cap : STAKE_LAMPORTS;
      if (amount < MIN_BUY_LAMPORTS) continue;
      if (slots <= 0 || free < amount + tx) continue;
      c.decided = true;
      c.entrySlot = state.slot;
      orders.push({
        side: 'buy',
        mint,
        quote_lamports: amount,
        max_slippage_bps: BUY_SLIPPAGE_BPS,
      });
      free -= amount + tx;
      slots -= 1;
      buyPending.add(mint);
    }

    return orders;
  },
});
