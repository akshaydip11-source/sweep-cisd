//+------------------------------------------------------------------+
//|                                          SweepCISD_Bridge.mq5    |
//|   H1 Liquidity Sweep + M5 CISD EA  +  REST bridge to dashboard   |
//|                                                                  |
//|   Strategy logic is UNCHANGED from the original EA.              |
//|   Added: heartbeat / events / positions push to backend,         |
//|          remote pause / resume / close_all commands.             |
//|                                                                  |
//|   MT5: Tools > Options > Expert Advisors >                       |
//|        [x] Allow WebRequest for listed URL -> add ServerURL      |
//+------------------------------------------------------------------+
#property strict
#property version   "1.10"

#include <Trade/Trade.mqh>
#include <Trade/PositionInfo.mqh>

CTrade        trade;
CPositionInfo posInfo;

//==================================================================
// INPUTS
//==================================================================
input group "Strategy"
input double RiskPerTrade       = 25.0;      // Risk in account currency
input double RiskReward         = 1.0;       // Risk : Reward
input int    MaxCISDCandles     = 4;         // CISD must happen within N M5 candles
input int    SLBufferPoints     = 10;        // SL buffer beyond sweep extreme (points)
input bool   OnePositionOnly    = true;      // Only one open position on symbol
input ulong  MagicNumber        = 20260826;

input group "Safety (live money protection)"
input double MaxDailyLoss       = 75.0;      // Stop trading for the day after this loss (0 = off)
input int    MaxTradesPerDay    = 6;         // Max new trades per day (0 = off)
input int    MaxSpreadPoints    = 50;        // Skip entry if spread wider than this (0 = off)
input int    MaxSlippagePoints  = 30;        // Max deviation allowed on market orders
input bool   UseSessionFilter   = false;     // Trade only inside the session window (server time)
input int    SessionStartHour   = 7;         // Session start hour (server time)
input int    SessionEndHour     = 20;        // Session end hour (server time)

input group "Dashboard bridge"
input string ServerURL          = "http://127.0.0.1:8000";  // Backend base URL (no trailing slash)
input string BridgeToken        = "change-me";              // Must match BRIDGE_TOKEN on the server
input int    HeartbeatSeconds   = 10;                        // Heartbeat / command poll interval
input bool   EnableBridge       = true;

//==================================================================
// STATE
//==================================================================
enum SweepDirection { NO_SWEEP = 0, BULLISH_SWEEP, BEARISH_SWEEP };

SweepDirection sweepDirection = NO_SWEEP;
datetime sweepTime = 0, sweepH1Time = 0, lastM5BarTime = 0;
double   sweepLevel = 0.0, sweepExtreme = 0.0;
int      candlesAfterSweep = 0;
bool     sweepDetected = false, waitingForCISD = false;
bool     tradingPaused = false;
datetime lastHistoryPush = 0;
datetime dailyLockDay = 0;          // day for which daily loss lock was triggered

//==================================================================
int OnInit()
{
   trade.SetExpertMagicNumber(MagicNumber);
   trade.SetDeviationInPoints(MaxSlippagePoints);
   trade.SetTypeFillingBySymbol(_Symbol);
   if(!TerminalInfoInteger(TERMINAL_TRADE_ALLOWED))
      Print("WARNING: Algo Trading is disabled in the terminal. Enable the 'Algo Trading' button.");
   if(EnableBridge)
   {
      EventSetTimer(MathMax(2, HeartbeatSeconds));
      SendEvent("EA_START", 0, "EA initialised on " + _Symbol + " " + EnumToString(_Period));
   }
   Print("H1 Liquidity Sweep + M5 CISD EA (bridge) initialized.");
   return(INIT_SUCCEEDED);
}

void OnDeinit(const int reason)
{
   EventKillTimer();
   if(EnableBridge) SendEvent("EA_STOP", 0, "EA removed, reason=" + IntegerToString(reason));
}

