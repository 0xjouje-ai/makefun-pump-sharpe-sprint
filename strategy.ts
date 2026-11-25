// Steady-scalper paper bot for the pump.fun replay (agent-fun/replay/v2).
//
// Idea: Sharpe ratio rewards steady small wins, not moonshots. So this bot
// takes small, diversified stakes (0.04 SOL) in coins that show *sustained,
// broad* buy pressure, and exits fast on a fixed take-profit, a tight stop
// loss, or a trailing stop. No pyramiding, no holding through chop. The
// entry bar is deliberately strict: on the dev window every looser
// variant traded more and lost more, so the bot only takes the few
// setups with the strongest tape and lets the pace probes cover the
// 20-coin minimum bar.
//
// Entry signal (per mint, evaluated on every batch):
//   - the curve is mature: at least minAge slots since its CreateEvent
//     (fresh curves are mostly bundled launches that get dumped);
//   - real SOL reserves inside [minRqSol, maxRqSol] (liquid enough to
//     trade, not so big the move is already over);
//   - over the trailing window (slots): net buy SOL >= minNetSol, at least
//     minBuys buys from at least minBuyers distinct wallets, no single
//     wallet over maxBuyerShare of the buy flow (a bundle smells);
//   - price up between minUpBps and maxUpBps over the window, sitting at
//     >= nearHighBps of the window high, and inflow accelerating (the
//     newer half of the window carries at least accel x the older half).
//
// Exits (whole position, sells go out wide open on slippage):
//   - take profit at +takeProfitBps, stop loss at stopLossBps;
//   - trailing stop: once the position is up trailArmBps, sell when it
//     gives back trailBps from its peak value;
//   - time stop: sell after maxHoldSlots no matter what (capital must
//     keep turning over; a stale position is dead variance).
//
// Pace guard for the 20-coin minimum bar: the run must end with round
// trips of >= 0.01 SOL on at least 20 distinct mints. If no new coin has
// been entered for probeGapSlots and the bar is not met yet, the bot buys
// a tiny probe (probeSol) of the most liquid mature curve with positive
// net inflow and sells it whole as soon as the buy lands. A probe costs
// ~2.5% in curve fees plus two tx fees, which is cheap insurance against
// ranking below every entry that meets the bar.
//
// Two fill-handling rules the dev window taught this bot:
//   - a position stays tracked while any of its orders is in flight:
//     fills land two slots after the decision, and the account only
//     shows a buy once it lands, so dropping the entry early strands
//     the position open with no exit;
//   - a sell that is rejected or whose tx fails leaves the position
//     open, so the exit is retried instead of assumed done.
//
// Deterministic by construction: no clock, no Math.random, no environment;
// iteration only over insertion-ordered maps fed by the batch stream, and
// the only "randomness" the run needs is the seed the hello message
// carries (unused: this strategy is fully deterministic).

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Entry lookback, in slots. */
  windowSlots: number;
  /** Slots since the CreateEvent before an entry is allowed. */
  minAgeSlots: number;
  /** Net buy SOL (buys minus sells) over the window. */
  minNetSol: number;
  /** Buy trades in the window. */
  minBuys: number;
  /** Distinct buying wallets in the window. */
  minBuyers: number;
  /** Price rise over the window, in bps (lower bound). */
  minUpBps: number;
  /** Price rise over the window, in bps (upper bound). */
  maxUpBps: number;
  /** Newer-half net inflow must be at least this multiple of the older half. */
  accel: number;
  /** Price now must be at least this share (bps) of the window high. */
  nearHighBps: number;
  /** Largest single wallet's share of window buy SOL, in bps. */
  maxBuyerShareBps: number;
  /** Curve real SOL bounds at entry. */
  minRqSol: number;
  maxRqSol: number;
  /** SOL per momentum position. */
  stakeSol: number;
  /** Smallest buy worth sending, in SOL. */
  minBuySol: number;
  /** Slippage on buys (bps); sells always go out at 10000. */
  buySlipBps: number;
  /** Take profit, in bps of cost. */
  takeProfitBps: number;
  /** Stop loss, in bps of cost (negative). */
  stopLossBps: number;
  /** Trailing stop give-back, in bps of peak value. */
  trailBps: number;
  /** The trailing stop arms once the position is up this much, in bps. */
  trailArmBps: number;
  /** Exit after this many slots held, whatever the price. */
  maxHoldSlots: number;
  /** Slots to wait after an exit before the same curve may be bought again. */
  cooldownSlots: number;
  /** Most entries per curve over the run. */
  maxEntriesPerMint: number;
  /** Probe size, in SOL. */
  probeSol: number;
  /** Open a probe when no new coin entered for this many slots. */
  probeGapSlots: number;
}

