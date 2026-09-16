import { useEffect, useState } from 'react'
import { api, fmt, openSocket } from '../lib/api'

function Stat({ label, value, sub, cls }) {
  return (
    <div className="card stat">
      <span className="label">{label}</span>
      <span className={`value ${cls || ''}`}>{value}</span>
      {sub && <span className="sub">{sub}</span>}
    </div>
  )
}

const kindBadge = (k = '') => k.includes('SWEEP') ? 'badge-amber' : k.includes('CISD') ? 'badge-blue' : k.includes('FAIL') || k.includes('ERROR') ? 'badge-red'
  : k.includes('BUY') || k.includes('SELL') || k.includes('OPEN') ? 'badge-green' : 'badge-gray'

export default function Live({ notify }) {
  const [live, setLive] = useState(null)
  const [busy, setBusy] = useState('')
  const [, tick] = useState(0)

  useEffect(() => {
    api.live().then(setLive).catch(() => {})
    const close = openSocket((m) => {
      if (m.type === 'live') setLive(m.data)
      if (m.type === 'event') { setLive((l) => l ? { ...l, events: [m.data, ...l.events].slice(0, 100) } : l); notify(`${m.data.kind}: ${m.data.note || ''}`) }
    })
    const poll = setInterval(() => { api.live().then(setLive).catch(() => {}); tick((x) => x + 1) }, 10000)
    return () => { close(); clearInterval(poll) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function cmd(c) {
    setBusy(c)
    let pw = sessionStorage.getItem('dash_pw') || ''
    try {
      const cfg = await api.settings()
      if (cfg.dashboard_password_required && !pw) { pw = prompt('Dashboard password') || ''; sessionStorage.setItem('dash_pw', pw) }
    } catch {}
    try { await api.command(c, pw); notify(`Command "${c}" queued — EA picks it up on next heartbeat`) } catch (e) { if (String(e.message).includes('password')) sessionStorage.removeItem('dash_pw'); notify('Error: ' + e.message) } finally { setBusy('') }
  }

  const acc = live?.account || {}
  const st = live?.state || {}
  const sum = live?.summary || {}
  const connected = live?.connected

  return (
    <>
      <div className="topbar">
        <div>
          <h2>Live Dashboard</h2>
          <p>Real-time feed from the MetaTrader 5 Expert Advisor via the REST bridge.</p>
        </div>
        <div className="btn-group">
          <span className="badge badge-gray" style={{ padding: '8px 12px' }}>
            <span className={`dot ${connected ? 'on' : 'off'}`} /> {connected ? `EA connected · ${live.symbol}` : 'EA offline'} · heartbeat {fmt.ago(live?.last_heartbeat)}
          </span>
          {live?.paused
            ? <button className="btn btn-success" disabled={!!busy} onClick={() => cmd('resume')}>▶ Resume trading</button>
            : <button className="btn" disabled={!!busy} onClick={() => cmd('pause')}>❚❚ Pause trading</button>}
          <button className="btn btn-danger" disabled={!!busy} onClick={() => { if (confirm('Close ALL open positions on the EA?')) cmd('close_all') }}>Close all</button>
        </div>
      </div>

      {!connected && (
        <div className="alert alert-warn" style={{ marginBottom: 16 }}>
          <b>Waiting for MetaTrader 5.</b> {live?.last_heartbeat ? 'No heartbeat in the last 90 s.' : 'No terminal has connected yet — all values below stay empty until the EA sends data.'}{' '}
          Attach <b>SweepCISD_Bridge.mq5</b> to an XAUUSD chart, allow WebRequest for <code>{location.origin}</code>, set the same <code>BridgeToken</code>. Full steps on the <b>Setup</b> page. You can use the <b>Backtester</b> meanwhile.
        </div>
      )}
      {live?.pending_command && live.pending_command !== 'none' && (
        <div className="alert alert-info" style={{ marginBottom: 16 }}>Pending command for EA: <b>{live.pending_command}</b></div>
      )}

      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <Stat label="Balance" value={fmt.money(acc.balance)} sub={acc.currency ? `${acc.currency} · ${acc.server || ''}` : '—'} />
        <Stat label="Equity" value={fmt.money(acc.equity)} sub={`Margin free ${fmt.money(acc.margin_free)}`} />
        <Stat label="Floating P&L" value={connected ? fmt.money(sum.floating_pnl) : '—'} cls={sum.floating_pnl > 0 ? 'pos' : sum.floating_pnl < 0 ? 'neg' : ''} sub={`${sum.open_positions || 0} open position(s)`} />
        <Stat label="Realized P&L" value={connected || sum.closed_trades ? fmt.money(sum.realized_pnl) : '—'} cls={sum.realized_pnl > 0 ? 'pos' : sum.realized_pnl < 0 ? 'neg' : ''} sub={`${sum.closed_trades || 0} closed · ${fmt.pct(sum.win_rate)} win rate`} />
      </div>

      <div className="grid grid-3" style={{ marginBottom: 16 }}>
        <div className="card">
          <div className="card-title"><h3>Market</h3><span className="badge badge-blue">{live?.symbol || '—'}</span></div>
          <div className="kv">
            <span className="k">Bid</span><span className="v mono">{live?.bid ? fmt.num(live.bid) : '—'}</span>
            <span className="k">Ask</span><span className="v mono">{live?.ask ? fmt.num(live.ask) : '—'}</span>
            <span className="k">Spread</span><span className="v mono">{live?.bid && live?.ask ? fmt.num(live.ask - live.bid) : '—'}</span>
            <span className="k">Broker time</span><span className="v">{live?.server_time || '—'}</span>
            <span className="k">Prev H1 high</span><span className="v mono">{fmt.num(st.prev_h1_high)}</span>
            <span className="k">Prev H1 low</span><span className="v mono">{fmt.num(st.prev_h1_low)}</span>
          </div>
        </div>
        <div className="card">
          <div className="card-title"><h3>Strategy state</h3>
            {st.waiting_for_cisd
              ? <span className={`badge ${st.sweep_direction === 'BULL' ? 'badge-green' : 'badge-red'}`}>{st.sweep_direction === 'BULL' ? 'Bullish' : 'Bearish'} sweep · waiting CISD</span>
              : <span className="badge badge-gray">{live?.paused ? 'Paused' : 'Scanning for sweep'}</span>}
          </div>
          <div className="kv">
            <span className="k">Sweep level</span><span className="v mono">{st.sweep_level ? fmt.num(st.sweep_level) : '—'}</span>
            <span className="k">Sweep extreme</span><span className="v mono">{st.sweep_extreme ? fmt.num(st.sweep_extreme) : '—'}</span>
            <span className="k">Candles since sweep</span><span className="v">{st.waiting_for_cisd ? `${st.candles_after_sweep} / ${st.max_cisd_candles ?? 4}` : '—'}</span>
            <span className="k">Risk / trade</span><span className="v">{st.risk_per_trade != null ? fmt.money(st.risk_per_trade) : '—'}</span>
            <span className="k">R : R</span><span className="v">{st.risk_reward ?? '—'}</span>
            <span className="k">Today P&L / trades</span><span className={`v ${st.daily_pnl > 0 ? 'pos' : st.daily_pnl < 0 ? 'neg' : ''}`}>{st.daily_pnl != null ? `${fmt.money(st.daily_pnl)} · ${st.daily_trades ?? 0}` : '—'}{st.daily_locked && <span className="badge badge-red" style={{ marginLeft: 6 }}>DAILY LOCK</span>}</span>
            <span className="k">Magic</span><span className="v mono">{st.magic ?? '—'}</span>
          </div>
        </div>
        <div className="card">
          <div className="card-title"><h3>Account</h3></div>
          <div className="kv">
            <span className="k">Login</span><span className="v mono">{acc.login ?? '—'}</span>
            <span className="k">Name</span><span className="v">{acc.name ?? '—'}</span>
            <span className="k">Leverage</span><span className="v">{acc.leverage ? `1:${acc.leverage}` : '—'}</span>
            <span className="k">Margin used</span><span className="v">{fmt.money(acc.margin)}</span>
            <span className="k">Profit</span><span className={`v ${acc.profit > 0 ? 'pos' : acc.profit < 0 ? 'neg' : ''}`}>{fmt.money(acc.profit)}</span>
            <span className="k">Mode</span><span className="v">{acc.trade_mode ?? '—'}</span>
          </div>
        </div>
      </div>

      <div className="grid grid-2">
        <div className="card">
          <div className="card-title"><h3>Open positions</h3><span className="badge badge-gray">{live?.positions?.length || 0}</span></div>
          {!live?.positions?.length ? <div className="empty">No open positions.</div> : (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Ticket</th><th>Side</th><th>Lots</th><th>Open</th><th>SL</th><th>TP</th><th>Current</th><th>P&L</th></tr></thead>
                <tbody>{live.positions.map((p) => (
                  <tr key={p.ticket}>
                    <td className="mono">{p.ticket}</td>
                    <td><span className={`badge ${p.type === 'BUY' ? 'badge-green' : 'badge-red'}`}>{p.type}</span></td>
                    <td>{p.volume}</td><td className="mono">{p.price_open}</td><td className="mono">{p.sl}</td><td className="mono">{p.tp}</td><td className="mono">{p.price_current}</td>
                    <td className={p.profit >= 0 ? 'pos' : 'neg'}>{fmt.money(p.profit)}</td>
                  </tr>))}</tbody>
              </table>
            </div>
          )}
          <div className="card-title" style={{ marginTop: 18 }}><h3>Recent closed trades</h3><span className="badge badge-gray">{live?.history?.length || 0}</span></div>
          {!live?.history?.length ? <div className="empty">No closed trades reported yet.</div> : (
            <div className="table-wrap" style={{ maxHeight: 260 }}>
              <table>
                <thead><tr><th>Time</th><th>Side</th><th>Lots</th><th>Price</th><th>Reason</th><th>P&L</th></tr></thead>
                <tbody>{live.history.slice(0, 50).map((h, i) => (
                  <tr key={h.deal || i}>
                    <td>{h.time}</td>
                    <td><span className={`badge ${h.type === 'BUY' ? 'badge-green' : 'badge-red'}`}>{h.type}</span></td>
                    <td>{h.volume}</td><td className="mono">{h.price}</td><td>{h.reason}</td>
                    <td className={h.profit >= 0 ? 'pos' : 'neg'}>{fmt.money(h.profit)}</td>
                  </tr>))}</tbody>
              </table>
            </div>
          )}
        </div>
        <div className="card">
          <div className="card-title"><h3>Event log</h3>
            <button className="btn btn-sm" onClick={() => api.clearEvents().then(() => api.live().then(setLive))}>Clear</button></div>
          {!live?.events?.length ? <div className="empty">Sweeps, CISD confirmations, orders and errors from the EA will appear here.</div> : (
            <div className="table-wrap" style={{ maxHeight: 620 }}>
              <table>
                <thead><tr><th>Time</th><th>Type</th><th>Price</th><th>Detail</th></tr></thead>
                <tbody>{live.events.map((e, i) => (
                  <tr key={i}>
                    <td>{fmt.time(e.time + 'Z')}</td>
                    <td><span className={`badge ${kindBadge(e.kind)}`}>{e.kind}</span></td>
                    <td className="mono">{e.price ? fmt.num(e.price) : '—'}</td><td>{e.note}</td>
                  </tr>))}</tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </>
  )
}