//==================================================================
// ON TICK  (unchanged strategy gate)
//==================================================================
void OnTick()
{
   datetime currentM5Time = iTime(_Symbol, PERIOD_M5, 0);
   if(currentM5Time == lastM5BarTime) return;
   lastM5BarTime = currentM5Time;

   if(OnePositionOnly && PositionSelect(_Symbol)) return;
   if(tradingPaused) return;
   if(!SafetyChecksPass()) return;

   ProcessStrategy();
}

//==================================================================
// ON TIMER  (bridge: heartbeat -> command, positions snapshot)
//==================================================================
void OnTimer()
{
   if(!EnableBridge) return;
   string cmd = SendHeartbeat();
   HandleCommand(cmd);
   SendPositions();
}

//==================================================================
// MAIN STRATEGY  (identical to original)
//==================================================================
void ProcessStrategy()
{
   datetime currentH1Time = iTime(_Symbol, PERIOD_H1, 0);
   if(currentH1Time == 0) return;

   double previousH1High = iHigh(_Symbol, PERIOD_H1, 1);
   double previousH1Low  = iLow(_Symbol, PERIOD_H1, 1);
   if(previousH1High <= 0 || previousH1Low <= 0) return;

   double m5High  = iHigh(_Symbol, PERIOD_M5, 1);
   double m5Low   = iLow(_Symbol, PERIOD_M5, 1);
   double m5Close = iClose(_Symbol, PERIOD_M5, 1);
   datetime m5Time = iTime(_Symbol, PERIOD_M5, 1);
   if(m5Time == 0) return;

   if(sweepH1Time != currentH1Time)
   {
      ResetSetup();
      sweepH1Time = currentH1Time;
   }

   if(!sweepDetected)
   {
      if(m5Low < previousH1Low && m5Close > previousH1Low)
      {
         sweepDirection = BULLISH_SWEEP; sweepDetected = true; waitingForCISD = true;
         sweepTime = m5Time; sweepLevel = previousH1Low; sweepExtreme = m5Low; candlesAfterSweep = 0;
         Print("Bullish liquidity sweep detected. Level = ", DoubleToString(sweepLevel, _Digits));
         SendEvent("SWEEP_BULL", sweepLevel, "Bullish sweep of prev H1 low");
         return;
      }
      if(m5High > previousH1High && m5Close < previousH1High)
      {
         sweepDirection = BEARISH_SWEEP; sweepDetected = true; waitingForCISD = true;
         sweepTime = m5Time; sweepLevel = previousH1High; sweepExtreme = m5High; candlesAfterSweep = 0;
         Print("Bearish liquidity sweep detected. Level = ", DoubleToString(sweepLevel, _Digits));
         SendEvent("SWEEP_BEAR", sweepLevel, "Bearish sweep of prev H1 high");
         return;
      }
   }

   if(waitingForCISD)
   {
      candlesAfterSweep++;
      if(sweepDirection == BULLISH_SWEEP && m5Low  < sweepExtreme) sweepExtreme = m5Low;
      if(sweepDirection == BEARISH_SWEEP && m5High > sweepExtreme) sweepExtreme = m5High;

      if(candlesAfterSweep > MaxCISDCandles)
      {
         Print("CISD window expired.");
         SendEvent("EXPIRED", m5Close, "CISD window expired");
         ResetSetup();
         return;
      }

      if(sweepDirection == BULLISH_SWEEP && IsBullishCISD())
      {
         double entry = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
         double sl = sweepExtreme - SLBufferPoints * _Point;
         double riskDistance = entry - sl;
         if(riskDistance <= 0) { ResetSetup(); return; }
         double tp = entry + riskDistance * RiskReward;
         double volume = CalculateVolume(ORDER_TYPE_BUY, entry, sl);
         SendEvent("CISD_BULL", entry, "Bullish CISD confirmed, vol " + DoubleToString(volume, 2));
         if(volume > 0) ExecuteBuy(volume, sl, tp);
         ResetSetup();
         return;
      }

      if(sweepDirection == BEARISH_SWEEP && IsBearishCISD())
      {
         double entry = SymbolInfoDouble(_Symbol, SYMBOL_BID);
         double sl = sweepExtreme + SLBufferPoints * _Point;
         double riskDistance = sl - entry;
         if(riskDistance <= 0) { ResetSetup(); return; }
         double tp = entry - riskDistance * RiskReward;
         double volume = CalculateVolume(ORDER_TYPE_SELL, entry, sl);
         SendEvent("CISD_BEAR", entry, "Bearish CISD confirmed, vol " + DoubleToString(volume, 2));
         if(volume > 0) ExecuteSell(volume, sl, tp);
         ResetSetup();
         return;
      }
   }
}

