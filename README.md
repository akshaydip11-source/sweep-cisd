# Sweep + CISD — XAUUSD Automation Platform

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/akshaydip11-source/sweep-cisd)

End-to-end trading automation around the **H1 Liquidity Sweep + M5 CISD** MQL5 Expert Advisor.

```
sweep-cisd/
├── mql5/SweepCISD_Bridge.mq5   # the EA (original logic) + REST bridge + remote control
├── backend/                    # FastAPI: backtest engine, MT5 bridge API, WebSocket push
│   ├── strategy.py             # exact Python port of the EA logic + stats
│   ├── data.py                 # synthetic data, MT5 CSV parser, Twelve Data API
│   └── main.py                 # API
├── frontend/                   # React + Vite dashboard (lightweight-charts)
└── docker-compose.yml
```

## Quick start
```bash
# 1. backend
cd backend && pip install -r requirements.txt
BRIDGE_TOKEN=my-secret uvicorn main:app --host 0.0.0.0 --port 8000

# 2. frontend
cd frontend && npm install && npm run dev      # http://localhost:5173

# or: docker compose up --build
```

## Connect MetaTrader 5
1. Copy `mql5/SweepCISD_Bridge.mq5` to `MQL5/Experts/`, compile in MetaEditor.
2. MT5 → Tools → Options → Expert Advisors → *Allow WebRequest for listed URL* → add `http://127.0.0.1:8000` (or your server URL).
3. Attach to an XAUUSD chart, enable Algo Trading, set `ServerURL` and `BridgeToken` inputs.
4. Open the dashboard → Live page shows heartbeat, account, strategy state, positions, events; Pause / Resume / Close all control the EA.

## Backtester
Synthetic data (offline), **MT5 CSV export** (View → Symbols → Bars → Export), or live 5-min data via a free
[Twelve Data](https://twelvedata.com) key (`TWELVEDATA_API_KEY` env or entered in the UI).

## Deploy & go live
- **DEPLOY.md** — Render / Railway / Fly / VPS, one Docker image
- **LIVE_TRADING_GUIDE.md** — checklist before putting real money on it

## Tests
```bash
cd backend && python -m pytest -q
```

> Not financial advice. Test on a demo account first.
