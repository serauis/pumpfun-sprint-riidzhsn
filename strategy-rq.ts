// rq-runner: buys a coin whose real SOL just crossed 25 SOL while its price
// sits within 2% of the 200-slot high, on clean net flow and dispersed
// holders; exits on TP / SL / max hold / creator sell. Written from the
// frozen spec (SPEK BEKU section 3 + clarifications K1-K9, with K8 explicitly
// NOT applied: one entry per coin, no re-entry after a round trip) for the
// u-riidzhsn pump.fun sprint. One of three books sharing 10 SOL cash and a
// 5-position / 16-order-per-batch cap; this book only ever touches its own
// rq- orders and rq- positions. No clock, no randomness: a pure function of
// the batches it is fed.

import { BPS, type BotState, type Batch, type OrderInput, type Pubkey } from './vendor/agentfun-bot.ts';
import type { BookCtx } from './strategy-sniper.ts';

export interface RqParams {
  rqEnter: number;
  crossWindow: number;
  nearHighBps: number;
  window: number;
  minFlowLamports: number;
  minBuyers: number;
  skipDevSold: boolean;
  maxTop5ShareBps: number;
  maxTop1ShareBps: number;
  minAge: number;
  maxEntries: number;
  cooldownSlots: number;
  stakeLamports: number;
  minBuyLamports: number;
  buySlippageBps: number;
  tp1Bps: number;
  tp1PartBps: number;
  slAfterTp1Bps: number;
  tpBps: number;
  slBps: number;
  trailArmBps: number;
  trailBps: number;
  maxHold: number;
  exitOnDevSell: boolean;
  staleSlots: number;
  exitFlowLamports: number;
  bigSellLamports: number;
}

export const RQ_DEFAULTS: RqParams = {
  rqEnter: 25_000_000_000,
  crossWindow: 100,
  nearHighBps: 9800,
  window: 200,
  minFlowLamports: 500_000_000,
  minBuyers: 3,
  skipDevSold: true,
  maxTop5ShareBps: 8000,
  maxTop1ShareBps: 10_000,
  minAge: 10,
  maxEntries: 1,
  cooldownSlots: 150,
  stakeLamports: 220_000_000,
  minBuyLamports: 8_000_000,
  buySlippageBps: 1500,
  tp1Bps: 0,
  tp1PartBps: 5000,
  slAfterTp1Bps: 0,
  tpBps: 3500,
  slBps: 1200,
  trailArmBps: 1_000_000,
  trailBps: 1000,
  maxHold: 122,
  exitOnDevSell: true,
  staleSlots: 1_000_000,
  exitFlowLamports: 1_000_000_000_000,
  bigSellLamports: 1_000_000_000_000,
};

interface RqTrade {
  slot: number;
  isBuy: boolean;
  sol: bigint;
  user: Pubkey;
  /** floor(virtual_quote_reserves * 1e6 / virtual_token_reserves) at trade time (K3). */
  price: bigint;
}

interface RqSample {
  slot: number;
  rq: bigint;
}

interface RqCoin {
  mint: Pubkey;
  createdSlot: number | null;
  creator: Pubkey;
  /** All recorded trades, newest last, capped at the 600 latest (K1). */
  trades: RqTrade[];
  /** One real-quote sample per CreateEvent (rq = 0) and per TradeEvent, newest last, capped at 300 (K9). */
  samples: RqSample[];
  devSold: boolean;
  lastTradeSlot: number;
  complete: boolean;
  entries: number;
  lastExitSlot: number | null;
  /** Floor price under which a re-buy after a failed buy is refused (K4). */
  retryMinPrice: bigint | null;
}

interface RqHeld {
  openedSlot: number;
  txPaid: bigint;
  best: bigint;
  devSoldAtOpen: boolean;
  tookTp1: boolean;
}

const FEE_BPS = 125n;

/** What selling `tokens` against (vq, vt) would pay after curve fees. */
function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  return q - (q * FEE_BPS + BPS - 1n) / BPS;
}

/** Per-trade price with the K3 floor rounding. */
function tradePrice(vq: bigint, vt: bigint): bigint {
  if (vt <= 0n) return 0n;
  return (vq * 1_000_000n) / vt;
}

export interface RqBook {
  onBatch(state: BotState, batch: Batch, ctx: BookCtx): void;
}