//==================================================================
// CISD detectors (identical)
//==================================================================
bool IsBullishCISD()
{
   double currentOpen = iOpen(_Symbol, PERIOD_M5, 1), currentClose = iClose(_Symbol, PERIOD_M5, 1);
   if(currentClose <= currentOpen) return false;
   for(int i = 2; i <= 10; i++)
   {
      double pO = iOpen(_Symbol, PERIOD_M5, i), pC = iClose(_Symbol, PERIOD_M5, i);
      if(pC < pO) { if(currentClose > pO) { Print("Bullish CISD confirmed."); return true; } break; }
   }
   return false;
}

bool IsBearishCISD()
{
   double currentOpen = iOpen(_Symbol, PERIOD_M5, 1), currentClose = iClose(_Symbol, PERIOD_M5, 1);
   if(currentClose >= currentOpen) return false;
   for(int i = 2; i <= 10; i++)
   {
      double pO = iOpen(_Symbol, PERIOD_M5, i), pC = iClose(_Symbol, PERIOD_M5, i);
      if(pC > pO) { if(currentClose < pO) { Print("Bearish CISD confirmed."); return true; } break; }
   }
   return false;
}

//==================================================================
// Position sizing (identical)
//==================================================================
double CalculateVolume(ENUM_ORDER_TYPE orderType, double entry, double stopLoss)
{
   double riskForOneLot = 0.0;
   if(!OrderCalcProfit(orderType, _Symbol, 1.0, entry, stopLoss, riskForOneLot))
   {
      Print("OrderCalcProfit failed. Error = ", GetLastError());
      SendEvent("ERROR", 0, "OrderCalcProfit failed " + IntegerToString(GetLastError()));
      return 0.0;
   }
   riskForOneLot = MathAbs(riskForOneLot);
   if(riskForOneLot <= 0) return 0.0;

   double volume = RiskPerTrade / riskForOneLot;
   double minV = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MIN);
   double maxV = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MAX);
   double step = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_STEP);
   if(volume < minV) volume = minV;
   if(volume > maxV) volume = maxV;
   volume = MathFloor(volume / step) * step;

   int vd = 2;
   if(step == 1.0) vd = 0; else if(step == 0.1) vd = 1; else if(step == 0.001) vd = 3;
   volume = NormalizeDouble(volume, vd);
   Print("Risk = ", DoubleToString(RiskPerTrade, 2), " | Entry = ", DoubleToString(entry, _Digits),
         " | SL = ", DoubleToString(stopLoss, _Digits), " | Volume = ", DoubleToString(volume, vd));
   return volume;
}

//==================================================================
// Execution
//==================================================================
bool StopsValid(double price, double sl, double tp)
{
   double minDist = SymbolInfoInteger(_Symbol, SYMBOL_TRADE_STOPS_LEVEL) * _Point;
   if(MathAbs(price - sl) < minDist || MathAbs(tp - price) < minDist)
   {
      Print("SL/TP too close to price (stops level ", minDist, "). Trade skipped.");
      SendEvent("ORDER_FAIL", price, "SL/TP inside broker stops level, skipped");
      return false;
   }
   return true;
}

