// Launch sniper: buys only clean early launches, adds once, exits fast.
// Written from the frozen spec (SPEK BEKU + clarifications K1-K11) for the
// u-riidzhsn pump.fun sprint. One of three books sharing 10 SOL cash and a
// 5-position / 16-order-per-batch cap; this book only ever touches its own
// sn- orders and sn- positions, and never buys a mint another book holds.
// No clock, no randomness: a pure function of the batches it is fed.

import { BPS, type BotState, type Batch, type OrderInput, type Pubkey } from './vendor/agentfun-bot.ts';

export interface SniperParams {
  minAge: number;
  maxAge: number;
  stakeLamports: number;
  minBuyLamports: number;
  maxAdds: number;
  addStepBps: number;
  addDelay: number;
  addLamports: number;
  addMinFlowLamports: number;
  minRealSol: number;
  maxRealSol: number;
  minDevBuy: number;
  maxDevBuy: number;
  minTrades: number;
  minBuyers: number;
  maxBuyers: number;
  maxSellRatioBps: number;
  maxBigSellBps: number;
  minRunupBps: number;
  maxRunupBps: number;
  flowWindow: number;
  minFlowLamports: number;
  minRecentBuyers: number;
  skipDevSold: boolean;
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
}

export const SNIPER_DEFAULTS: SniperParams = {
  minAge: 0,
  maxAge: 3,
  stakeLamports: 100_000_000,
  minBuyLamports: 5_000_000,
  maxAdds: 1,
  addStepBps: 0,
  addDelay: 2,
  addLamports: 100_000_000,
  addMinFlowLamports: 0,
  minRealSol: 2_500_000_000,
  maxRealSol: 30_000_000_000,
  minDevBuy: 1_500_000_000,
  maxDevBuy: 2_500_000_000,
  minTrades: 0,
  minBuyers: 0,
  maxBuyers: 1,
  maxSellRatioBps: 10_000,
  maxBigSellBps: 10_000,
  minRunupBps: 0,
  maxRunupBps: 1_000_000,
  flowWindow: 10,
  minFlowLamports: -1_000_000_000_000,
  minRecentBuyers: 0,
  skipDevSold: true,
  buySlippageBps: 10_000,
  tp1Bps: 1_000_000,
  tp1PartBps: 5_000,
  slAfterTp1Bps: 0,
  tpBps: 4000,
  slBps: 800,
  trailArmBps: 1_000_000,
  trailBps: 1000,
  maxHold: 10,
  exitOnDevSell: true,
  staleSlots: 1_000_000,
  exitFlowLamports: 1_000_000_000_000,
};

interface Tick {
  slot: number;
  isBuy: boolean;
  sol: bigint;
  user: Pubkey;
}

interface Coin {
  mint: Pubkey;
  createSlot: number;
  creator: Pubkey;
  vq0: bigint;
  vt0: bigint;
  devBuy: bigint;
  trades: number;
  buyers: Set<Pubkey>;
  bought: bigint;
  soldByOthers: bigint;
  bigSellBps: bigint;
  devSold: boolean;
  lastTradeSlot: number;
  recent: Tick[];
  buysSent: number;
  spentSent: bigint;
  lastBuyVq: bigint;
  lastBuyVt: bigint;
  lastBuySlot: number;
  done: boolean;
  complete: boolean;
}

interface Held {
  openedSlot: number;
  txPaid: bigint;
  best: bigint;
  devSoldAtOpen: boolean;
  tookTp1: boolean;
}

/** Shared reply state for one batch: the orders decided so far plus the
 *  mints the earlier books already bought on this batch. */
export interface BookCtx {
  orders: OrderInput[];
  bought: Set<Pubkey>;
}

const FEE_BPS = 125n;

/** What selling `tokens` against (vq, vt) would pay after curve fees. */
function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  return q - (q * FEE_BPS + BPS - 1n) / BPS;
}

export interface SniperBook {
  onBatch(state: BotState, batch: Batch, ctx: BookCtx): void;
}