export const DEFAULT_PARAMS: Params = {
  windowSlots: 2400,
  minAgeSlots: 900,
  minNetSol: 1,
  minBuys: 10,
  minBuyers: 6,
  minUpBps: 300,
  maxUpBps: 1500,
  accel: 1.5,
  nearHighBps: 9700,
  maxBuyerShareBps: 6000,
  minRqSol: 0.5,
  maxRqSol: 60,
  stakeSol: 0.04,
  minBuySol: 0.01,
  buySlipBps: 500,
  takeProfitBps: 1200,
  stopLossBps: -600,
  trailBps: 800,
  trailArmBps: 800,
  maxHoldSlots: 6000,
  cooldownSlots: 1200,
  maxEntriesPerMint: 2,
  probeSol: 0.01,
  probeGapSlots: 1500,
};

const SOL = 1_000_000_000n;
/** Price is quote-per-token scaled by this, so all comparisons stay in bigint. */
const PRICE_SCALE = 1_000_000n;

interface TapeTrade {
  slot: number;
  isBuy: boolean;
  sol: bigint;
  user: Pubkey;
  /** Price (scaled) just after this trade. */
  price: bigint;
}

interface Tape {
  createdSlot: number | null;
  trades: TapeTrade[];
}

interface Position {
  mint: Pubkey;
  entrySlot: number;
  /** Best value (lamports) the position has reached. */
  peakLamports: bigint;
  /** True while this position is a pace probe (sell as soon as it lands). */
  probe: boolean;
  /** True once the probe's buy has filled. */
  probeLanded: boolean;
  /** True while a sell for this position is in flight (do not re-send). */
  exiting: boolean;
}

function priceOf(vq: bigint, vt: bigint): bigint {
  if (vt === 0n) return 0n;
  return (vq * PRICE_SCALE) / vt;
}

