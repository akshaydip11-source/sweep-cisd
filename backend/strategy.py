"""
Exact Python port of the MQL5 "H1 Liquidity Sweep + M5 CISD" Expert Advisor.

Logic (per closed M5 candle):
  1. Reset the sweep state when a new H1 candle begins.
  2. Bullish sweep:  M5 low < previous H1 low  AND M5 close > previous H1 low.
     Bearish sweep:  M5 high > previous H1 high AND M5 close < previous H1 high.
  3. After a sweep, wait up to MaxCISDCandles closed M5 candles for a CISD:
       Bullish CISD: bullish candle closing above the OPEN of the most recent bearish candle.
       Bearish CISD: bearish candle closing below the OPEN of the most recent bullish candle.
  4. Entry at market, SL beyond sweep extreme +/- buffer, TP = risk * RR.
  5. Position size = RiskPerTrade / (risk distance * value per lot).
"""
from __future__ import annotations

from dataclasses import dataclass, field, asdict
from datetime import datetime, timedelta
from typing import List, Optional, Dict, Any
import math


@dataclass
class Candle:
    time: datetime
    open: float
    high: float
    low: float
    close: float
    volume: float = 0.0


@dataclass
class Settings:
    risk_per_trade: float = 25.0
    risk_reward: float = 1.0
    max_cisd_candles: int = 4
    sl_buffer_points: int = 10
    point: float = 0.01              # XAUUSD point size
    contract_size: float = 100.0     # XAUUSD: 100 oz per lot
    volume_min: float = 0.01
    volume_max: float = 100.0
    volume_step: float = 0.01
    spread_points: int = 20          # simulated spread (points)
    one_position_only: bool = True
    initial_balance: float = 10000.0
    symbol: str = "XAUUSD"


@dataclass
class Trade:
    id: int
    direction: str            # "BUY" / "SELL"
    entry_time: datetime
    entry_price: float
    sl: float
    tp: float
    volume: float
    risk: float
    sweep_level: float
    sweep_extreme: float
    exit_time: Optional[datetime] = None
    exit_price: Optional[float] = None
    result: Optional[str] = None      # "TP" / "SL" / "OPEN" / "END"
    pnl: float = 0.0

    def to_dict(self) -> Dict[str, Any]:
        d = asdict(self)
        d["entry_time"] = self.entry_time.isoformat()
        d["exit_time"] = self.exit_time.isoformat() if self.exit_time else None
        return d


@dataclass
class Signal:
    time: datetime
    kind: str          # "SWEEP_BULL", "SWEEP_BEAR", "CISD_BULL", "CISD_BEAR", "EXPIRED"
    price: float
    note: str = ""

    def to_dict(self):
        return {"time": self.time.isoformat(), "kind": self.kind, "price": self.price, "note": self.note}


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------

def h1_bucket(t: datetime) -> datetime:
    return t.replace(minute=0, second=0, microsecond=0)


def normalize_volume(volume: float, s: Settings) -> float:
    if volume < s.volume_min:
        volume = s.volume_min
    if volume > s.volume_max:
        volume = s.volume_max
    volume = math.floor(volume / s.volume_step + 1e-9) * s.volume_step
    digits = 2
    if s.volume_step == 1.0:
        digits = 0
    elif s.volume_step == 0.1:
        digits = 1
    elif s.volume_step == 0.001:
        digits = 3
    return round(volume, digits)


def calculate_volume(entry: float, sl: float, s: Settings) -> float:
    """Mirror of OrderCalcProfit-based sizing: risk for 1 lot = |entry-sl| * contract_size."""
    risk_one_lot = abs(entry - sl) * s.contract_size
    if risk_one_lot <= 0:
        return 0.0
    return normalize_volume(s.risk_per_trade / risk_one_lot, s)


# --------------------------------------------------------------------------
# Strategy engine (stateful, candle-by-candle, identical to the EA)
# --------------------------------------------------------------------------