void ExecuteBuy(double volume, double sl, double tp)
{
   sl = NormalizeDouble(sl, _Digits); tp = NormalizeDouble(tp, _Digits);
   if(!StopsValid(SymbolInfoDouble(_Symbol, SYMBOL_ASK), sl, tp)) return;
   if(trade.Buy(volume, _Symbol, 0.0, sl, tp, "Bullish CISD"))
   {
      Print("BUY executed | Volume = ", volume, " | SL = ", sl, " | TP = ", tp);
      SendEvent("ORDER_BUY", trade.ResultPrice(), "BUY " + DoubleToString(volume, 2) + " SL " + DoubleToString(sl, _Digits) + " TP " + DoubleToString(tp, _Digits));
   }
   else
   {
      Print("BUY failed. Retcode = ", trade.ResultRetcode(), " | ", trade.ResultRetcodeDescription());
      SendEvent("ORDER_FAIL", 0, "BUY failed: " + trade.ResultRetcodeDescription());
   }
}

void ExecuteSell(double volume, double sl, double tp)
{
   sl = NormalizeDouble(sl, _Digits); tp = NormalizeDouble(tp, _Digits);
   if(!StopsValid(SymbolInfoDouble(_Symbol, SYMBOL_BID), sl, tp)) return;
   if(trade.Sell(volume, _Symbol, 0.0, sl, tp, "Bearish CISD"))
   {
      Print("SELL executed | Volume = ", volume, " | SL = ", sl, " | TP = ", tp);
      SendEvent("ORDER_SELL", trade.ResultPrice(), "SELL " + DoubleToString(volume, 2) + " SL " + DoubleToString(sl, _Digits) + " TP " + DoubleToString(tp, _Digits));
   }
   else
   {
      Print("SELL failed. Retcode = ", trade.ResultRetcode(), " | ", trade.ResultRetcodeDescription());
      SendEvent("ORDER_FAIL", 0, "SELL failed: " + trade.ResultRetcodeDescription());
   }
}

void ResetSetup()
{
   sweepDirection = NO_SWEEP; sweepDetected = false; waitingForCISD = false;
   sweepTime = 0; sweepLevel = 0.0; sweepExtreme = 0.0; candlesAfterSweep = 0;
}

//==================================================================
// SAFETY  -------------------------------------------------------
//==================================================================
double TodayClosedPnL()
{
   datetime dayStart = (datetime)(TimeCurrent() / 86400) * 86400;
   HistorySelect(dayStart, TimeCurrent());
   double pnl = 0;
   for(int i = HistoryDealsTotal() - 1; i >= 0; i--)
   {
      ulong t = HistoryDealGetTicket(i);
      if(HistoryDealGetString(t, DEAL_SYMBOL) != _Symbol) continue;
      if(HistoryDealGetInteger(t, DEAL_MAGIC) != (long)MagicNumber) continue;
      if(HistoryDealGetInteger(t, DEAL_ENTRY) != DEAL_ENTRY_OUT) continue;
      pnl += HistoryDealGetDouble(t, DEAL_PROFIT) + HistoryDealGetDouble(t, DEAL_SWAP) + HistoryDealGetDouble(t, DEAL_COMMISSION);
   }
   return pnl;
}

int TodayTradeCount()
{
   datetime dayStart = (datetime)(TimeCurrent() / 86400) * 86400;
   HistorySelect(dayStart, TimeCurrent());
   int n = 0;
   for(int i = HistoryDealsTotal() - 1; i >= 0; i--)
   {
      ulong t = HistoryDealGetTicket(i);
      if(HistoryDealGetString(t, DEAL_SYMBOL) != _Symbol) continue;
      if(HistoryDealGetInteger(t, DEAL_MAGIC) != (long)MagicNumber) continue;
      if(HistoryDealGetInteger(t, DEAL_ENTRY) == DEAL_ENTRY_IN) n++;
   }
   return n;
}

