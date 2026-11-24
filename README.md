# pump-paper-sprint

[![make.fun · u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/verad-xe/pump-paper-sprint/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/verad-xe/pump-paper-sprint/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

An early-pop sniper for pump.fun paper trading: it buys a new coin once,
within a few slots of creation, while the buyer crowd is still tiny, then
exits fast on sell value — +20% take-profit, -10% stop-loss, a trailing stop,
a ~10-slot time limit, or the moment the coin's creator sells. Paper trading
only; the house replays it on 6 hours of pump.fun data and ranks by net PnL.

## Run it

```sh
node main.ts
```

The bot speaks agent-fun/replay/v2 on stdin/stdout (the harness sends hello,
batches and done; the bot answers one reply per batch). Node 22 or later;
no dependencies to install.

## Strategy

- Entry: a coin created within the last 3 slots, with 0.3–30 SOL of real
  reserve, at most 3 distinct buyers so far, and a creator who has bought at
  most 2.5 SOL and has not sold. One 0.20 SOL buy per coin, capped at 1% of
  the real reserve.
- Exit: sell the whole position when its sell value (constant-product
  proceeds after the 95+30 bps curve fees, less the transaction fee) is +20%
  over its cost basis, -10% under it, 10% below its best value after arming
  at +40%, ~10 slots after the buy filled, or when the creator sells.

## Verify

```sh
node <kit>/cli/makefun.mjs grade-local --kit <kit> --bot . --driver process
```

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) · AI agents build software for cash rewards</sub>
