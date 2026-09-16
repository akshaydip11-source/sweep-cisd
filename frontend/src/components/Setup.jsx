import { useEffect, useState } from 'react'
import { api } from '../lib/api'

export default function Setup() {
  const [health, setHealth] = useState(null)
  const [cfg, setCfg] = useState(null)
  useEffect(() => {
    api.health().then(setHealth).catch(() => setHealth({ ok: false }))
    api.settings().then(setCfg).catch(() => {})
  }, [])
  const origin = window.location.origin

  return (
    <>
      <div className="topbar">
        <div><h2>Setup & Connection</h2><p>How to connect MetaTrader 5 to this dashboard and how the strategy works.</p></div>
        <span className={`badge ${health?.ok ? 'badge-green' : 'badge-red'}`}><span className={`dot ${health?.ok ? 'on' : 'off'}`} /> API {health?.ok ? `online · v${health.version}` : 'offline'}</span>
      </div>

      <div className="grid grid-2">
        <div className="card">
          <div className="card-title"><h3>Connect MetaTrader 5</h3></div>
          <div className="steps">
            <div className="step"><span className="step-num">1</span><div><strong>Copy the EA</strong><p>Put <code>mql5/SweepCISD_Bridge.mq5</code> into <code>MQL5/Experts/</code> (File → Open Data Folder) and compile it in MetaEditor (F7).</p></div></div>
            <div className="step"><span className="step-num">2</span><div><strong>Allow WebRequest</strong><p>Tools → Options → Expert Advisors → tick <em>Allow WebRequest for listed URL</em> and add your backend URL, e.g. <code>http://127.0.0.1:8000</code> (or your public server URL).</p></div></div>
            <div className="step"><span className="step-num">3</span><div><strong>Attach to XAUUSD</strong><p>Drag the EA onto an XAUUSD chart (any timeframe – it reads M5/H1 internally). Enable <em>Algo Trading</em>. Set <code>ServerURL</code> and <code>BridgeToken</code> in the inputs.</p></div></div>
            <div className="step"><span className="step-num">4</span><div><strong>Watch the dashboard</strong><p>Within ~10 s the Live page shows a green heartbeat, account, strategy state, positions and events. Use Pause / Resume / Close all to control the EA remotely.</p></div></div>
          </div>
          <div className={`alert ${cfg?.bridge_token_set ? 'alert-info' : 'alert-warn'}`} style={{ marginTop: 14 }}>
            {cfg?.bridge_token_set ? 'Bridge token is set on the server. Use the same value in the EA input.' :
              'Server is using the default bridge token "change-me". For real use, start the backend with BRIDGE_TOKEN=your-secret and set the same in the EA.'}
          </div>
        </div>

        <div className="card">
          <div className="card-title"><h3>Run the stack</h3></div>
          <pre className="code">{`# Backend (FastAPI)
cd backend
pip install -r requirements.txt
BRIDGE_TOKEN=my-secret TWELVEDATA_API_KEY=optional \\
  uvicorn main:app --host 0.0.0.0 --port 8000

# Frontend (React + Vite)
cd frontend
npm install
npm run dev          # http://localhost:5173  (proxies /api and /ws to :8000)
npm run build        # production bundle in frontend/dist

# Docker (both services)
docker compose up --build`}</pre>
          <div className="card-title" style={{ marginTop: 14 }}><h3>API endpoints</h3></div>
          <pre className="code">{`GET  /api/health                 GET  /api/live
GET  /api/settings               POST /api/live/command {command}
POST /api/backtest               GET  /api/live/events
POST /api/backtest/upload (CSV)  WS   /ws
POST /api/bridge/heartbeat       POST /api/bridge/event
POST /api/bridge/positions       GET  /api/bridge/command?token=
Docs: ${origin}/api/docs (Swagger via backend :8000/docs)`}</pre>
        </div>

        <div className="card" style={{ gridColumn: '1 / -1' }}>
          <div className="card-title"><h3>Strategy rules (as coded in the EA)</h3></div>
          <div className="grid grid-3">
            <div>
              <strong>1 · Liquidity sweep</strong>
              <p style={{ color: 'var(--muted)' }}>On each closed M5 candle, compare to the <em>previous completed H1</em> candle. <br />
                <span className="pos">Bullish:</span> M5 low &lt; H1 low and M5 close &gt; H1 low. <br />
                <span className="neg">Bearish:</span> M5 high &gt; H1 high and M5 close &lt; H1 high. <br />
                State resets when a new H1 candle opens.</p>
            </div>
            <div>
              <strong>2 · CISD confirmation</strong>
              <p style={{ color: 'var(--muted)' }}>Within <code>MaxCISDCandles</code> (4) M5 candles after the sweep: <br />
                <span className="pos">Bullish CISD:</span> bullish candle closing above the <em>open</em> of the most recent bearish candle. <br />
                <span className="neg">Bearish CISD:</span> bearish candle closing below the <em>open</em> of the most recent bullish candle. <br />
                The sweep extreme keeps updating while waiting.</p>
            </div>
            <div>
              <strong>3 · Execution & risk</strong>
              <p style={{ color: 'var(--muted)' }}>Market entry at ask/bid. SL = sweep extreme ± <code>SLBufferPoints</code>. TP = risk × <code>RiskReward</code> (1:1). <br />
                Lot size = <code>RiskPerTrade</code> ($25) ÷ loss for 1 lot (OrderCalcProfit), floored to the broker's volume step. <br />
                Only one open position per symbol.</p>
            </div>
          </div>
          <div className="alert alert-warn" style={{ marginTop: 10 }}>
            Risk disclaimer: this is an automation tool, not financial advice. Test on a demo account first. Backtests use simplified fills (spread only, no slippage/commission) and synthetic data is not a substitute for real broker history — upload an MT5 export for realistic results.
          </div>
        </div>
      </div>
    </>
  )
}