bool SafetyChecksPass()
{
   datetime today = (datetime)(TimeCurrent() / 86400) * 86400;
   if(dailyLockDay == today) return false;                       // already locked for today

   if(MaxDailyLoss > 0)
   {
      double pnl = TodayClosedPnL() + AccountInfoDouble(ACCOUNT_PROFIT);
      if(pnl <= -MaxDailyLoss)
      {
         dailyLockDay = today;
         Print("Daily loss limit reached (", DoubleToString(pnl, 2), "). No more trades today.");
         SendEvent("DAILY_LOCK", 0, "Daily loss limit hit: " + DoubleToString(pnl, 2));
         return false;
      }
   }
   if(MaxTradesPerDay > 0 && TodayTradeCount() >= MaxTradesPerDay) return false;

   if(UseSessionFilter)
   {
      MqlDateTime dt; TimeToStruct(TimeCurrent(), dt);
      if(dt.hour < SessionStartHour || dt.hour >= SessionEndHour) return false;
   }
   if(MaxSpreadPoints > 0)
   {
      long spread = SymbolInfoInteger(_Symbol, SYMBOL_SPREAD);
      if(spread > MaxSpreadPoints) return false;
   }
   if(!TerminalInfoInteger(TERMINAL_TRADE_ALLOWED) || !MQLInfoInteger(MQL_TRADE_ALLOWED)) return false;
   return true;
}

//==================================================================
// BRIDGE  -------------------------------------------------------
//==================================================================
string JsonEscape(string s)
{
   StringReplace(s, "\\", "\\\\");
   StringReplace(s, "\"", "\\\"");
   return s;
}

string D(double v, int digits = 2) { return DoubleToString(v, digits); }

// POST json, returns response body ("" on failure)
string HttpPost(string path, string json)
{
   if(!EnableBridge) return "";
   char data[]; char result[]; string headers;
   int len = StringToCharArray(json, data, 0, WHOLE_ARRAY, CP_UTF8) - 1;
   ArrayResize(data, len);
   ResetLastError();
   int code = WebRequest("POST", ServerURL + path, "Content-Type: application/json\r\n", 5000, data, result, headers);
   if(code == -1)
   {
      static datetime lastWarn = 0;
      if(TimeCurrent() - lastWarn > 60)
      {
         Print("WebRequest failed (", GetLastError(), "). Add ", ServerURL, " to Tools>Options>Expert Advisors>Allow WebRequest.");
         lastWarn = TimeCurrent();
      }
      return "";
   }
   if(code < 200 || code >= 300) { Print("Bridge HTTP ", code, " for ", path); return ""; }
   return CharArrayToString(result, 0, WHOLE_ARRAY, CP_UTF8);
}

string ExtractCommand(string body)
{
   int p = StringFind(body, "\"command\"");
   if(p < 0) return "none";
   int q1 = StringFind(body, "\"", p + 9);
   int q2 = StringFind(body, "\"", q1 + 1);
   if(q1 < 0 || q2 < 0) return "none";
   return StringSubstr(body, q1 + 1, q2 - q1 - 1);
}