export function createStrategy(p: Params): Bot {
  const tapes = new Map<Pubkey, Tape>();
  const positions = new Map<Pubkey, Position>();
  const entriesPerMint = new Map<Pubkey, number>();
  const cooldownUntil = new Map<Pubkey, number>();
  /** Mints with a completed round trip (a buy fill and a later sell fill). */
  const roundTrips = new Set<Pubkey>();
  /** Mints with a buy fill (a sell fill later completes the round trip). */
  const bought = new Set<Pubkey>();
  let lastNewCoinSlot = -1;
  let firstSlot = -1;

  function tapeFor(mint: Pubkey): Tape {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { createdSlot: null, trades: [] };
      tapes.set(mint, t);
    }
    return t;
  }

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const slot = batch.slot;
      if (firstSlot < 0) firstSlot = slot;
      const caps = state.hello.caps;
      const tx = state.txFeeLamports();
      const orders: OrderInput[] = [];
      let free = state.freeCashLamports();
      let slotsFree = caps.max_open_positions - state.committedPositionCount();

      // --- Fold fills in: track round trips, probe landings, closed positions.
      // A position leaves our map only when its sell actually fills. A sell
      // that is rejected or whose tx fails leaves the position open, so the
      // exit must be retried: clear `exiting` on those fills, or the
      // position strands open until the replay flattens it.
      for (const f of batch.fills) {
        if (f.status !== 'filled') {
          if (f.side === 'sell') {
            const pos = positions.get(f.mint);
            if (pos !== undefined) pos.exiting = false;
          }
          continue;
        }
        if (f.side === 'buy') bought.add(f.mint);
        if (f.side === 'sell') {
          if (bought.has(f.mint)) roundTrips.add(f.mint);
          positions.delete(f.mint);
          cooldownUntil.set(f.mint, slot + p.cooldownSlots);
        }
        if (f.side === 'buy') {
          const pos = positions.get(f.mint);
          if (pos !== undefined && pos.probe) pos.probeLanded = true;
        }
      }
      // Positions the harness closed (curve completed / replay flattened).
      // Keep an entry while any order for it is still in flight: fills land
      // two slots after the decision, and state.positions only shows a buy
      // once it lands.
      for (const mint of [...positions.keys()]) {
        const inFlight = [...state.pending.values()].some((po) => po.order.mint === mint);
        if (!state.positions.has(mint) && !inFlight) positions.delete(mint);
      }

      // --- Fold this batch's events into the tapes.
      for (const e of batch.events) {
        if (e.event === 'CreateEvent') {
          const t = tapeFor(e.mint);
          t.createdSlot = e.slot;
        } else if (e.event === 'TradeEvent') {
          const t = tapeFor(e.mint);
          t.trades.push({
            slot: e.slot,
            isBuy: e.is_buy,
            sol: BigInt(e.sol_amount),
            user: e.user,
            price: priceOf(BigInt(e.virtual_sol_reserves), BigInt(e.virtual_token_reserves)),
          });
        } else if (e.event === 'CompleteEvent') {
          tapes.delete(e.mint);
        }
      }

      // --- Exits first: free slots and cash for new entries this batch.
      for (const [mint, holding] of state.positions) {
        const pos = positions.get(mint);
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pos === undefined) continue;
        if (pos.probe) {
          // Probes flip immediately once the buy lands: a probe held open
          // drifts down with the coin and loses more than the certain
          // round-trip fee of an instant flip (measured on the dev window).
          if (pos.probeLanded && !pos.exiting) {
            orders.push({ side: 'sell', mint, token_amount: holding.token_amount, max_slippage_bps: 10_000 });
            pos.exiting = true;
          }
          continue;
        }
        const value = (holding.token_amount * curve.virtual_quote_reserves) / curve.virtual_token_reserves;
        if (value > pos.peakLamports) pos.peakLamports = value;
        const cost = holding.cost_lamports;
        if (cost === 0n || pos.exiting) continue;
        const retBps = Number(((value - cost) * 10_000n) / cost);
        const peakRetBps = Number(((pos.peakLamports - cost) * 10_000n) / cost);
        const held = slot - pos.entrySlot;
        const giveBackBps = peakRetBps - retBps;
        if (
          retBps >= p.takeProfitBps ||
          retBps <= p.stopLossBps ||
          (peakRetBps >= p.trailArmBps && giveBackBps >= p.trailBps) ||
          held >= p.maxHoldSlots
        ) {
          orders.push({ side: 'sell', mint, token_amount: holding.token_amount, max_slippage_bps: 10_000 });
          pos.exiting = true;
        }
      }

      // --- Entries: scan this batch's mints in event order.
      const seenThisBatch = new Set<Pubkey>();
      for (const e of batch.events) seenThisBatch.add(e.mint);
      for (const mint of seenThisBatch) {
        if (orders.length >= caps.max_orders_per_batch || slotsFree <= 0) break;
        const t = tapes.get(mint);
        const curve = state.curves.get(mint);
        if (t === undefined || curve === undefined || curve.complete) continue;
        if (state.positions.has(mint)) continue;
        if ([...state.pending.values()].some((po) => po.order.mint === mint && po.order.side === 'buy')) continue;
        if ((entriesPerMint.get(mint) ?? 0) >= p.maxEntriesPerMint) continue;
        if ((cooldownUntil.get(mint) ?? 0) > slot) continue;
        const created = t.createdSlot;
        if (created === null || slot - created < p.minAgeSlots) continue;

        // Prune the tape to the window and compute its stats.
        const cutoff = slot - p.windowSlots;
        while (t.trades.length > 0 && t.trades[0].slot < cutoff) t.trades.shift();
        if (t.trades.length < p.minBuys) continue;
        let net = 0n;
        let buySol = 0n;
        let buys = 0;
        let newest = 0n;
        let oldest = 0n;
        let high = 0n;
        const buyers = new Set<Pubkey>();
        const perBuyer = new Map<Pubkey, bigint>();
        const mid = slot - p.windowSlots / 2;
        for (const tr of t.trades) {
          if (tr.price > high) high = tr.price;
          if (tr.isBuy) {
            net += tr.sol;
            buySol += tr.sol;
            buys += 1;
            buyers.add(tr.user);
            perBuyer.set(tr.user, (perBuyer.get(tr.user) ?? 0n) + tr.sol);
            if (tr.slot >= mid) newest += tr.sol;
            else oldest += tr.sol;
          } else {
            net -= tr.sol;
            if (tr.slot >= mid) newest -= tr.sol;
            else oldest -= tr.sol;
          }
        }
        if (buys < p.minBuys || buyers.size < p.minBuyers) continue;
        if (net < BigInt(Math.round(p.minNetSol * 1e9))) continue;
        if (buySol === 0n) continue;
        let topShare = 0n;
        for (const v of perBuyer.values()) if (v > topShare) topShare = v;
        if ((topShare * 10_000n) / buySol > BigInt(p.maxBuyerShareBps)) continue;
        // Acceleration: the newer half must carry at least accel x the older half.
        if (oldest > 0n) {
          if (newest < oldest * BigInt(Math.round(p.accel * 100)) / 100n) continue;
        } else if (newest <= 0n) {
          continue;
        }
        // Price shape: up, but not parabolic; sitting near the window high.
        const firstPrice = t.trades[0].price;
        const nowPrice = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
        if (firstPrice === 0n || nowPrice === 0n) continue;
        const upBps = Number(((nowPrice - firstPrice) * 10_000n) / firstPrice);
        if (upBps < p.minUpBps || upBps > p.maxUpBps) continue;
        if ((nowPrice * 10_000n) / high < BigInt(p.nearHighBps)) continue;
        // Still active: a trade in the last 300 slots.
        if (t.trades[t.trades.length - 1].slot < slot - 300) continue;

        // Size: at most the 1%-of-real-reserve cap, at least minBuySol.
        const rqSol = Number(curve.real_quote_reserves) / 1e9;
        if (rqSol < p.minRqSol || rqSol > p.maxRqSol) continue;
        const cap = state.maxBuyLamports(mint);
        const stake = BigInt(Math.round(p.stakeSol * 1e9));
        const amount = cap < stake ? cap : stake;
        if (amount < BigInt(Math.round(p.minBuySol * 1e9))) continue;
        if (free < amount + tx) continue;
        orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: p.buySlipBps });
        positions.set(mint, { mint, entrySlot: slot, peakLamports: 0n, probe: false, probeLanded: false, exiting: false });
        entriesPerMint.set(mint, (entriesPerMint.get(mint) ?? 0) + 1);
        lastNewCoinSlot = slot;
        free -= amount + tx;
        slotsFree -= 1;
      }

      // --- Pace guard: probe a liquid curve when new coins stall. It also
      // fires before the first momentum entry, so a quiet window still
      // banks round trips toward the 20-coin bar.
      const sinceNewCoin = lastNewCoinSlot < 0 ? slot - firstSlot : slot - lastNewCoinSlot;
      if (
        roundTrips.size < 20 &&
        orders.length < caps.max_orders_per_batch &&
        slotsFree > 0 &&
        sinceNewCoin >= p.probeGapSlots
      ) {
        let best: Pubkey | null = null;
        let bestRq = 0n;
        for (const [mint, curve] of state.curves) {
          if (curve.complete || state.positions.has(mint)) continue;
          if (positions.has(mint)) continue;
          if ((entriesPerMint.get(mint) ?? 0) >= p.maxEntriesPerMint) continue;
          if ((cooldownUntil.get(mint) ?? 0) > slot) continue;
          const t = tapes.get(mint);
          if (t === undefined || t.createdSlot === null || slot - t.createdSlot < p.minAgeSlots) continue;
          if (t.trades.length === 0 || t.trades[t.trades.length - 1].slot < slot - 300) continue;
          if (curve.real_quote_reserves < 2n * SOL) continue;
          // Light quality bar so the probe is a small momentum trade, not a
          // blind fee payment: net inflow over the window must be positive
          // with at least two buys behind it.
          let net = 0n;
          let buys = 0;
          const cutoff = slot - p.windowSlots;
          for (const tr of t.trades) {
            if (tr.slot < cutoff) continue;
            if (tr.isBuy) {
              net += tr.sol;
              buys += 1;
            } else {
              net -= tr.sol;
            }
          }
          if (net <= 0n || buys < 2) continue;
          if (curve.real_quote_reserves > bestRq) {
            bestRq = curve.real_quote_reserves;
            best = mint;
          }
        }
        if (best !== null) {
          const cap = state.maxBuyLamports(best);
          const amount = BigInt(Math.round(p.probeSol * 1e9));
          if (cap >= amount && free >= amount + tx) {
            orders.push({ side: 'buy', mint: best, quote_lamports: amount, max_slippage_bps: 10_000 });
            positions.set(best, { mint: best, entrySlot: slot, peakLamports: 0n, probe: true, probeLanded: false, exiting: false });
            entriesPerMint.set(best, (entriesPerMint.get(best) ?? 0) + 1);
            lastNewCoinSlot = slot;
            free -= amount + tx;
            slotsFree -= 1;
          }
        }
      }

      return orders;
    },
  };
}
