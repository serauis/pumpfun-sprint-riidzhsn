// One bot, three books: selective sniper, rq-runner, probe. Written from the
// frozen spec (SPEK BEKU section 1 + section 4 + clarifications K2/K5/K6)
// for the u-riidzhsn pump.fun sprint. The books share 10 SOL cash and a
// 5-position / 16-order-per-batch cap but never share a position: every order
// carries its book's client_id prefix (sn- / rq- / pb-), a book never buys a
// mint another book holds or just bought on the same batch, and each batch
// runs sniper, then rq-runner, then probe-sell, then probe-buy. No clock, no
// randomness: a pure function of the batches it is fed.

import { type BotState, type Batch, type OrderInput, type Pubkey } from './vendor/agentfun-bot.ts';
import { createSniper, SNIPER_DEFAULTS, type SniperParams, type BookCtx } from './strategy-sniper.ts';
import { createRq, RQ_DEFAULTS, type RqParams } from './strategy-rq.ts';

export interface ProbeParams {
  targetCoins: number;
  paceSecs: number;
  probeSolLamports: number;
  probeMinRqLamports: number;
  buySlippageBps: number;
  sellSlippageBps: number;
}

export const PROBE_DEFAULTS: ProbeParams = {
  targetCoins: 36,
  paceSecs: 21_600,
  probeSolLamports: 12_000_000,
  probeMinRqLamports: 10_000_000_000,
  buySlippageBps: 1500,
  sellSlippageBps: 10_000,
};

export interface Params {
  sniper: SniperParams;
  rq: RqParams;
  probe: ProbeParams;
}

export const DEFAULT_PARAMS: Params = {
  sniper: SNIPER_DEFAULTS,
  rq: RQ_DEFAULTS,
  probe: PROBE_DEFAULTS,
};

export interface Strategy {
  onBatch(state: BotState, batch: Batch): OrderInput[];
}