string SendHeartbeat()
{
   string dir = (sweepDirection == BULLISH_SWEEP ? "BULL" : sweepDirection == BEARISH_SWEEP ? "BEAR" : "null");
   string json = "{"
      "\"token\":\"" + JsonEscape(BridgeToken) + "\","
      "\"symbol\":\"" + _Symbol + "\","
      "\"bid\":" + D(SymbolInfoDouble(_Symbol, SYMBOL_BID), _Digits) + ","
      "\"ask\":" + D(SymbolInfoDouble(_Symbol, SYMBOL_ASK), _Digits) + ","
      "\"server_time\":\"" + TimeToString(TimeCurrent(), TIME_DATE | TIME_SECONDS) + "\","
      "\"account\":{"
         "\"login\":" + IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN)) + ","
         "\"name\":\"" + JsonEscape(AccountInfoString(ACCOUNT_NAME)) + "\","
         "\"server\":\"" + JsonEscape(AccountInfoString(ACCOUNT_SERVER)) + "\","
         "\"currency\":\"" + AccountInfoString(ACCOUNT_CURRENCY) + "\","
         "\"balance\":" + D(AccountInfoDouble(ACCOUNT_BALANCE)) + ","
         "\"equity\":" + D(AccountInfoDouble(ACCOUNT_EQUITY)) + ","
         "\"margin\":" + D(AccountInfoDouble(ACCOUNT_MARGIN)) + ","
         "\"margin_free\":" + D(AccountInfoDouble(ACCOUNT_MARGIN_FREE)) + ","
         "\"profit\":" + D(AccountInfoDouble(ACCOUNT_PROFIT)) + ","
         "\"leverage\":" + IntegerToString(AccountInfoInteger(ACCOUNT_LEVERAGE)) + ","
         "\"trade_mode\":\"" + (AccountInfoInteger(ACCOUNT_TRADE_MODE) == ACCOUNT_TRADE_MODE_DEMO ? "DEMO" : "REAL") + "\""
      "},"
      "\"state\":{"
         "\"sweep_direction\":" + (dir == "null" ? "null" : "\"" + dir + "\"") + ","
         "\"waiting_for_cisd\":" + (waitingForCISD ? "true" : "false") + ","
         "\"sweep_level\":" + D(sweepLevel, _Digits) + ","
         "\"sweep_extreme\":" + D(sweepExtreme, _Digits) + ","
         "\"candles_after_sweep\":" + IntegerToString(candlesAfterSweep) + ","
         "\"max_cisd_candles\":" + IntegerToString(MaxCISDCandles) + ","
         "\"prev_h1_high\":" + D(iHigh(_Symbol, PERIOD_H1, 1), _Digits) + ","
         "\"prev_h1_low\":" + D(iLow(_Symbol, PERIOD_H1, 1), _Digits) + ","
         "\"risk_per_trade\":" + D(RiskPerTrade) + ","
         "\"risk_reward\":" + D(RiskReward) + ","
         "\"paused\":" + (tradingPaused ? "true" : "false") + ","
         "\"daily_pnl\":" + D(TodayClosedPnL()) + ","
         "\"daily_trades\":" + IntegerToString(TodayTradeCount()) + ","
         "\"daily_locked\":" + (dailyLockDay == (datetime)(TimeCurrent() / 86400) * 86400 ? "true" : "false") + ","
         "\"magic\":" + IntegerToString(MagicNumber) +
      "}}";
   string body = HttpPost("/api/bridge/heartbeat", json);
   if(body == "") return "none";
   return ExtractCommand(body);
}

void SendEvent(string kind, double price, string note)
{
   string json = "{\"token\":\"" + JsonEscape(BridgeToken) + "\",\"kind\":\"" + kind + "\",\"symbol\":\"" + _Symbol +
                 "\",\"price\":" + D(price, _Digits) + ",\"note\":\"" + JsonEscape(note) + "\"}";
   HttpPost("/api/bridge/event", json);
}

