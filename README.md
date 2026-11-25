# peer-priced-radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/kunkuro30/peer-priced-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/kunkuro30/peer-priced-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A token launch radar whose first screen is an audit, not an advert. Every one of
the sealed snapshot's 758 protocols is accounted for — priced as a peer, priced as
a wrapper, boarded as a launch candidate, or set aside with the reason named and
counted. Nothing is silently dropped, and the board carries **all 198 launch
candidates**, not a top cut.

Prices come from the snapshot's own trading peers: the 94 launch-type tokens that
trade today, split into momentum and reversion regimes by the sign of their
seven-day TVL move. Each regime prices with its own category medians of
market-cap/TVL, shrunk toward the regime median (K = 4.5, chosen on a 2–8 grid by
blind tests), corrected by one pooled, Huber-robust size slope. Around each price:
a conformal band from that category family's own leave-one-out misses, a
launch-odds read fitted on the peers' historical record, and a farm plan costed
step by step in dollars and minutes, tiered by odds-weighted value per cost-hour.

The model had to earn its shape. Every term it was offered — an age slope, a
continuous growth term, a chain-count term, a two-level family shrinkage, other
shrink weights, dropping the regime split — was fitted and graded blind on
leave-one-out and a time split, against a pure empirical-median baseline and a
regime-swapped negative control. The age slope the previous generation of this
radar carried **failed that vote on both holdouts and is gone**; the dashboard
prints the full table, the five holdout schemes, and the single worst miss by
name, on frame one.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input /path/to/kit/input/snapshot.json
```

Node 22.18 or later, standard library only, no network. The program reads the
sealed snapshot and writes `out/board.json`, `out/data.js`, `out/dashboard/`,
`out/screenshots/` and `out/dossier.json`. Two runs on the same snapshot write
the same bytes.

---
<sub>Entered on [make.fun](https://make.fun/?ref=67f9yk9n&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
