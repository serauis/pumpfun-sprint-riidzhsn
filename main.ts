// Pump.fun Bot Sprint entry: selective sniper + rq-runner + probe books.
// Run by the grader as `node /bot/main.ts`; the strategy lives in
// strategy.ts, the protocol in the vendored SDK shim
// (vendor/agentfun-bot.ts, a byte-identical copy of the kit's sdk/ts file).

import { runBot } from './vendor/agentfun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

const strategy = createStrategy(DEFAULT_PARAMS);

await runBot({
  onBatch: (state, batch) => strategy.onBatch(state, batch),
});