void SendPositions()
{
   string pos = "";
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      if(!posInfo.SelectByIndex(i)) continue;
      if(posInfo.Symbol() != _Symbol || posInfo.Magic() != MagicNumber) continue;
      if(pos != "") pos += ",";
      pos += "{\"ticket\":" + IntegerToString(posInfo.Ticket()) +
             ",\"type\":\"" + (posInfo.PositionType() == POSITION_TYPE_BUY ? "BUY" : "SELL") + "\"" +
             ",\"volume\":" + D(posInfo.Volume(), 2) +
             ",\"price_open\":" + D(posInfo.PriceOpen(), _Digits) +
             ",\"sl\":" + D(posInfo.StopLoss(), _Digits) +
             ",\"tp\":" + D(posInfo.TakeProfit(), _Digits) +
             ",\"price_current\":" + D(posInfo.PriceCurrent(), _Digits) +
             ",\"profit\":" + D(posInfo.Profit() + posInfo.Swap()) +
             ",\"time\":\"" + TimeToString(posInfo.Time(), TIME_DATE | TIME_MINUTES) + "\"}";
   }

   // closed deals (last 30 days, out-deals only), refreshed every 60s
   string hist = "";
   if(TimeCurrent() - lastHistoryPush >= 60)
   {
      lastHistoryPush = TimeCurrent();
      HistorySelect(TimeCurrent() - 30 * 86400, TimeCurrent());
      int total = HistoryDealsTotal(), count = 0;
      for(int i = total - 1; i >= 0 && count < 200; i--)
      {
         ulong ticket = HistoryDealGetTicket(i);
         if(HistoryDealGetString(ticket, DEAL_SYMBOL) != _Symbol) continue;
         if(HistoryDealGetInteger(ticket, DEAL_MAGIC) != (long)MagicNumber) continue;
         if(HistoryDealGetInteger(ticket, DEAL_ENTRY) != DEAL_ENTRY_OUT) continue;
         long type = HistoryDealGetInteger(ticket, DEAL_TYPE);
         long reason = HistoryDealGetInteger(ticket, DEAL_REASON);
         string rs = reason == DEAL_REASON_SL ? "SL" : reason == DEAL_REASON_TP ? "TP" : reason == DEAL_REASON_EXPERT ? "EA" : "MANUAL";
         if(hist != "") hist += ",";
         // closing deal type is opposite of the position side
         hist += "{\"deal\":" + IntegerToString(ticket) +
                 ",\"time\":\"" + TimeToString((datetime)HistoryDealGetInteger(ticket, DEAL_TIME), TIME_DATE | TIME_MINUTES) + "\"" +
                 ",\"type\":\"" + (type == DEAL_TYPE_SELL ? "BUY" : "SELL") + "\"" +
                 ",\"volume\":" + D(HistoryDealGetDouble(ticket, DEAL_VOLUME), 2) +
                 ",\"price\":" + D(HistoryDealGetDouble(ticket, DEAL_PRICE), _Digits) +
                 ",\"reason\":\"" + rs + "\"" +
                 ",\"profit\":" + D(HistoryDealGetDouble(ticket, DEAL_PROFIT) + HistoryDealGetDouble(ticket, DEAL_SWAP) + HistoryDealGetDouble(ticket, DEAL_COMMISSION)) + "}";
         count++;
      }
   }
   string json = "{\"token\":\"" + JsonEscape(BridgeToken) + "\",\"positions\":[" + pos + "],\"history\":[" + hist + "]}";
   HttpPost("/api/bridge/positions", json);
}

void HandleCommand(string cmd)
{
   if(cmd == "pause"  && !tradingPaused) { tradingPaused = true;  SendEvent("PAUSED", 0, "Trading paused from dashboard"); Print("Trading paused."); }
   if(cmd == "resume" &&  tradingPaused) { tradingPaused = false; SendEvent("RESUMED", 0, "Trading resumed from dashboard"); Print("Trading resumed."); }
   if(cmd == "close_all")
   {
      int closed = 0;
      for(int i = PositionsTotal() - 1; i >= 0; i--)
      {
         if(!posInfo.SelectByIndex(i)) continue;
         if(posInfo.Symbol() != _Symbol || posInfo.Magic() != MagicNumber) continue;
         if(trade.PositionClose(posInfo.Ticket())) closed++;
      }
      SendEvent("CLOSE_ALL", 0, "Closed " + IntegerToString(closed) + " position(s) from dashboard");
   }
}
//+------------------------------------------------------------------+
