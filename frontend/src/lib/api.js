const BASE = import.meta.env.VITE_API_BASE || ''

async function req(path, opts = {}) {
  const res = await fetch(BASE + path, {
    headers: opts.body && !(opts.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {},
    ...opts,
  })
  const text = await res.text()
  let data
  try { data = text ? JSON.parse(text) : null } catch { data = { detail: text } }
  if (!res.ok) throw new Error((data && (data.detail?.[0]?.msg || data.detail)) || `HTTP ${res.status}`)
  return data
}

export const api = {
  health: () => req('/api/health'),
  settings: () => req('/api/settings'),
  backtest: (body) => req('/api/backtest', { method: 'POST', body: JSON.stringify(body) }),
  backtestUpload: (file, settings) => {
    const fd = new FormData()
    fd.append('file', file)
    fd.append('settings', JSON.stringify(settings))
    return req('/api/backtest/upload', { method: 'POST', body: fd })
  },
  lastBacktest: () => req('/api/backtest/last'),
  live: () => req('/api/live'),
  command: (command, password) => req('/api/live/command', { method: 'POST', body: JSON.stringify({ command, password }) }),
  clearEvents: () => req('/api/live/events', { method: 'DELETE' }),
}

export function openSocket(onMessage) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  const url = BASE ? BASE.replace(/^http/, 'ws') + '/ws' : `${proto}://${location.host}/ws`
  let ws, closed = false, timer
  const connect = () => {
    ws = new WebSocket(url)
    ws.onmessage = (e) => { try { onMessage(JSON.parse(e.data)) } catch {} }
    ws.onclose = () => { if (!closed) timer = setTimeout(connect, 2500) }
    ws.onerror = () => ws.close()
  }
  connect()
  return () => { closed = true; clearTimeout(timer); ws && ws.close() }
}

export const fmt = {
  money: (v, d = 2) => (v == null ? '—' : (v < 0 ? '-' : '') + '$' + Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d })),
  num: (v, d = 2) => (v == null ? '—' : Number(v).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d })),
  pct: (v) => (v == null ? '—' : Number(v).toFixed(1) + '%'),
  time: (s) => (s ? new Date(s).toLocaleString(undefined, { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'),
  ago: (s) => {
    if (!s) return 'never'
    const sec = Math.max(0, (Date.now() - new Date(s + (s.endsWith('Z') ? '' : 'Z')).getTime()) / 1000)
    if (sec < 60) return `${Math.round(sec)}s ago`
    if (sec < 3600) return `${Math.round(sec / 60)}m ago`
    return `${Math.round(sec / 3600)}h ago`
  },
}
