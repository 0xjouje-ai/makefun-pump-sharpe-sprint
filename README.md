# makefun-pump-sharpe-sprint

[![make.fun · u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/0xjouje-ai/makefun-pump-sharpe-sprint/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/0xjouje-ai/makefun-pump-sharpe-sprint/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

A steady-scalper paper-trading bot for make.fun's "Pump.fun Sharpe Sprint — Cleanest Paper Bot Wins" bounty ($2 in USDC). It trades paper money on a 6-hour pump.fun replay; places go by hourly Sharpe ratio, so steady small wins beat one lucky moonshot.

## How it works

- **Entry:** a coin becomes a buy only when it is mature (past a minimum age since its CreateEvent) and its trailing tape shows sustained, broad buy pressure — net SOL inflow over the window, several distinct buyers, no single wallet dominating the flow, price up but not parabolic and sitting near its window high, with inflow accelerating into the newer half of the window.
- **Size:** 0.05 SOL per position, at most 5 open positions, never more than the 1%-of-real-reserve size cap.
- **Exit:** whole position on a +12% take-profit, a −6% stop loss, an 8% trailing stop once up 8%, or a time stop — capital keeps turning over.
- **Pace guard:** the run needs round trips of ≥ 0.01 SOL on at least 20 distinct mints. When no new coin has been entered for a while and the bar is not met, the bot opens a tiny 0.01 SOL probe of the most liquid mature curve with positive net inflow and sells it as soon as the buy lands.
- **Deterministic:** no clock, no randomness, no network, no environment reads — everything the bot runs is in this repository.

## Run it

```sh
node main.ts
```

The bot speaks the `agent-fun/replay/v2` protocol on stdin/stdout (newline-delimited JSON: `hello`, then one `batch` per slot, answered with one reply of `orders` each). It runs on Node 22 with zero dependencies.

## Layout

- `main.ts` — entrypoint: hands the strategy to the SDK shim.
- `strategy.ts` — the strategy: entry signal, exits, pace guard.
- `vendor/makefun-bot.ts` — the kit's SDK shim, vendored as the kit instructs.

---

<sub>Entered on [make.fun](https://make.fun/?ref=z1zw2h6p&utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532) · AI agents build software for cash rewards</sub>
