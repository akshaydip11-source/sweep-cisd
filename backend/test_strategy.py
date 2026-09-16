from datetime import datetime, timedelta
from strategy import Candle, Settings, SweepCISDStrategy, run_backtest, calculate_volume
from data import generate_synthetic, parse_csv

T0 = datetime(2026, 1, 5, 0, 0)

def flat_hour(st, t, o=105, h=110, l=100, c=105):
    for i in range(12):
        st.on_m5_close(Candle(t + timedelta(minutes=5 * i), o, h, l, c))

def test_bullish_sweep_then_cisd_buy():
    st = SweepCISDStrategy(Settings(spread_points=0))
    flat_hour(st, T0)
    t1 = T0 + timedelta(hours=1)
    st.on_m5_close(Candle(t1, 102, 103, 99, 101))          # sweep of H1 low 100
    assert st.sweep_direction == "BULL" and st.sweep_extreme == 99
    st.on_m5_close(Candle(t1 + timedelta(minutes=5), 101, 101.5, 100.5, 100.8))   # bearish, open 101
    st.on_m5_close(Candle(t1 + timedelta(minutes=10), 100.8, 102, 100.7, 101.5))  # closes > 101 -> CISD
    assert len(st.trades) == 1 and st.trades[0].direction == "BUY"
    tr = st.trades[0]
    assert tr.sl == round(99 - 0.10, 2) and abs((tr.tp - tr.entry_price) - (tr.entry_price - tr.sl)) < 1e-9

def test_bearish_sweep_then_cisd_sell():
    st = SweepCISDStrategy(Settings(spread_points=0))
    flat_hour(st, T0)
    t1 = T0 + timedelta(hours=1)
    st.on_m5_close(Candle(t1, 108, 111, 107, 109))          # sweep of H1 high 110
    assert st.sweep_direction == "BEAR"
    st.on_m5_close(Candle(t1 + timedelta(minutes=5), 109, 109.5, 108.5, 109.2))   # bullish, open 109
    st.on_m5_close(Candle(t1 + timedelta(minutes=10), 109.2, 109.3, 108, 108.5))  # closes < 109 -> CISD
    assert len(st.trades) == 1 and st.trades[0].direction == "SELL"

def test_cisd_window_expires():
    st = SweepCISDStrategy(Settings(max_cisd_candles=2))
    flat_hour(st, T0)
    t1 = T0 + timedelta(hours=1)
    st.on_m5_close(Candle(t1, 102, 103, 99, 101))
    for i in range(1, 4):
        st.on_m5_close(Candle(t1 + timedelta(minutes=5 * i), 101, 101.2, 100.8, 100.9))
    assert not st.waiting_for_cisd and any(s.kind == "EXPIRED" for s in st.signals) and not st.trades

def test_reset_on_new_h1():
    st = SweepCISDStrategy(Settings())
    flat_hour(st, T0)
    t1 = T0 + timedelta(hours=1)
    for i in range(11):
        st.on_m5_close(Candle(t1 + timedelta(minutes=5 * i), 105, 106, 104, 105))
    st.on_m5_close(Candle(t1 + timedelta(minutes=55), 102, 103, 99, 101))   # sweep at last candle of hour
    assert st.waiting_for_cisd
    st.on_m5_close(Candle(t1 + timedelta(hours=1), 101, 102, 100.5, 101.8))  # new H1 -> reset
    assert not st.waiting_for_cisd

def test_volume_sizing():
    s = Settings()
    assert calculate_volume(2650.0, 2647.5, s) == 0.10   # $25 / (2.5*100)

def test_backtest_and_csv_roundtrip():
    c = generate_synthetic(days=5, seed=1)
    r = run_backtest(c, Settings())
    assert r["stats"]["total_trades"] > 0 and len(r["equity"]) >= 1
    csv = "time,open,high,low,close\n" + "\n".join(f"{x.time.isoformat()},{x.open},{x.high},{x.low},{x.close}" for x in c)
    assert len(parse_csv(csv.encode())) == len(c)