class SweepCISDStrategy:
    def __init__(self, settings: Settings):
        self.s = settings
        self.m5: List[Candle] = []          # closed M5 candles
        self.h1: List[Candle] = []          # completed H1 candles (built from M5)
        self._h1_building: Optional[Candle] = None
        self.reset_setup()
        self.sweep_h1_time: Optional[datetime] = None

        self.trades: List[Trade] = []
        self.signals: List[Signal] = []
        self.balance = settings.initial_balance
        self.equity_curve: List[Dict[str, Any]] = [
        ]
        self._trade_id = 0

    # ---- state -----------------------------------------------------------
    def reset_setup(self):
        self.sweep_direction = None      # "BULL" / "BEAR"
        self.sweep_detected = False
        self.waiting_for_cisd = False
        self.sweep_time = None
        self.sweep_level = 0.0
        self.sweep_extreme = 0.0
        self.candles_after_sweep = 0

    @property
    def open_trade(self) -> Optional[Trade]:
        for t in reversed(self.trades):
            if t.result == "OPEN":
                return t
        return None

    def state(self) -> Dict[str, Any]:
        return {
            "sweep_direction": self.sweep_direction,
            "waiting_for_cisd": self.waiting_for_cisd,
            "sweep_level": self.sweep_level,
            "sweep_extreme": self.sweep_extreme,
            "candles_after_sweep": self.candles_after_sweep,
            "sweep_time": self.sweep_time.isoformat() if self.sweep_time else None,
            "prev_h1_high": self.h1[-1].high if self.h1 else None,
            "prev_h1_low": self.h1[-1].low if self.h1 else None,
        }

    # ---- H1 aggregation --------------------------------------------------
    def _update_h1(self, c: Candle):
        b = h1_bucket(c.time)
        if self._h1_building is None or self._h1_building.time != b:
            if self._h1_building is not None:
                self.h1.append(self._h1_building)
            self._h1_building = Candle(b, c.open, c.high, c.low, c.close, c.volume)
        else:
            hb = self._h1_building
            hb.high = max(hb.high, c.high)
            hb.low = min(hb.low, c.low)
            hb.close = c.close
            hb.volume += c.volume

    # ---- open-position management (SL/TP fill simulation) ---------------
    def _manage_open(self, c: Candle):
        t = self.open_trade
        if t is None:
            return
        spread = self.s.spread_points * self.s.point
        if t.direction == "BUY":
            # exit at bid
            bid_low, bid_high = c.low, c.high
            hit_sl = bid_low <= t.sl
            hit_tp = bid_high >= t.tp
            if hit_sl and hit_tp:
                # conservative: SL first
                hit_tp = False
            if hit_sl:
                self._close(t, c.time, t.sl, "SL")
            elif hit_tp:
                self._close(t, c.time, t.tp, "TP")
        else:
            ask_low, ask_high = c.low + spread, c.high + spread
            hit_sl = ask_high >= t.sl
            hit_tp = ask_low <= t.tp
            if hit_sl and hit_tp:
                hit_tp = False
            if hit_sl:
                self._close(t, c.time, t.sl, "SL")
            elif hit_tp:
                self._close(t, c.time, t.tp, "TP")

    def _close(self, t: Trade, time: datetime, price: float, result: str):
        t.exit_time = time
        t.exit_price = price
        t.result = result
        diff = (price - t.entry_price) if t.direction == "BUY" else (t.entry_price - price)
        t.pnl = round(diff * self.s.contract_size * t.volume, 2)
        self.balance = round(self.balance + t.pnl, 2)
        self.equity_curve.append({"time": time.isoformat(), "balance": self.balance})

    # ---- main entry point: feed one CLOSED M5 candle --------------------
    def on_m5_close(self, c: Candle):
        self._manage_open(c)
        self.m5.append(c)
        self._update_h1(c)

        # need at least one completed H1 candle (the EA reads iHigh(H1,1))
        if not self.h1:
            return
        if self.s.one_position_only and self.open_trade is not None:
            return

        prev_h1 = self.h1[-1]
        current_h1_time = h1_bucket(c.time)

        # 3. reset sweep when new H1 candle starts
        if self.sweep_h1_time != current_h1_time:
            self.reset_setup()
            self.sweep_h1_time = current_h1_time

        # 4. detect sweep
        if not self.sweep_detected:
            if c.low < prev_h1.low and c.close > prev_h1.low:
                self._set_sweep("BULL", c, prev_h1.low, c.low)
                return
            if c.high > prev_h1.high and c.close < prev_h1.high:
                self._set_sweep("BEAR", c, prev_h1.high, c.high)
                return

        # 5. CISD processing
        if self.waiting_for_cisd:
            self.candles_after_sweep += 1
            if self.sweep_direction == "BULL" and c.low < self.sweep_extreme:
                self.sweep_extreme = c.low
            if self.sweep_direction == "BEAR" and c.high > self.sweep_extreme:
                self.sweep_extreme = c.high

            if self.candles_after_sweep > self.s.max_cisd_candles:
                self.signals.append(Signal(c.time, "EXPIRED", c.close, "CISD window expired"))
                self.reset_setup()
                return

            spread = self.s.spread_points * self.s.point
            if self.sweep_direction == "BULL" and self._is_bullish_cisd():
                entry = c.close + spread            # ask
                sl = self.sweep_extreme - self.s.sl_buffer_points * self.s.point
                risk = entry - sl
                if risk > 0:
                    tp = entry + risk * self.s.risk_reward
                    vol = calculate_volume(entry, sl, self.s)
                    if vol > 0:
                        self._open("BUY", c, entry, sl, tp, vol)
                self.reset_setup()
                return

            if self.sweep_direction == "BEAR" and self._is_bearish_cisd():
                entry = c.close                      # bid
                sl = self.sweep_extreme + self.s.sl_buffer_points * self.s.point
                risk = sl - entry
                if risk > 0:
                    tp = entry - risk * self.s.risk_reward
                    vol = calculate_volume(entry, sl, self.s)
                    if vol > 0:
                        self._open("SELL", c, entry, sl, tp, vol)
                self.reset_setup()
                return

    def _set_sweep(self, direction: str, c: Candle, level: float, extreme: float):
        self.sweep_direction = direction
        self.sweep_detected = True
        self.waiting_for_cisd = True
        self.sweep_time = c.time
        self.sweep_level = level
        self.sweep_extreme = extreme
        self.candles_after_sweep = 0
        self.signals.append(Signal(c.time, f"SWEEP_{direction}", level,
                                   f"{'Bullish' if direction=='BULL' else 'Bearish'} sweep of prev H1 "
                                   f"{'low' if direction=='BULL' else 'high'} @ {level:.2f}"))

    def _open(self, direction: str, c: Candle, entry, sl, tp, vol):
        self._trade_id += 1
        t = Trade(self._trade_id, direction, c.time, round(entry, 2), round(sl, 2), round(tp, 2),
                  vol, self.s.risk_per_trade, self.sweep_level, self.sweep_extreme, result="OPEN")
        self.trades.append(t)
        self.signals.append(Signal(c.time, f"CISD_{'BULL' if direction=='BUY' else 'BEAR'}", entry,
                                   f"{direction} @ {entry:.2f} SL {sl:.2f} TP {tp:.2f} vol {vol}"))

    # ---- CISD detectors (identical to IsBullishCISD / IsBearishCISD) -----
    def _is_bullish_cisd(self) -> bool:
        cur = self.m5[-1]
        if cur.close <= cur.open:
            return False
        for i in range(2, 11):
            if len(self.m5) < i:
                break
            prev = self.m5[-i]
            if prev.close < prev.open:
                return cur.close > prev.open
        return False

    def _is_bearish_cisd(self) -> bool:
        cur = self.m5[-1]
        if cur.close >= cur.open:
            return False
        for i in range(2, 11):
            if len(self.m5) < i:
                break
            prev = self.m5[-i]
            if prev.close > prev.open:
                return cur.close < prev.open
        return False

    # ---- finishing -------------------------------------------------------
    def close_all_at_end(self):
        t = self.open_trade
        if t and self.m5:
            self._close(t, self.m5[-1].time, self.m5[-1].close, "END")


