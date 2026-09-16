import { useEffect, useRef } from 'react'
import { createChart, CandlestickSeries, LineSeries, AreaSeries, createSeriesMarkers } from 'lightweight-charts'

const theme = {
  layout: { background: { color: 'transparent' }, textColor: '#8b94a7', fontFamily: 'Inter, system-ui, sans-serif' },
  grid: { vertLines: { color: 'rgba(255,255,255,0.04)' }, horzLines: { color: 'rgba(255,255,255,0.04)' } },
  rightPriceScale: { borderColor: '#242b38' },
  timeScale: { borderColor: '#242b38', timeVisible: true, secondsVisible: false },
  crosshair: { vertLine: { color: '#4f8cff55' }, horzLine: { color: '#4f8cff55' } },
}

function useChart(ref, build, deps) {
  useEffect(() => {
    if (!ref.current) return
    const chart = createChart(ref.current, { ...theme, autoSize: true })
    build(chart)
    return () => chart.remove()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
}

export function PriceChart({ candles = [], trades = [], signals = [], className = 'chart' }) {
  const ref = useRef(null)
  useChart(ref, (chart) => {
    const s = chart.addSeries(CandlestickSeries, {
      upColor: '#22c55e', downColor: '#ef4444', borderVisible: false, wickUpColor: '#22c55e', wickDownColor: '#ef4444',
      priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
    })
    s.setData(candles)
    const markers = []
    for (const sg of signals) {
      const t = Math.floor(new Date(sg.time + 'Z').getTime() / 1000)
      if (sg.kind === 'SWEEP_BULL') markers.push({ time: t, position: 'belowBar', color: '#f59e0b', shape: 'circle', size: 0.6 })
      if (sg.kind === 'SWEEP_BEAR') markers.push({ time: t, position: 'aboveBar', color: '#f59e0b', shape: 'circle', size: 0.6 })
    }
    for (const tr of trades) {
      const t = Math.floor(new Date(tr.entry_time + 'Z').getTime() / 1000)
      markers.push(tr.direction === 'BUY'
        ? { time: t, position: 'belowBar', color: '#22c55e', shape: 'arrowUp', text: `BUY ${tr.volume}` }
        : { time: t, position: 'aboveBar', color: '#ef4444', shape: 'arrowDown', text: `SELL ${tr.volume}` })
      if (tr.exit_time) {
        const te = Math.floor(new Date(tr.exit_time + 'Z').getTime() / 1000)
        markers.push({ time: te, position: tr.direction === 'BUY' ? 'aboveBar' : 'belowBar',
          color: tr.pnl >= 0 ? '#22c55e' : '#ef4444', shape: 'square', text: `${tr.result} ${tr.pnl >= 0 ? '+' : ''}${tr.pnl}` })
      }
    }
    markers.sort((a, b) => a.time - b.time)
    createSeriesMarkers(s, markers)
    // show last ~300 candles
    if (candles.length > 300) chart.timeScale().setVisibleLogicalRange({ from: candles.length - 300, to: candles.length + 5 })
    else chart.timeScale().fitContent()
  }, [candles, trades, signals])
  return <div ref={ref} className={className} />
}

export function EquityChart({ equity = [], initial = 10000, className = 'chart-sm' }) {
  const ref = useRef(null)
  useChart(ref, (chart) => {
    const last = equity.length ? equity[equity.length - 1].balance : initial
    const up = last >= initial
    const s = chart.addSeries(AreaSeries, {
      lineColor: up ? '#22c55e' : '#ef4444', topColor: up ? 'rgba(34,197,94,0.35)' : 'rgba(239,68,68,0.35)',
      bottomColor: 'rgba(0,0,0,0)', lineWidth: 2, priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
    })
    // de-duplicate identical timestamps (multiple closes same candle)
    const map = new Map()
    for (const p of equity) map.set(Math.floor(new Date(p.time + 'Z').getTime() / 1000), p.balance)
    s.setData([...map.entries()].sort((a, b) => a[0] - b[0]).map(([time, value]) => ({ time, value })))
    s.createPriceLine({ price: initial, color: '#8b94a7', lineWidth: 1, lineStyle: 2, title: 'start' })
    chart.timeScale().fitContent()
  }, [equity, initial])
  return <div ref={ref} className={className} />
}
