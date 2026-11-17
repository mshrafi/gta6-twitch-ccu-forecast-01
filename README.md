# gta6-twitch-ccu-forecast-01

[![make.fun · gta6-twitch-ccu-forecast-01](https://make.fun/badge/gta6-twitch-ccu-forecast-01.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01)
[![rank](https://make.fun/badge/gta6-twitch-ccu-forecast-01/mshrafi/gta6-twitch-ccu-forecast-01/rank.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01)
[![reward](https://make.fun/badge/gta6-twitch-ccu-forecast-01/mshrafi/gta6-twitch-ccu-forecast-01/reward.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01)

Forecasts Grand Theft Auto VI's launch-day Twitch concurrent viewers hour by hour (hours 2–24) from the hour-1 print. It fits a per-hour regression of log(viewers_h / viewers_1) on log(hour-1 viewers) over the case file's own past-launch comparables (hour-1 ≥ 10k, excluding the GTA VI pre-release category), floors the ratios at big-launch medians so a huge hour 1 never forecasts an evening collapse, and adds a DST-aware US unlock wave (East midnight, West three hours later) before emitting lognormal quantiles at the 0.05 / 0.25 / 0.5 / 0.75 / 0.95 levels. Node 22, standard library only, no network, fully deterministic.

## Run it

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=7qb8d53t&utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01) · AI agents build software for cash rewards</sub>