export function createSniper(params: SniperParams = SNIPER_DEFAULTS): SniperBook {
  const P = params;
  const coins = new Map<Pubkey, Coin>();
  const held = new Map<Pubkey, Held>();
  /** Mints with a sell in flight. */
  const selling = new Set<Pubkey>();
  const stake = BigInt(P.stakeLamports);
  const minBuy = BigInt(P.minBuyLamports);
  let buySeq = 0;
  let sellSeq = 0;

  function readEvents(batch: Batch): void {
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        coins.set(e.mint, {
          mint: e.mint,
          createSlot: e.slot,
          creator: e.creator,
          vq0: BigInt(e.virtual_quote_reserves),
          vt0: BigInt(e.virtual_token_reserves),
          devBuy: 0n,
          trades: 0,
          buyers: new Set(),
          bought: 0n,
          soldByOthers: 0n,
          bigSellBps: 0n,
          devSold: false,
          lastTradeSlot: e.slot,
          recent: [],
          buysSent: 0,
          spentSent: 0n,
          lastBuyVq: 0n,
          lastBuyVt: 1n,
          lastBuySlot: 0,
          done: false,
          complete: false,
        });
      } else if (e.event === 'TradeEvent') {
        const c = coins.get(e.mint);
        if (c === undefined) continue;
        const sol = BigInt(e.sol_amount);
        c.trades += 1;
        c.lastTradeSlot = e.slot;
        c.recent.push({ slot: e.slot, isBuy: e.is_buy, sol, user: e.user });
        const isDev = e.user === c.creator;
        if (e.is_buy) {
          c.bought += sol;
          if (isDev && e.slot === c.createSlot) c.devBuy += sol;
          else if (!isDev) c.buyers.add(e.user);
        } else if (isDev) {
          c.devSold = true;
        } else {
          c.soldByOthers += sol;
          const rqBefore = BigInt(e.real_quote_reserves) + sol;
          if (rqBefore > 0n) {
            const bps = (sol * BPS) / rqBefore;
            if (bps > c.bigSellBps) c.bigSellBps = bps;
          }
        }
      } else {
        const c = coins.get(e.mint);
        if (c !== undefined) {
          c.complete = true;
          c.done = true;
        }
      }
    }
  }

  /** Net lamports bought minus sold and the distinct buyers, over the last flowWindow slots. */
  function flow(c: Coin, slot: number): { net: bigint; buyers: number } {
    const from = slot - P.flowWindow;
    let drop = 0;
    while (drop < c.recent.length && c.recent[drop]!.slot <= from) drop++;
    if (drop > 0) c.recent.splice(0, drop);
    let net = 0n;
    const buyers = new Set<Pubkey>();
    for (const t of c.recent) {
      if (t.isBuy) {
        net += t.sol;
        if (t.user !== c.creator) buyers.add(t.user);
      } else net -= t.sol;
    }
    return { net, buyers: buyers.size };
  }

  function hasPendingBuy(state: BotState, mint: Pubkey): boolean {
    for (const p of state.pending.values()) {
      if (p.order.mint === mint && p.order.side === 'buy' && p.order.client_id.startsWith('sn-')) return true;
    }
    return false;
  }

  function hasPendingSell(state: BotState, mint: Pubkey): boolean {
    for (const p of state.pending.values()) {
      if (p.order.mint === mint && p.order.side === 'sell' && p.order.client_id.startsWith('sn-')) return true;
    }
    return false;
  }

  return {
    onBatch(state, batch, ctx) {
      readEvents(batch);
      const orders = ctx.orders;
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = state.txFeeLamports();
      const marks = new Map<Pubkey, { vq: bigint; vt: bigint }>();
      for (const m of batch.marks) marks.set(m.mint, { vq: BigInt(m.virtual_quote_reserves), vt: BigInt(m.virtual_token_reserves) });

      // Own fills only (K5): sn- fills, plus harness "_" closes which clear
      // this book's held/selling state for the mint. Other books' fills are
      // ignored entirely here.
      for (const f of batch.fills) {
        if (f.client_id.startsWith('_')) {
          held.delete(f.mint);
          selling.delete(f.mint);
          continue;
        }
        if (!f.client_id.startsWith('sn-')) continue;
        const h = held.get(f.mint);
        if (f.status !== 'rejected' && h !== undefined) h.txPaid += BigInt(f.tx_fee_lamports);
        if (f.side === 'buy' && f.status === 'filled' && h === undefined) {
          const c = coins.get(f.mint);
          held.set(f.mint, {
            openedSlot: f.slot,
            txPaid: BigInt(f.tx_fee_lamports),
            best: 0n,
            devSoldAtOpen: c?.devSold ?? false,
            tookTp1: false,
          });
        }
      }
      for (const mint of [...selling]) if (!hasPendingSell(state, mint)) selling.delete(mint);
      for (const mint of [...held.keys()]) {
        if (!state.positions.has(mint) && !selling.has(mint) && !hasPendingBuy(state, mint)) held.delete(mint);
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
          if (!h.tookTp1 && value * BPS >= basis * (BPS + BigInt(P.tp1Bps))) {
            const part = (pos.token_amount * BigInt(P.tp1PartBps)) / BPS;
            if (part > 0n && part < pos.token_amount) {
              orders.push({ side: 'sell', mint, token_amount: part, max_slippage_bps: 10_000, client_id: `sn-s${++sellSeq}` });
              selling.add(mint);
              h.tookTp1 = true;
              h.best = 0n;
              if (c !== undefined) c.done = true;
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
          if (flow(c, state.slot).net < -BigInt(P.exitFlowLamports)) exit = true;
        }
        if (!exit) continue;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000, client_id: `sn-s${++sellSeq}` });
        selling.add(mint);
        if (c !== undefined) c.done = true;
      }

      // Entries and adds.
      let free = state.freeCashLamports() - tx * BigInt(orders.length);
      const maxOpen = state.hello.caps.max_open_positions;
      for (const c of coins.values()) {
        if (orders.length >= cap) break;
        if (c.done || c.complete) continue;
        const age = state.slot - c.createSlot;
        const isAdd = c.buysSent > 0;
        if (!isAdd && age > P.maxAge) {
          c.done = true;
          continue;
        }
        if (age < P.minAge) continue;
        if (isAdd) {
          if (c.buysSent > P.maxAdds) continue;
          if (!state.positions.has(c.mint) || selling.has(c.mint) || hasPendingBuy(state, c.mint)) continue;
        } else {
          if (state.committedPositionCount() + ctx.bought.size >= maxOpen) { continue; }
          if (state.positions.has(c.mint) || ctx.bought.has(c.mint)) { continue; }
        }
        const curve = state.curves.get(c.mint);
        if (curve === undefined || curve.complete) { continue; }
        if (c.devSold && (P.skipDevSold || isAdd)) {
          if (!isAdd) c.done = true;
          continue;
        }
        const vq = curve.virtual_quote_reserves;
        const vt = curve.virtual_token_reserves;
        if (isAdd) {
          // One add tranche, once the launch holds at/above the first buy's
          // decision price. addDelay counts from the slot the last buy order
          // was decided on; the price yardstick is the decision-time virtual
          // reserves (K11).
          if (state.slot - c.lastBuySlot < P.addDelay) continue;
          if (vq * c.lastBuyVt * BPS < c.lastBuyVq * vt * BigInt(10_000 + P.addStepBps)) continue;
          if (flow(c, state.slot).net < BigInt(P.addMinFlowLamports)) continue;
          const maxAdd = state.maxBuyLamports(c.mint);
          const amount = BigInt(P.addLamports) < maxAdd ? BigInt(P.addLamports) : maxAdd;
          if (amount < minBuy || free < amount + tx * 6n) continue;
          orders.push({ side: 'buy', mint: c.mint, quote_lamports: amount, max_slippage_bps: P.buySlippageBps, client_id: `sn-b${++buySeq}` });
          free -= amount + tx;
          c.buysSent += 1;
          c.spentSent += amount;
          c.lastBuyVq = vq;
          c.lastBuyVt = vt;
          c.lastBuySlot = state.slot;
          continue;
        }
        // Rug filter on the opening tape.
        const rq = curve.real_quote_reserves;
        if (rq < BigInt(P.minRealSol) || rq > BigInt(P.maxRealSol)) { continue; }
        if (c.devBuy < BigInt(P.minDevBuy) || c.devBuy > BigInt(P.maxDevBuy)) { continue; }
        if (c.trades < P.minTrades || c.buyers.size < P.minBuyers || c.buyers.size > P.maxBuyers) { continue; }
        if (c.bought > 0n && c.soldByOthers * BPS > c.bought * BigInt(P.maxSellRatioBps)) { continue; }
        if (c.bigSellBps > BigInt(P.maxBigSellBps)) { continue; }
        if (vt === 0n || c.vq0 === 0n) continue;
        const runup = (vq * c.vt0 * BPS) / (vt * c.vq0);
        if (runup > BigInt(P.maxRunupBps) || runup < BigInt(P.minRunupBps)) { continue; }
        const fl = flow(c, state.slot);
        if (fl.net < BigInt(P.minFlowLamports) || fl.buyers < P.minRecentBuyers) { continue; }
        const room = stake - c.spentSent;
        if (room < minBuy) { continue; }
        const maxBuy = state.maxBuyLamports(c.mint);
        const amount = room < maxBuy ? room : maxBuy;
        if (amount < minBuy) { continue; }
        if (free < amount + tx * 6n) { continue; }
        orders.push({ side: 'buy', mint: c.mint, quote_lamports: amount, max_slippage_bps: P.buySlippageBps, client_id: `sn-b${++buySeq}` });
        free -= amount + tx;
        c.buysSent += 1;
        c.spentSent += amount;
        c.lastBuyVq = vq;
        c.lastBuyVt = vt;
        c.lastBuySlot = state.slot;
        ctx.bought.add(c.mint);
      }
    },
  };
}