export function createRq(params: RqParams = RQ_DEFAULTS): RqBook {
  const P = params;
  const coins = new Map<Pubkey, RqCoin>();
  const held = new Map<Pubkey, RqHeld>();
  /** Mints with a sell in flight. */
  const selling = new Set<Pubkey>();
  const stake = BigInt(P.stakeLamports);
  const minBuy = BigInt(P.minBuyLamports);
  let buySeq = 0;
  let sellSeq = 0;

  function readEvents(batch: Batch): void {
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        let c = coins.get(e.mint);
        if (c === undefined) {
          c = {
            mint: e.mint,
            createdSlot: e.slot,
            creator: e.creator,
            trades: [],
            samples: [],
            devSold: false,
            lastTradeSlot: e.slot,
            complete: false,
            entries: 0,
            lastExitSlot: null,
            retryMinPrice: null,
          };
          coins.set(e.mint, c);
        } else {
          c.createdSlot = e.slot;
          c.creator = e.creator;
        }
        c.samples.push({ slot: e.slot, rq: 0n });
        if (c.samples.length > 300) c.samples.splice(0, c.samples.length - 300);
      } else if (e.event === 'TradeEvent') {
        let c = coins.get(e.mint);
        if (c === undefined) {
          c = {
            mint: e.mint,
            createdSlot: null,
            creator: e.creator,
            trades: [],
            samples: [],
            devSold: false,
            lastTradeSlot: e.slot,
            complete: false,
            entries: 0,
            lastExitSlot: null,
            retryMinPrice: null,
          };
          coins.set(e.mint, c);
        }
        const price = tradePrice(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
        c.trades.push({ slot: e.slot, isBuy: e.is_buy, sol: BigInt(e.sol_amount), user: e.user, price });
        if (c.trades.length > 600) c.trades.splice(0, c.trades.length - 600);
        c.samples.push({ slot: e.slot, rq: BigInt(e.real_quote_reserves) });
        if (c.samples.length > 300) c.samples.splice(0, c.samples.length - 300);
        c.lastTradeSlot = e.slot;
        if (!e.is_buy && e.user === c.creator) c.devSold = true;
      } else {
        const c = coins.get(e.mint);
        if (c !== undefined) {
          c.complete = true;
          c.trades = [];
          c.samples = [];
        }
      }
    }
  }

  /** Last price, window high, net flow, distinct buyers and biggest single
   *  sell over the last `window` slots, in one backward scan. */
  function windowStats(c: RqCoin, slot: number): { last: bigint; high: bigint; flow: bigint; buyers: number; maxSell: bigint; count: number } {
    const from = slot - P.window;
    let last = 0n;
    let high = 0n;
    let flow = 0n;
    let maxSell = 0n;
    let count = 0;
    const buyers = new Set<Pubkey>();
    for (let i = c.trades.length - 1; i >= 0; i--) {
      const t = c.trades[i]!;
      if (t.slot <= from) break;
      if (count === 0) last = t.price;
      count++;
      if (t.price > high) high = t.price;
      if (t.isBuy) {
        flow += t.sol;
        if (t.user !== c.creator) buyers.add(t.user);
      } else {
        flow -= t.sol;
        if (t.sol > maxSell) maxSell = t.sol;
      }
    }
    return { last, high, flow, buyers: buyers.size, maxSell, count };
  }

  /** Concentration over the coin's whole recorded history, net per wallet:
   *  only wallets with a positive net count as longs (K1). */
  function concentration(c: RqCoin): { top1: bigint; top5: bigint; total: bigint } {
    const net = new Map<Pubkey, bigint>();
    for (const t of c.trades) {
      net.set(t.user, (net.get(t.user) ?? 0n) + (t.isBuy ? t.sol : -t.sol));
    }
    const longs: bigint[] = [];
    let total = 0n;
    for (const v of net.values()) {
      if (v > 0n) {
        longs.push(v);
        total += v;
      }
    }
    longs.sort((a, b) => (a > b ? -1 : a < b ? 1 : 0));
    const top1 = longs.length > 0 ? longs[0]! : 0n;
    let top5 = 0n;
    for (let i = 0; i < Math.min(5, longs.length); i++) top5 += longs[i]!;
    return { top1, top5, total };
  }

  /** "Just crossed 25 SOL" over samples (K9): some sample in the last
   *  crossWindow slots sits below the threshold while the curve now sits
   *  at or above it. The create sample (rq = 0) counts. */
  function crossed(c: RqCoin, slot: number, nowRq: bigint): boolean {
    if (nowRq < BigInt(P.rqEnter)) return false;
    const from = slot - P.crossWindow;
    for (let i = c.samples.length - 1; i >= 0; i--) {
      const s = c.samples[i]!;
      if (s.slot < from) break;
      if (s.rq < BigInt(P.rqEnter)) return true;
    }
    return false;
  }

  function hasPendingBuyOwn(state: BotState, mint: Pubkey): boolean {
    for (const p of state.pending.values()) {
      if (p.order.mint === mint && p.order.side === 'buy' && p.order.client_id.startsWith('rq-')) return true;
    }
    return false;
  }

  function hasPendingSellOwn(state: BotState, mint: Pubkey): boolean {
    for (const p of state.pending.values()) {
      if (p.order.mint === mint && p.order.side === 'sell' && p.order.client_id.startsWith('rq-')) return true;
    }
    return false;
  }

  function hasPendingBuyAny(state: BotState, mint: Pubkey): boolean {
    for (const p of state.pending.values()) {
      if (p.order.mint === mint && p.order.side === 'buy') return true;
    }
    return false;
  }

  /** K8: when an rq position is gone with no own pending sell/buy left,
   *  give the entry slot back and arm the cooldown. */
  function closeHeld(mint: Pubkey, slot: number): void {
    held.delete(mint);
    const c = coins.get(mint);
    if (c !== undefined) {
      c.entries = 0;
      c.lastExitSlot = slot;
    }
  }

  return {
    onBatch(state, batch, ctx) {
      readEvents(batch);
      const orders = ctx.orders;
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = state.txFeeLamports();
      const marks = new Map<Pubkey, { vq: bigint; vt: bigint }>();
      for (const m of batch.marks) marks.set(m.mint, { vq: BigInt(m.virtual_quote_reserves), vt: BigInt(m.virtual_token_reserves) });

      // Own fills only (K5): rq- fills, plus harness "_" closes which clear
      // this book's held/selling state for the mint. Other books' fills are
      // ignored entirely here.
      for (const f of batch.fills) {
        if (f.client_id.startsWith('_')) {
          if (held.has(f.mint)) closeHeld(f.mint, state.slot);
          selling.delete(f.mint);
          continue;
        }
        if (!f.client_id.startsWith('rq-')) continue;
        const h = held.get(f.mint);
        if (f.status !== 'rejected' && h !== undefined) h.txPaid += BigInt(f.tx_fee_lamports);
        if (f.side === 'buy' && f.status === 'filled' && h === undefined) {
          const c = coins.get(f.mint);
          held.set(f.mint, {
            openedSlot: f.slot,
            txPaid: BigInt(f.tx_fee_lamports),
            best: 0n,
            tookTp1: false,
            devSoldAtOpen: c?.devSold ?? false,
          });
        } else if (f.side === 'buy' && (f.status === 'failed' || f.status === 'rejected')) {
          // K4: give the entry slot back, and only re-buy at or above the
          // last recorded trade price when the buy failed.
          const c = coins.get(f.mint);
          if (c !== undefined) {
            if (c.entries > 0) c.entries -= 1;
            if (c.trades.length > 0) {
              const lastPrice = c.trades[c.trades.length - 1]!.price;
              if (lastPrice > 0n) c.retryMinPrice = lastPrice;
            }
          }
        }
      }
      for (const mint of [...selling]) if (!hasPendingSellOwn(state, mint)) selling.delete(mint);
      for (const mint of [...held.keys()]) {
        if (!state.positions.has(mint) && !selling.has(mint) && !hasPendingBuyOwn(state, mint)) closeHeld(mint, state.slot);
      }

      // Exits first: only positions this book opened itself.
      for (const [mint, h] of [...held]) {
        if (orders.length >= cap) break;
        const pos = state.positions.get(mint);
        if (pos === undefined) continue;
        if (selling.has(mint)) continue;
        const c = coins.get(mint);
        let mk = marks.get(mint);
        if (mk === undefined) {
          const cv = state.curves.get(mint);
          if (cv === undefined) continue;
          mk = { vq: cv.virtual_quote_reserves, vt: cv.virtual_token_reserves };
        }
        const value = sellValue(pos.token_amount, mk.vq, mk.vt) - tx;
        const basis = pos.cost_lamports + h.txPaid;
        if (value > h.best) h.best = value;
        let exit = false;
        if (basis > 0n) {
          if (P.tp1Bps > 0 && !h.tookTp1 && value * BPS >= basis * (BPS + BigInt(P.tp1Bps))) {
            const part = (pos.token_amount * BigInt(P.tp1PartBps)) / BPS;
            if (part > 0n && part < pos.token_amount) {
              orders.push({ side: 'sell', mint, token_amount: part, max_slippage_bps: 10_000, client_id: `rq-s${++sellSeq}` });
              selling.add(mint);
              h.tookTp1 = true;
              h.best = 0n;
              continue;
            }
          }
          if (value * BPS >= basis * (BPS + BigInt(P.tpBps))) exit = true;
          const sl = h.tookTp1 ? BigInt(P.slAfterTp1Bps) : BigInt(P.slBps);
          if (value * BPS <= basis * (BPS - sl)) exit = true;
          if (h.best * BPS >= basis * (BPS + BigInt(P.trailArmBps)) && value * BPS <= h.best * (BPS - BigInt(P.trailBps))) exit = true;
        }
        if (state.slot - h.openedSlot >= P.maxHold) exit = true;
        if (c !== undefined) {
          if (P.exitOnDevSell && c.devSold && !h.devSoldAtOpen) exit = true;
          if (state.slot - c.lastTradeSlot >= P.staleSlots) exit = true;
          const w = windowStats(c, state.slot);
          if (w.flow < -BigInt(P.exitFlowLamports)) exit = true;
          if (w.maxSell >= BigInt(P.bigSellLamports)) exit = true;
        }
        if (!exit) continue;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000, client_id: `rq-s${++sellSeq}` });
        selling.add(mint);
        // K8: entry slot is returned when the position closes (closeHeld),
        // so the coin may be re-entered after the cooldown.
      }

      // Entries.
      let free = state.freeCashLamports() - tx * BigInt(orders.length);
      const maxOpen = state.hello.caps.max_open_positions;
      for (const c of coins.values()) {
        if (orders.length >= cap) break;
        if (c.complete) continue;
        if (c.entries >= P.maxEntries) { continue; }
        if (held.has(c.mint) || selling.has(c.mint)) { continue; }
        if (state.positions.has(c.mint) || hasPendingBuyAny(state, c.mint) || ctx.bought.has(c.mint)) { continue; }
        if (c.createdSlot === null || state.slot - c.createdSlot < P.minAge) { continue; }
        if (state.committedPositionCount() + ctx.bought.size >= maxOpen) { continue; }
        const curve = state.curves.get(c.mint);
        if (curve === undefined || curve.complete) { continue; }
        if (!crossed(c, state.slot, curve.real_quote_reserves)) { continue; }
        const w = windowStats(c, state.slot);
        if (w.count === 0 || w.last <= 0n) { continue; }
        if (w.last * 10000n < w.high * BigInt(P.nearHighBps)) { continue; }
        if (w.flow < BigInt(P.minFlowLamports)) { continue; }
        if (w.buyers < P.minBuyers) { continue; }
        if (P.skipDevSold && c.devSold) { continue; }
        if (c.lastExitSlot !== null && state.slot - c.lastExitSlot < P.cooldownSlots) { continue; }
        if (c.retryMinPrice !== null && w.last < c.retryMinPrice) { continue; }
        const conc = concentration(c);
        if (conc.total > 0n) {
          if (conc.top1 * 10000n > conc.total * BigInt(P.maxTop1ShareBps)) { continue; }
          if (conc.top5 * 10000n > conc.total * BigInt(P.maxTop5ShareBps)) { continue; }
        }
        const maxBuy = state.maxBuyLamports(c.mint);
        const amount = stake < maxBuy ? stake : maxBuy;
        if (amount < minBuy) { continue; }
        if (free < amount + tx * 6n) { continue; }
        orders.push({ side: 'buy', mint: c.mint, quote_lamports: amount, max_slippage_bps: P.buySlippageBps, client_id: `rq-b${++buySeq}` });
        free -= amount + tx;
        c.entries += 1;
        ctx.bought.add(c.mint);
      }
    },
  };
}