export function createStrategy(params: Params = DEFAULT_PARAMS): Strategy {
  const sniper = createSniper(params.sniper);
  const rq = createRq(params.rq);
  const P = params.probe;
  /** Total filled buy lamports per mint, across all three books. */
  const totalBuy = new Map<Pubkey, bigint>();
  /** Mints a probe buy was ever sent on. */
  const probed = new Set<Pubkey>();
  /** The one probe currently in flight or held, if any. */
  let probing: { mint: Pubkey; tokens: bigint; landed: boolean } | null = null;
  let probeBuySeq = 0;
  let probeSellSeq = 0;
  let firstTime: number | null = null;
  let nowTime = 0;

  function hasPending(state: BotState, mint: Pubkey, side: 'buy' | 'sell'): boolean {
    for (const p of state.pending.values()) {
      if (p.order.mint === mint && p.order.side === side) return true;
    }
    return false;
  }

  /** Guardrail coins: total buys of at least 0.01 SOL whose position is
   *  already closed (not held, no order pending). */
  function guardrailCount(state: BotState): number {
    let n = 0;
    for (const [mint, bought] of totalBuy) {
      if (bought < 10_000_000n) continue;
      if (state.positions.has(mint)) continue;
      if (hasPending(state, mint, 'buy') || hasPending(state, mint, 'sell')) continue;
      n++;
    }
    return n;
  }

  /** How many guardrail coins the pace demands by now. */
  function pace(): number {
    if (firstTime === null) return 0;
    const elapsed = Math.max(0, Math.min(P.paceSecs, nowTime - firstTime));
    return Math.min(P.targetCoins, Math.ceil((P.targetCoins * elapsed) / P.paceSecs));
  }

  return {
    onBatch(state, batch) {
      for (const e of batch.events) {
        if (e.block_time === null) continue;
        if (firstTime === null) firstTime = e.block_time;
        if (e.block_time > nowTime) nowTime = e.block_time;
      }
      // Probe bookkeeping reads every book's fills for the guardrail totals,
      // but probe tokens only ever come from a filled pb- buy.
      for (const f of batch.fills) {
        if (f.side === 'buy' && f.status === 'filled') {
          totalBuy.set(f.mint, (totalBuy.get(f.mint) ?? 0n) + BigInt(f.quote_lamports));
        }
        if (f.client_id.startsWith('_')) {
          if (probing !== null && probing.mint === f.mint) probing = null;
          continue;
        }
        if (!f.client_id.startsWith('pb-')) continue;
        if (probing === null || probing.mint !== f.mint) continue;
        if (f.side === 'buy') {
          if (f.status === 'filled') {
            probing.tokens = BigInt(f.token_amount);
            probing.landed = true;
          } else if (f.status === 'failed' || f.status === 'rejected') {
            probing = null;
          }
        } else if (f.side === 'sell' && f.status === 'filled') {
          probing = null;
        }
      }

      const ctx: BookCtx = { orders: [], bought: new Set<Pubkey>() };
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = state.txFeeLamports();

      // Per batch: sniper, then rq-runner, then probe-sell, then probe-buy.
      sniper.onBatch(state, batch, ctx);
      rq.onBatch(state, batch, ctx);

      // Probe-sell: dump the probe tokens as soon as the buy lands (K6: sell
      // the smaller of the landed probe tokens and the tokens now held).
      if (probing !== null && probing.landed) {
        const pos = state.positions.get(probing.mint);
        if (pos === undefined) {
          probing = null;
        } else if (!hasPending(state, probing.mint, 'sell') && ctx.orders.length < cap) {
          const tokens = probing.tokens < pos.token_amount ? probing.tokens : pos.token_amount;
          if (tokens <= 0n) {
            probing = null;
          } else {
            ctx.orders.push({ side: 'sell', mint: probing.mint, token_amount: tokens, max_slippage_bps: P.sellSlippageBps, client_id: `pb-s${++probeSellSeq}` });
          }
        }
      }

      // Probe-buy: at most one probe at a time, only while the guardrail
      // count lags the pace, on the most liquid coin trading on this batch
      // (K2) with real reserves of at least 10 SOL.
      const gc = guardrailCount(state);
      const pc = pace();
      if (probing === null && gc < pc) {
        const open = state.committedPositionCount() + ctx.bought.size;
        if (open < state.hello.caps.max_open_positions && ctx.orders.length < cap) {
          const free = state.freeCashLamports() - tx * BigInt(ctx.orders.length);
          const want = BigInt(P.probeSolLamports);
          if (free >= want + tx) {
            const seen = new Set<Pubkey>();
            let bestMint: Pubkey | null = null;
            let bestRq = -1n;
            for (const e of batch.events) {
              if (e.event !== 'TradeEvent') continue;
              const mint = e.mint;
              if (seen.has(mint)) continue;
              seen.add(mint);
              if (probed.has(mint)) continue;
              if (state.positions.has(mint) || ctx.bought.has(mint)) continue;
              if (hasPending(state, mint, 'buy') || hasPending(state, mint, 'sell')) continue;
              const curve = state.curves.get(mint);
              if (curve === undefined || curve.complete) continue;
              if (curve.real_quote_reserves < BigInt(P.probeMinRqLamports)) continue;
              if (curve.real_quote_reserves > bestRq) {
                bestRq = curve.real_quote_reserves;
                bestMint = mint;
              }
            }
            if (bestMint !== null) {
              const maxBuy = state.maxBuyLamports(bestMint);
              const amount = want < maxBuy ? want : maxBuy;
              if (amount > 0n) {
                ctx.orders.push({ side: 'buy', mint: bestMint, quote_lamports: amount, max_slippage_bps: P.buySlippageBps, client_id: `pb-b${++probeBuySeq}` });
                probed.add(bestMint);
                probing = { mint: bestMint, tokens: 0n, landed: false };
                ctx.bought.add(bestMint);
              }
            }
          }
        }
      }

      // The reply is cut at the 16-order cap; the probe orders sit last, so
      // they are the first to be cut.
      return ctx.orders.slice(0, cap);
    },
  };
}
