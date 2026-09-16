"""Market data sources: synthetic XAUUSD generator, CSV parsing (MT5 export format), Twelve Data API."""
from __future__ import annotations

import csv
import io
import math
import os
import random
from datetime import datetime, timedelta
from typing import List, Optional

import httpx

from strategy import Candle


def generate_synthetic(symbol: str = "XAUUSD", days: int = 10, start_price: float = 2650.0,
                       seed: Optional[int] = None) -> List[Candle]:
    """Realistic-looking M5 gold data: intraday volatility cycle, trends, and occasional liquidity wicks."""
    rng = random.Random(seed if seed is not None else 42)
    end = datetime.utcnow().replace(second=0, microsecond=0)
    end -= timedelta(minutes=end.minute % 5)
    start = end - timedelta(days=days)
    start = start.replace(minute=0)
    candles: List[Candle] = []
    price = start_price
    t = start
    drift = 0.0
    while t < end:
        if t.weekday() >= 5:            # skip weekends
            t += timedelta(minutes=5)
            continue
        hour = t.hour
        # session volatility: London/NY overlap busiest
        vol_mult = 0.55 + 0.9 * math.exp(-((hour - 14) ** 2) / 18) + 0.4 * math.exp(-((hour - 8) ** 2) / 10)
        base_vol = 1.1 * vol_mult
        if rng.random() < 0.02:
            drift = rng.uniform(-0.35, 0.35)
        drift *= 0.995
        o = price
        c = o + drift + rng.gauss(0, base_vol)
        wick_up = abs(rng.gauss(0, base_vol * 0.6))
        wick_dn = abs(rng.gauss(0, base_vol * 0.6))
        if rng.random() < 0.04:          # liquidity spike
            if rng.random() < 0.5:
                wick_up += base_vol * rng.uniform(2, 4)
            else:
                wick_dn += base_vol * rng.uniform(2, 4)
        h = max(o, c) + wick_up
        l = min(o, c) - wick_dn
        candles.append(Candle(t, round(o, 2), round(h, 2), round(l, 2), round(c, 2), rng.randint(50, 900)))
        price = c
        t += timedelta(minutes=5)
    return candles


def parse_csv(content: bytes) -> List[Candle]:
    """
    Accepts:
      - MT5 export:  <DATE>\t<TIME>\t<OPEN>\t<HIGH>\t<LOW>\t<CLOSE>\t<TICKVOL>\t<VOL>\t<SPREAD>
      - Generic:     time,open,high,low,close[,volume]   (time ISO or 'YYYY.MM.DD HH:MM')
    """
    text = content.decode("utf-8-sig", errors="ignore")
    sample = text[:2048]
    delim = "\t" if sample.count("\t") > sample.count(",") else ","
    reader = csv.reader(io.StringIO(text), delimiter=delim)
    out: List[Candle] = []
    header = None
    for row in reader:
        if not row or all(not x.strip() for x in row):
            continue
        if header is None:
            header = [h.strip().strip("<>").lower() for h in row]
            # if first row is not a header, fall back to positional parsing
            if any(h in ("open", "high", "low", "close") for h in header):
                continue
            header = None
            row_dict = None
        cols = [x.strip() for x in row]
        try:
            if header and "date" in header and "time" in header:
                ts = datetime.strptime(cols[header.index("date")] + " " + cols[header.index("time")], "%Y.%m.%d %H:%M:%S")
                o, h, l, c = (float(cols[header.index(k)]) for k in ("open", "high", "low", "close"))
                v = float(cols[header.index("tickvol")]) if "tickvol" in header else 0.0
            elif header:
                tcol = header.index("time") if "time" in header else header.index("datetime") if "datetime" in header else 0
                ts = _parse_time(cols[tcol])
                o, h, l, c = (float(cols[header.index(k)]) for k in ("open", "high", "low", "close"))
                v = float(cols[header.index("volume")]) if "volume" in header else 0.0
            else:
                ts = _parse_time(cols[0])
                o, h, l, c = map(float, cols[1:5])
                v = float(cols[5]) if len(cols) > 5 else 0.0
        except Exception:
            continue
        out.append(Candle(ts, o, h, l, c, v))
    out.sort(key=lambda x: x.time)
    return out


def _parse_time(s: str) -> datetime:
    for fmt in ("%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y.%m.%d %H:%M:%S", "%Y.%m.%d %H:%M"):
        try:
            return datetime.strptime(s, fmt)
        except ValueError:
            pass
    if s.isdigit():
        return datetime.utcfromtimestamp(int(s))
    return datetime.fromisoformat(s)


async def fetch_twelvedata(symbol: str, api_key: str, outputsize: int = 5000) -> List[Candle]:
    """Live market data from Twelve Data (free tier works for XAU/USD 5min)."""
    sym = symbol
    if symbol.upper() == "XAUUSD":
        sym = "XAU/USD"
    elif len(symbol) == 6 and "/" not in symbol:
        sym = symbol[:3] + "/" + symbol[3:]
    url = "https://api.twelvedata.com/time_series"
    params = {"symbol": sym, "interval": "5min", "outputsize": outputsize, "apikey": api_key, "format": "JSON"}
    async with httpx.AsyncClient(timeout=30) as client:
        r = await client.get(url, params=params)
        r.raise_for_status()
        j = r.json()
    if j.get("status") == "error":
        raise RuntimeError(j.get("message", "Twelve Data error"))
    values = j.get("values", [])
    out = [Candle(datetime.strptime(v["datetime"], "%Y-%m-%d %H:%M:%S"),
                  float(v["open"]), float(v["high"]), float(v["low"]), float(v["close"]),
                  float(v.get("volume", 0) or 0)) for v in values]
    out.sort(key=lambda x: x.time)
    return out
