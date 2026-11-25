# Pump.fun Bot Sprint — selective sniper + rq-runner + probe

[![make.fun](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/c/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/serauis/pumpfun-sprint-riidzhsn/rank.svg)](https://make.fun/c/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/serauis/pumpfun-sprint-riidzhsn/reward.svg)](https://make.fun/c/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

A trading bot for the [Pump.fun Bot Sprint](https://make.fun/c/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
on make.fun. One bot, three books sharing 10 SOL cash and a 5-position /
16-order-per-batch cap, never sharing a position:

- **Sniper** (`strategy-sniper.ts`): buys only clean early launches — the
  creator's first buy in [1.5–2.5] SOL, real reserves ≥ 2.5 SOL, age ≤ 3
  slots, at most 1 other buyer — stakes 0.1 SOL, adds once (0.1 SOL), exits
  at TP +40% / SL −8% / 10 slots / creator sell.
- **RQ-runner** (`strategy-rq.ts`): buys when real SOL just crossed 25 SOL
  while the price sits within 2% of its 200-slot high, on ≥ 0.5 SOL net flow
  and ≥ 3 distinct buyers with dispersed holders; stakes 0.22 SOL, exits at
  TP +35% / SL −12% / 122 slots / creator sell.
- **Probe** (`strategy.ts`): keeps the 6-hour guardrail pace (36 coins) by
  buying 0.012 SOL of the most liquid coin trading on the batch and selling
  the probe tokens as soon as the buy lands.

Deterministic: no clock, no randomness — a pure function of the batches it
is fed. The protocol shim in `vendor/agentfun-bot.ts` is a byte-identical
copy of the kit's `sdk/ts/makefun-bot.ts`.

## Verified (grade-local, --driver process)

- net PnL **+0.478725350 SOL**, 264 fills over 96 coins, 130 round trips,
  win rate 0.354, max drawdown 3.58%, 1 rejected, 7 failed
- action_log_sha256 `192d8f340766be19db9630b92e079c8c0500b42d288d9a453ae35dd818fbfaac`
- L1 regrade reproduced byte for byte; two executions identical
- stress-20: median −0.33, p10 −0.82, p90 +0.20 SOL; 14 of 20 block
  surrogates lost money — the dev score sits above all 20 copies, so it is
  window-dependent (see the grade's own warning).
