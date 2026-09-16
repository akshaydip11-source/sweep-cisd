import { useEffect, useRef, useState } from 'react'
import { api, fmt } from '../lib/api'
import { PriceChart, EquityChart } from './Charts'

const DEFAULTS = {
  symbol: 'XAUUSD', risk_per_trade: 25, risk_reward: 1, max_cisd_candles: 4, sl_buffer_points: 10,
  point: 0.01, contract_size: 100, volume_min: 0.01, volume_max: 100, volume_step: 0.01,
  spread_points: 20, one_position_only: true, initial_balance: 10000,
}

function Stat({ label, value, sub, cls }) {
  return (
    <div className="card stat">
      <span className="label">{label}</span>
      <span className={`value ${cls || ''}`}>{value}</span>
      {sub && <span className="sub">{sub}</span>}
    </div>
  )
}

export default function Backtest({ notify }) {
  const [settings, setSettings] = useState(DEFAULTS)
  const [source, setSource] = useState('synthetic')
  const [days, setDays] = useState(20)
  const [seed, setSeed] = useState(42)
  const [apiKey, setApiKey] = useState('')
  const [liveAvailable, setLiveAvailable] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState(null)
  const [tab, setTab] = useState('trades')
  const fileRef = useRef()

  useEffect(() => {
    api.settings().then((s) => { setLiveAvailable(s.live_data_available) }).catch(() => {})
    api.lastBacktest().then(setResult).catch(() => {})
  }, [])

  const set = (k) => (e) => {
    const v = e.target.type === 'checkbox' ? e.target.checked : e.target.value
    setSettings((s) => ({ ...s, [k]: e.target.type === 'number' ? Number(v) : v }))
  }

  async function run() {
    setLoading(true); setError('')
    try {
      const r = await api.backtest({ source, days: Number(days), seed: seed === '' ? null : Number(seed), settings, api_key: apiKey || null })
      setResult(r)
      notify(`Backtest complete: ${r.stats.total_trades} trades, net ${fmt.money(r.stats.net_profit)}`)
    } catch (e) { setError(e.message) } finally { setLoading(false) }
  }

  async function upload(file) {
    if (!file) return
    setLoading(true); setError('')
    try {
      const r = await api.backtestUpload(file, settings)
      setResult(r); setSource('cached')
      notify(`CSV loaded: ${r.meta.candles} candles, ${r.stats.total_trades} trades`)
    } catch (e) { setError(e.message) } finally { setLoading(false) }
  }

  const st = result?.stats

  return (
    <>
      <div className="topbar">
        <div>
          <h2>Strategy Backtester</h2>
          <p>Exact port of the MQL5 EA — H1 liquidity sweep on M5 with CISD confirmation, fixed-risk sizing.</p>
        </div>
        {result?.meta && <span className="badge badge-blue">{result.meta.source} · {fmt.time(result.meta.from)} → {fmt.time(result.meta.to)} · {result.meta.elapsed_ms} ms</span>}
      </div>

      <div className="grid grid-side">
        <div className="card">
          <div className="card-title"><h3>Configuration</h3></div>
          <div className="form">
            <div className="field">
              <label>Data source</label>
              <select value={source} onChange={(e) => setSource(e.target.value)}>
                <option value="synthetic">Synthetic market data (offline)</option>
                <option value="live">Live market data (Twelve Data API)</option>
                <option value="cached">Uploaded CSV</option>
              </select>
            </div>
            {source === 'synthetic' && (
              <div className="row">
                <div className="field"><label>Days</label><input type="number" min="1" max="120" value={days} onChange={(e) => setDays(e.target.value)} /></div>
                <div className="field"><label>Seed</label><input type="number" value={seed} onChange={(e) => setSeed(e.target.value)} /></div>
              </div>
            )}
            {source === 'live' && (
              <div className="field">
                <label>Twelve Data API key {liveAvailable && <span className="badge badge-green">server key set</span>}</label>
                <input type="password" placeholder={liveAvailable ? 'Using server key (optional override)' : 'Paste your free API key'} value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
              </div>
            )}
            {source === 'cached' && (
              <>
                <input ref={fileRef} type="file" accept=".csv,.txt" style={{ display: 'none' }} onChange={(e) => upload(e.target.files[0])} />
                <div className="upload" onClick={() => fileRef.current.click()}>Click to upload MT5 M5 export (.csv) — runs immediately</div>
              </>
            )}

            <div className="row">
              <div className="field"><label>Symbol</label><input value={settings.symbol} onChange={set('symbol')} /></div>
              <div className="field"><label>Initial balance</label><input type="number" value={settings.initial_balance} onChange={set('initial_balance')} /></div>
            </div>
            <div className="row">
              <div className="field"><label>Risk per trade ($)</label><input type="number" step="1" value={settings.risk_per_trade} onChange={set('risk_per_trade')} /></div>
              <div className="field"><label>Risk : Reward</label><input type="number" step="0.1" value={settings.risk_reward} onChange={set('risk_reward')} /></div>
            </div>
            <div className="row">
              <div className="field"><label>Max CISD candles</label><input type="number" value={settings.max_cisd_candles} onChange={set('max_cisd_candles')} /></div>
              <div className="field"><label>SL buffer (points)</label><input type="number" value={settings.sl_buffer_points} onChange={set('sl_buffer_points')} /></div>
            </div>
            <div className="row">
              <div className="field"><label>Spread (points)</label><input type="number" value={settings.spread_points} onChange={set('spread_points')} /></div>
              <div className="field"><label>Contract size</label><input type="number" value={settings.contract_size} onChange={set('contract_size')} /></div>
            </div>
            <div className="row">
              <div className="field"><label>Point</label><input type="number" step="0.00001" value={settings.point} onChange={set('point')} /></div>
              <div className="field"><label>Volume step</label><input type="number" step="0.01" value={settings.volume_step} onChange={set('volume_step')} /></div>
            </div>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
              <input type="checkbox" checked={settings.one_position_only} onChange={set('one_position_only')} /> One position at a time
            </label>
            {error && <div className="alert alert-error">{error}</div>}
            <button className="btn btn-primary" onClick={run} disabled={loading || source === 'cached' && !result}>
              {loading ? <span className="spinner" /> : '▶'} {loading ? 'Running…' : 'Run backtest'}
            </button>
            <button className="btn btn-sm" onClick={() => setSettings(DEFAULTS)}>Reset to EA defaults</button>
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
          {!result && <div className="card empty">Run a backtest to see performance, trades and chart markers.</div>}
          {st && (
            <>
              <div className="grid grid-4">
                <Stat label="Net profit" value={fmt.money(st.net_profit)} cls={st.net_profit >= 0 ? 'pos' : 'neg'} sub={`${st.return_pct >= 0 ? '+' : ''}${st.return_pct}% return`} />
                <Stat label="Win rate" value={fmt.pct(st.win_rate)} sub={`${st.wins}W / ${st.losses}L of ${st.total_trades}`} />
                <Stat label="Profit factor" value={fmt.num(st.profit_factor)} cls={st.profit_factor >= 1 ? 'pos' : 'neg'} sub={`Expectancy ${fmt.money(st.expectancy)}/trade`} />
                <Stat label="Max drawdown" value={fmt.money(st.max_drawdown)} cls="warn" sub={`${st.max_drawdown_pct}% of balance`} />
              </div>
              <div className="card">
                <div className="card-title"><h3>Price · M5 with sweeps & entries</h3>
                  <span style={{ fontSize: 12, color: 'var(--muted)' }}>● sweep &nbsp; ▲ buy &nbsp; ▼ sell &nbsp; ■ exit</span></div>
                <PriceChart candles={result.candles} trades={result.trades} signals={result.signals} />
              </div>
              <div className="grid grid-2">
                <div className="card">
                  <div className="card-title"><h3>Equity curve</h3></div>
                  <EquityChart equity={result.equity} initial={result.settings.initial_balance} />
                </div>
                <div className="card">
                  <div className="card-title"><h3>Breakdown</h3></div>
                  <div className="kv">
                    <span className="k">Final balance</span><span className="v">{fmt.money(st.final_balance)}</span>
                    <span className="k">Gross profit</span><span className="v pos">{fmt.money(st.gross_profit)}</span>
                    <span className="k">Gross loss</span><span className="v neg">{fmt.money(-st.gross_loss)}</span>
                    <span className="k">Average win</span><span className="v">{fmt.money(st.avg_win)}</span>
                    <span className="k">Average loss</span><span className="v">{fmt.money(st.avg_loss)}</span>
                    <span className="k">Buys / Sells</span><span className="v">{st.buys} / {st.sells}</span>
                    <span className="k">Best win streak</span><span className="v">{st.best_streak}</span>
                    <span className="k">Worst loss streak</span><span className="v">{st.worst_streak}</span>
                    <span className="k">Signals (sweeps/expired)</span><span className="v">{result.signals.length}</span>
                  </div>
                </div>
              </div>
              <div className="card">
                <div className="card-title">
                  <h3>{tab === 'trades' ? 'Trades' : 'Signals'}</h3>
                  <div className="tabs">
                    <button className={tab === 'trades' ? 'active' : ''} onClick={() => setTab('trades')}>Trades ({result.trades.length})</button>
                    <button className={tab === 'signals' ? 'active' : ''} onClick={() => setTab('signals')}>Signals ({result.signals.length})</button>
                  </div>
                </div>
                <div className="table-wrap">
                  {tab === 'trades' ? (
                    <table>
                      <thead><tr><th>#</th><th>Side</th><th>Entry time</th><th>Entry</th><th>SL</th><th>TP</th><th>Lots</th><th>Exit time</th><th>Exit</th><th>Result</th><th>P&L</th></tr></thead>
                      <tbody>
                        {[...result.trades].reverse().map((t) => (
                          <tr key={t.id}>
                            <td>{t.id}</td>
                            <td><span className={`badge ${t.direction === 'BUY' ? 'badge-green' : 'badge-red'}`}>{t.direction}</span></td>
                            <td>{fmt.time(t.entry_time)}</td><td className="mono">{t.entry_price}</td><td className="mono">{t.sl}</td><td className="mono">{t.tp}</td>
                            <td>{t.volume}</td><td>{fmt.time(t.exit_time)}</td><td className="mono">{t.exit_price ?? '—'}</td>
                            <td><span className={`badge ${t.result === 'TP' ? 'badge-green' : t.result === 'SL' ? 'badge-red' : 'badge-gray'}`}>{t.result}</span></td>
                            <td className={t.pnl >= 0 ? 'pos' : 'neg'}>{fmt.money(t.pnl)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <table>
                      <thead><tr><th>Time</th><th>Type</th><th>Price</th><th>Note</th></tr></thead>
                      <tbody>
                        {[...result.signals].reverse().map((s, i) => (
                          <tr key={i}>
                            <td>{fmt.time(s.time)}</td>
                            <td><span className={`badge ${s.kind.startsWith('CISD') ? 'badge-blue' : s.kind === 'EXPIRED' ? 'badge-gray' : 'badge-amber'}`}>{s.kind}</span></td>
                            <td className="mono">{fmt.num(s.price)}</td><td>{s.note}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </>
  )
}
