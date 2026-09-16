"""
FastAPI backend for the H1 Liquidity Sweep + M5 CISD trading platform.

Endpoints
  GET  /api/health
  GET  /api/settings                  default strategy settings
  POST /api/backtest                  run backtest (source: synthetic | csv | live)
  POST /api/backtest/upload           multipart CSV upload -> backtest
  GET  /api/backtest/last             last result
  --- MT5 bridge (called by the EA via WebRequest) ---
  POST /api/bridge/heartbeat          EA status + account info
  POST /api/bridge/event              sweep / cisd / trade events
  POST /api/bridge/positions          snapshot of open positions
  GET  /api/bridge/command            EA polls this (pause / resume / close_all)
  --- dashboard ---
  GET  /api/live                      everything for the live dashboard
  POST /api/live/command              set command for the EA
  GET  /api/live/events
  WS   /ws                            push updates to UI
"""
from __future__ import annotations

import asyncio
import json
import os
import time
from dataclasses import asdict
from datetime import datetime
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, File, Form, HTTPException, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from strategy import Settings, run_backtest
from data import generate_synthetic, parse_csv, fetch_twelvedata

app = FastAPI(title="Sweep + CISD Trading Platform", version="1.0.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

BRIDGE_TOKEN = os.environ.get("BRIDGE_TOKEN", "change-me")
TWELVE_KEY = os.environ.get("TWELVEDATA_API_KEY", "")
DASHBOARD_PASSWORD = os.environ.get("DASHBOARD_PASSWORD", "")   # optional: protects control endpoints
if BRIDGE_TOKEN == "change-me":
    print("WARNING: BRIDGE_TOKEN is the default value. Set BRIDGE_TOKEN env for production.")


# --------------------------------------------------------------------------
# Models
# --------------------------------------------------------------------------

class SettingsModel(BaseModel):
    risk_per_trade: float = 25.0
    risk_reward: float = 1.0
    max_cisd_candles: int = 4
    sl_buffer_points: int = 10
    point: float = 0.01
    contract_size: float = 100.0
    volume_min: float = 0.01
    volume_max: float = 100.0
    volume_step: float = 0.01
    spread_points: int = 20
    one_position_only: bool = True
    initial_balance: float = 10000.0
    symbol: str = "XAUUSD"


class BacktestRequest(BaseModel):
    source: str = Field("synthetic", pattern="^(synthetic|live|cached)$")
    days: int = 10
    seed: Optional[int] = None
    start_price: float = 2650.0
    api_key: Optional[str] = None
    settings: SettingsModel = SettingsModel()


class Heartbeat(BaseModel):
    token: str
    symbol: str
    account: Dict[str, Any] = {}
    state: Dict[str, Any] = {}
    bid: float = 0
    ask: float = 0
    server_time: Optional[str] = None


class BridgeEvent(BaseModel):
    token: str
    kind: str
    symbol: str = ""
    price: float = 0
    note: str = ""
    data: Dict[str, Any] = {}


class PositionsSnapshot(BaseModel):
    token: str
    positions: List[Dict[str, Any]] = []
    history: List[Dict[str, Any]] = []


class Command(BaseModel):
    command: str = Field(..., pattern="^(none|pause|resume|close_all)$")
    password: Optional[str] = None


def _check_dashboard(pw: Optional[str]):
    if DASHBOARD_PASSWORD and pw != DASHBOARD_PASSWORD:
        raise HTTPException(403, "dashboard password required")


# --------------------------------------------------------------------------
# In-memory state (persisted to JSON on disk)
# --------------------------------------------------------------------------

STATE_FILE = os.environ.get("STATE_FILE", os.path.join(os.path.dirname(__file__), "state.json"))

live: Dict[str, Any] = {
    "connected": False,
    "last_heartbeat": None,
    "symbol": "XAUUSD",
    "account": {},
    "state": {},
    "bid": 0, "ask": 0,
    "positions": [],
    "history": [],
    "events": [],
    "command": "none",
    "paused": False,
}
last_backtest: Optional[Dict[str, Any]] = None
cached_candles = None
ws_clients: List[WebSocket] = []


def _load():
    global live
    if os.path.exists(STATE_FILE):
        try:
            with open(STATE_FILE) as f:
                live.update(json.load(f))
        except Exception:
            pass


def _save():
    try:
        with open(STATE_FILE, "w") as f:
            json.dump(live, f)
    except Exception:
        pass


_load()


async def broadcast(msg: Dict[str, Any]):
    dead = []
    for ws in ws_clients:
        try:
            await ws.send_json(msg)
        except Exception:
            dead.append(ws)
    for d in dead:
        if d in ws_clients:
            ws_clients.remove(d)


def _check(token: str):
    if token != BRIDGE_TOKEN:
        raise HTTPException(401, "invalid bridge token")


# --------------------------------------------------------------------------
# General
# --------------------------------------------------------------------------

@app.get("/api/health")
def health():
    return {"ok": True, "time": datetime.utcnow().isoformat(), "version": app.version}


@app.get("/api/settings")
def settings():
    return {"defaults": SettingsModel().model_dump(),
            "live_data_available": bool(TWELVE_KEY),
            "bridge_token_set": BRIDGE_TOKEN != "change-me",
            "dashboard_password_required": bool(DASHBOARD_PASSWORD)}


# --------------------------------------------------------------------------
# Backtesting
# --------------------------------------------------------------------------

@app.post("/api/backtest")
async def backtest(req: BacktestRequest):
    global last_backtest, cached_candles
    s = Settings(**req.settings.model_dump())
    t0 = time.time()
    if req.source == "synthetic":
        candles = generate_synthetic(s.symbol, days=max(1, min(req.days, 120)), start_price=req.start_price, seed=req.seed)
        source_label = f"Synthetic {s.symbol} ({req.days}d, seed {req.seed if req.seed is not None else 42})"
    elif req.source == "live":
        key = req.api_key or TWELVE_KEY
        if not key:
            raise HTTPException(400, "No Twelve Data API key. Set TWELVEDATA_API_KEY or pass api_key.")
        try:
            candles = await fetch_twelvedata(s.symbol, key)
        except Exception as e:
            raise HTTPException(502, f"Market data fetch failed: {e}")
        source_label = f"Twelve Data {s.symbol} 5min ({len(candles)} candles)"
    else:
        if not cached_candles:
            raise HTTPException(400, "No cached candles. Upload a CSV first.")
        candles = cached_candles
        source_label = f"Uploaded CSV ({len(candles)} candles)"
    if len(candles) < 30:
        raise HTTPException(400, "Not enough candles (need >= 30).")
    cached_candles = candles
    result = run_backtest(candles, s)
    result["meta"] = {"source": source_label, "candles": len(candles), "elapsed_ms": int((time.time() - t0) * 1000),
                      "from": candles[0].time.isoformat(), "to": candles[-1].time.isoformat()}
    last_backtest = result
    return result


@app.post("/api/backtest/upload")
async def backtest_upload(file: UploadFile = File(...), settings: str = Form("{}")):
    global last_backtest, cached_candles
    content = await file.read()
    candles = parse_csv(content)
    if len(candles) < 30:
        raise HTTPException(400, f"Could not parse enough candles from CSV (got {len(candles)}). "
                                 "Expected MT5 export or time,open,high,low,close columns.")
    try:
        s = Settings(**SettingsModel(**json.loads(settings)).model_dump())
    except Exception as e:
        raise HTTPException(400, f"Bad settings: {e}")
    cached_candles = candles
    t0 = time.time()
    result = run_backtest(candles, s)
    result["meta"] = {"source": f"CSV {file.filename} ({len(candles)} candles)", "candles": len(candles),
                      "elapsed_ms": int((time.time() - t0) * 1000),
                      "from": candles[0].time.isoformat(), "to": candles[-1].time.isoformat()}
    last_backtest = result
    return result


@app.get("/api/backtest/last")
def backtest_last():
    if not last_backtest:
        raise HTTPException(404, "no backtest yet")
    return last_backtest


# --------------------------------------------------------------------------
# MT5 bridge (EA -> backend)
# --------------------------------------------------------------------------

@app.post("/api/bridge/heartbeat")
async def bridge_heartbeat(hb: Heartbeat):
    _check(hb.token)
    live.update({"connected": True, "last_heartbeat": datetime.utcnow().isoformat(), "symbol": hb.symbol,
                 "account": hb.account, "state": hb.state, "bid": hb.bid, "ask": hb.ask,
                 "server_time": hb.server_time})
    _save()
    await broadcast({"type": "live", "data": _live_view()})
    return {"ok": True, "command": _pop_command()}


@app.post("/api/bridge/event")
async def bridge_event(ev: BridgeEvent):
    _check(ev.token)
    item = {"time": datetime.utcnow().isoformat(), "kind": ev.kind, "symbol": ev.symbol, "price": ev.price,
            "note": ev.note, "data": ev.data}
    live["events"].insert(0, item)
    live["events"] = live["events"][:500]
    _save()
    await broadcast({"type": "event", "data": item})
    return {"ok": True}


@app.post("/api/bridge/positions")
async def bridge_positions(snap: PositionsSnapshot):
    _check(snap.token)
    live["positions"] = snap.positions
    if snap.history:
        live["history"] = snap.history[:1000]
    _save()
    await broadcast({"type": "live", "data": _live_view()})
    return {"ok": True}


@app.get("/api/bridge/command")
def bridge_command(token: str):
    _check(token)
    return {"command": _pop_command()}


def _pop_command() -> str:
    cmd = live.get("command", "none")
    live["command"] = "none"
    return cmd


# --------------------------------------------------------------------------
# Dashboard
# --------------------------------------------------------------------------

def _live_view() -> Dict[str, Any]:
    connected = False
    if live.get("last_heartbeat"):
        age = (datetime.utcnow() - datetime.fromisoformat(live["last_heartbeat"])).total_seconds()
        connected = age < 90
    v = {k: live[k] for k in ("symbol", "account", "state", "bid", "ask", "positions", "history", "paused", "last_heartbeat")}
    v["connected"] = connected
    v["events"] = live["events"][:100]
    v["pending_command"] = live.get("command", "none")
    v["server_time"] = live.get("server_time")
    closed = [h for h in v["history"] if isinstance(h.get("profit"), (int, float))]
    wins = [h for h in closed if h["profit"] > 0]
    v["summary"] = {
        "open_positions": len(v["positions"]),
        "floating_pnl": round(sum(float(p.get("profit", 0)) for p in v["positions"]), 2),
        "closed_trades": len(closed),
        "win_rate": round(len(wins) / len(closed) * 100, 1) if closed else 0,
        "realized_pnl": round(sum(h["profit"] for h in closed), 2),
    }
    return v


@app.get("/api/live")
def live_view():
    return _live_view()


@app.post("/api/live/command")
async def live_command(cmd: Command):
    _check_dashboard(cmd.password)
    live["command"] = cmd.command
    if cmd.command == "pause":
        live["paused"] = True
    elif cmd.command == "resume":
        live["paused"] = False
    _save()
    await broadcast({"type": "live", "data": _live_view()})
    return {"ok": True, "command": cmd.command}


@app.get("/api/live/events")
def live_events(limit: int = 100):
    return live["events"][:limit]


@app.delete("/api/live/events")
async def clear_events():
    live["events"] = []
    _save()
    await broadcast({"type": "live", "data": _live_view()})
    return {"ok": True}


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()
    ws_clients.append(ws)
    try:
        await ws.send_json({"type": "live", "data": _live_view()})
        while True:
            try:
                await asyncio.wait_for(ws.receive_text(), timeout=30)
            except asyncio.TimeoutError:
                await ws.send_json({"type": "ping"})
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        if ws in ws_clients:
            ws_clients.remove(ws)


# --------------------------------------------------------------------------
# Serve built frontend (frontend/dist) from the same service in production
# --------------------------------------------------------------------------
DIST = os.environ.get("FRONTEND_DIST", os.path.join(os.path.dirname(__file__), "..", "frontend", "dist"))
if os.path.isdir(DIST):
    app.mount("/assets", StaticFiles(directory=os.path.join(DIST, "assets")), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    def spa(full_path: str):
        candidate = os.path.join(DIST, full_path)
        if full_path and os.path.isfile(candidate):
            return FileResponse(candidate)
        return FileResponse(os.path.join(DIST, "index.html"))


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=False)
