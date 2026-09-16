# Going live with real money — read this first

This bot is technically ready to trade a real account. Whether it *should* is a separate question.
Follow this checklist in order; do not skip stages.

## Stage 0 — Understand what you have
- The strategy is a mechanical rule set: H1 sweep → M5 CISD → 1:1 R:R, $25 fixed risk. It has **no proven edge** yet.
  On synthetic data it loses (≈32–37% win rate at 1:1 → negative). Synthetic data is not real gold; real data may differ either way.
- Nobody — not this software, not any bot — can guarantee profit. Only risk money you can lose entirely.

## Stage 1 — Real-data backtest (1 day)
1. In MT5: View → Symbols → XAUUSD → **Bars** tab → M5, request 1–2 years → Export Bars (CSV).
2. Dashboard → Backtester → Uploaded CSV → upload. Check: profit factor, drawdown, trade count.
3. Also run the EA in MT5's **Strategy Tester** (Every tick based on real ticks) — it models spread/slippage/commission.
4. Tweak only *risk*-type settings (RR, SL buffer, session filter). If it's not profitable on real data after that, **stop** — deploying it won't change the math.

## Stage 2 — Demo forward test (minimum 4–8 weeks)
- Open a **demo** account with the *same broker* you'll use live. Attach `SweepCISD_Bridge.mq5`, connect to the dashboard.
- Run it on a VPS so it never misses a candle.
- Goal: the live-demo results should look like the backtest. If they don't, something is broken (spread, requotes, timing).

## Stage 3 — Small live account
- Start with an amount where `RiskPerTrade` is ≤ 1% of the account (e.g. $25 risk → $2,500+ account). Smaller accounts: lower `RiskPerTrade`.
- Use a regulated broker with a raw/ECN gold spread (gold spread of 20–30 points is normal; avoid brokers with 50+).
- Keep the safety inputs ON:
  | Input | Default | What it does |
  |---|---|---|
  | `MaxDailyLoss` | 75 | EA stops for the day after losing this much (3 losses) |
  | `MaxTradesPerDay` | 6 | Caps over-trading on choppy days |
  | `MaxSpreadPoints` | 50 | Skips entries when spread blows out (news) |
  | `MaxSlippagePoints` | 30 | Rejects fills far from the requested price |
  | `UseSessionFilter` | off | Trade only London/NY hours if backtest shows that's better |
- Broker-side stops are always placed (SL/TP on the order), so if VPS/internet dies, the trade is still protected.

## Stage 4 — Operate
- Check the dashboard daily: event log for `ORDER_FAIL`, `DAILY_LOCK`, `ERROR`.
- Use **Pause** before high-impact news (NFP, FOMC, CPI) — gold spikes wreck this kind of strategy.
- Scale `RiskPerTrade` up only after a full month of results in line with the backtest. Never after a losing streak.
- Withdraw profits periodically; keep the account at the size the risk was designed for.

## What this platform gives you for live trading
- ✅ Remote pause / resume / close-all from any device
- ✅ Real-time positions, P&L, daily loss lock status
- ✅ Event/error log to diagnose problems
- ✅ Password-protected controls, token-authenticated bridge
- ❌ Not included: strategy optimisation, multi-account management, guaranteed profit

**Bottom line:** yes, it can trade real money. The professional way to do it is: real-data backtest → 1–2 months demo → small live → scale slowly.
