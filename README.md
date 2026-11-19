[![make.fun · gta6-trophy-rarity-forecast-01](https://make.fun/badge/gta6-trophy-rarity-forecast-01.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![rank](https://make.fun/badge/gta6-trophy-rarity-forecast-01/llonelyboys-gif/gta6-trophy-forecast/rank.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![reward](https://make.fun/badge/gta6-trophy-rarity-forecast-01/llonelyboys-gif/gta6-trophy-forecast/reward.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)

# GTA VI Trophy Rarity Forecast

Forecast each Grand Theft Auto VI trophy's Exophase earn rate at
2026-11-26T00:00:00Z — a week after launch — as five quantiles per trophy,
for the [make.fun](https://make.fun/bounty/gta6-trophy-rarity-forecast-01)
`gta6-trophy-rarity-forecast-01` bounty ($250 in USDC).

## What it is

`main.ts` (Node 22, standard library only, no network, deterministic) reads
every `*.in` case in `$MAKEFUN_INPUT_DIR` (else `/input`) and writes
`/output/<id>.out` with `{"trophies": [{"id": n, "q": [q05, q25, q50, q75,
q95]}, ...]}`.

## The model

Exophase only refreshes a game's counts in jumps: between refreshes the page
is frozen, so a flat stretch of history carries no signal about play. The
forecast works in counts, not rates:

- At a refresh the tracked population jumps from N to N' and the holders of
  trophy i jump from C to C'. That jump mixes the old cohort earning more
  trophies with newcomers arriving with the trophy already earned. Across
  the refreshes in a case's history the two are split with a two-term fit,
  per trophy: `C' - C ~= a * (N - C) * dt + b * (C / N) * (N' - N)`, where
  `a` is the per-hour hazard that a non-holder earns the trophy and `b` is
  the share of newcomers who arrive already holding it.
- The population at the target is projected from the refreshes seen so far
  (their rate, their mean log growth, decaying so later refreshes add less).
  When the history is flat — launch night, no refresh yet — the launch-night
  prior applies: Exophase's first refresh multiplied the tracked population
  about sixfold, and the newcomers held almost nothing but the one trophy
  everybody holds.
- Holders are simulated forward to the target in small steps: the cohort
  earns at the fitted hazard, the population grows toward its projection,
  newcomers arrive holding the trophy at share `b` of the current rate.
- The spread is honest about refresh jumps: a random-walk term in the
  horizon plus the jump sizes the history actually showed, so the 90% band
  is wide enough to cover a refresh the history has not seen yet.

## Local check

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=<kit>/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

On the kit's practice cases (which straddle Exophase's first refresh) the
forecast beats the house persistence baseline by a wide margin on pinball
loss, with the median placed where the refresh actually took the rates
instead of where they stood before it. Two runs on the same case write
byte-identical output, and a case runs in well under the 8-second cap.