# --------------------------------------------------------------------------
# Backtest runner + statistics
# --------------------------------------------------------------------------

def run_backtest(candles: List[Candle], settings: Settings) -> Dict[str, Any]:
    strat = SweepCISDStrategy(settings)
    strat.equity_curve.append({"time": candles[0].time.isoformat() if candles else datetime.utcnow().isoformat(),
                               "balance": settings.initial_balance})
    for c in candles:
        strat.on_m5_close(c)
    strat.close_all_at_end()
    return {
        "stats": compute_stats(strat.trades, settings.initial_balance, strat.equity_curve),
        "trades": [t.to_dict() for t in strat.trades],
        "signals": [s.to_dict() for s in strat.signals],
        "equity": strat.equity_curve,
        "candles": [{"time": int(c.time.timestamp()), "open": c.open, "high": c.high, "low": c.low, "close": c.close}
                    for c in candles],
        "settings": asdict(settings),
    }


def compute_stats(trades: List[Trade], initial: float, equity: List[Dict[str, Any]]) -> Dict[str, Any]:
    closed = [t for t in trades if t.result in ("TP", "SL", "END")]
    wins = [t for t in closed if t.pnl > 0]
    losses = [t for t in closed if t.pnl <= 0]
    gross_win = sum(t.pnl for t in wins)
    gross_loss = abs(sum(t.pnl for t in losses))
    net = round(gross_win - gross_loss, 2)
    peak, max_dd = initial, 0.0
    for p in equity:
        peak = max(peak, p["balance"])
        max_dd = max(max_dd, peak - p["balance"])
    # streaks
    best_streak = worst_streak = cur = 0
    for t in closed:
        if t.pnl > 0:
            cur = cur + 1 if cur > 0 else 1
            best_streak = max(best_streak, cur)
        else:
            cur = cur - 1 if cur < 0 else -1
            worst_streak = min(worst_streak, cur)
    return {
        "total_trades": len(closed),
        "wins": len(wins),
        "losses": len(losses),
        "win_rate": round(len(wins) / len(closed) * 100, 2) if closed else 0.0,
        "net_profit": net,
        "gross_profit": round(gross_win, 2),
        "gross_loss": round(gross_loss, 2),
        "profit_factor": round(gross_win / gross_loss, 2) if gross_loss > 0 else (999.0 if gross_win > 0 else 0.0),
        "avg_win": round(gross_win / len(wins), 2) if wins else 0.0,
        "avg_loss": round(-gross_loss / len(losses), 2) if losses else 0.0,
        "expectancy": round(net / len(closed), 2) if closed else 0.0,
        "max_drawdown": round(max_dd, 2),
        "max_drawdown_pct": round(max_dd / initial * 100, 2) if initial else 0.0,
        "return_pct": round(net / initial * 100, 2) if initial else 0.0,
        "final_balance": round(initial + net, 2),
        "best_streak": best_streak,
        "worst_streak": abs(worst_streak),
        "buys": len([t for t in closed if t.direction == "BUY"]),
        "sells": len([t for t in closed if t.direction == "SELL"]),
    }
