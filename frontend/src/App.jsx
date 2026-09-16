import { useEffect, useState } from 'react'
import Backtest from './components/Backtest'
import Live from './components/Live'
import Setup from './components/Setup'
import { api } from './lib/api'

const Icon = {
  live: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 12h4l3-8 4 16 3-8h4" /></svg>,
  backtest: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 19V5M4 19h16M8 15l4-6 4 3 4-7" /></svg>,
  setup: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></svg>,
}

export default function App() {
  const [page, setPage] = useState(() => location.hash.replace('#', '') || 'live')
  const [toast, setToast] = useState('')
  const [apiOk, setApiOk] = useState(null)

  useEffect(() => { location.hash = page }, [page])
  useEffect(() => {
    const check = () => api.health().then(() => setApiOk(true)).catch(() => setApiOk(false))
    check(); const id = setInterval(check, 15000); return () => clearInterval(id)
  }, [])

  const notify = (msg) => { setToast(msg); clearTimeout(window.__t); window.__t = setTimeout(() => setToast(''), 4000) }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-logo">SC</div>
          <div><h1>Sweep + CISD</h1><small>XAUUSD automation</small></div>
        </div>
        <button className={`nav-item ${page === 'live' ? 'active' : ''}`} onClick={() => setPage('live')}>{Icon.live} Live dashboard</button>
        <button className={`nav-item ${page === 'backtest' ? 'active' : ''}`} onClick={() => setPage('backtest')}>{Icon.backtest} Backtester</button>
        <button className={`nav-item ${page === 'setup' ? 'active' : ''}`} onClick={() => setPage('setup')}>{Icon.setup} Setup & docs</button>
        <div className="sidebar-footer">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><span className={`dot ${apiOk ? 'on' : 'off'}`} /> Backend {apiOk == null ? 'checking…' : apiOk ? 'online' : 'offline'}</div>
          <div style={{ marginTop: 6 }}>v1.0 · MT5 / MQL5 bridge</div>
        </div>
      </aside>
      <main className="main">
        {apiOk === false && <div className="alert alert-error" style={{ marginBottom: 16 }}>Cannot reach backend API. Start it with <code>uvicorn main:app --port 8000</code> in <code>backend/</code>.</div>}
        {page === 'live' && <Live notify={notify} />}
        {page === 'backtest' && <Backtest notify={notify} />}
        {page === 'setup' && <Setup />}
      </main>
      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}
