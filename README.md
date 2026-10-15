# LinkCharts

A free, open-source, TradingView-style charting app for global markets: India, the US, other world exchanges, crypto, forex and commodities.

- Drawing tools and 20+ indicators
- **Stock screener** with filters and sortable columns
- Multiple watchlists and price alerts
- Bar replay and paper trading, including paper trading inside replay

No account or API key is needed to start. It uses free data out of the box, and you can add your own provider keys.

> Charts are rendered with [TradingView Lightweight Charts™](https://github.com/tradingview/lightweight-charts) (Apache-2.0). LinkCharts is not affiliated with TradingView.

## Quick start

You need [Node.js](https://nodejs.org) 18 or newer (no other installs).

```bash
git clone https://github.com/Mehal45/LinkCharts.git
cd LinkCharts
npm start
```

Then open **http://localhost:5174** in Chrome, Edge or Firefox.

The server only listens on your own computer (127.0.0.1), because it can store your API keys. Each person runs their own copy.

## Data sources

| Source | Key needed | Covers | Notes |
|---|---|---|---|
| Yahoo Finance | No | India, US, world stocks and indices, forex, futures, crypto | Unofficial; usually delayed |
| Binance | No | Crypto | **Real-time** over WebSocket. USD pairs map to USDT |
| Fyers API v3 | App ID + daily access token | India | Your own Fyers app (myapi.fyers.in) |
| Twelve Data | API key | US, world, forex, crypto (India on paid plans) | Free: 800 requests/day |
| Polygon.io | API key | US, crypto, forex | Free: 5 requests/min, delayed |

- **Adding keys:** open **⚙ → Data sources & API keys**. Each provider has its own fields, because keys from different providers look alike and some need two values, so one auto-detecting box wouldn't be reliable. Click **Test** after saving.
- **Choosing a source:** the same screen has a per-market table. If a source fails, the app falls back to Yahoo, and the ⚠ on the source badge explains why.
- **Fyers, Twelve Data and Polygon** have only been checked with invalid keys so far (each returned its proper error). They haven't been tested with real accounts.

## Features

- **Layout:** drawing tools on the left, chart in the middle, paper-trading panel at the bottom, and the watchlist with symbol details on the right. The right edge switches between Watchlist and Alerts.
- **Drawing tools:**
  - Tools: trend line, ray, extended line, horizontal line and ray, vertical line, rectangle, Fibonacci retracement and text.
  - Editing: select, drag, recolour, clone or delete; a magnet snaps to open/high/low/close.
  - Drawings are saved per symbol. A selected horizontal line can turn into an alert (🔔).
- **Indicators:**
  - On the chart: SMA, EMA, WMA, Hull MA, VWAP, Bollinger Bands, Keltner Channels, Donchian Channels, Supertrend, Parabolic SAR, Ichimoku.
  - In their own panes: RSI, MACD, Stochastic, Stochastic RSI, CCI, Williams %R, ROC, ATR, ADX/DMI, OBV, MFI.
  - Volume, too. Add the same indicator several times with different settings; ⚙ in the legend edits it.
- **Watchlists:**
  - Defaults: India, US, Crypto, Forex & commodities, World indices.
  - Create, rename, duplicate or delete lists; add sections (§), collapse them, and drag rows to reorder.
- **Alerts:**
  - Conditions: above, below or crossing a price, once or every time.
  - When one fires you get a sound, a pop-up, a desktop notification and a log entry. The level is drawn on the chart.
  - Alerts are only checked while the app is open.
- **Bar replay:** click **⏪ Replay**, then click a bar to start there. You can play (1×–25×) or step forward with Shift+→.
- **Paper trading:**
  - Market, limit and stop orders, with optional stop-loss and take-profit (one cancels the other). Long and short positions, P&L, history.
  - **Two separate accounts:** *Live* (current prices) and *Replay*, where orders fill against the replayed bars so you can practise on past data.
  - Each currency gets its own virtual balance (₹10,00,000 or $100,000).

## Stock screener

Click **🔍 Screener** in the header. Esc goes back to the chart.

- **Markets:** India (NSE, BSE), United States (NASDAQ, NYSE, NYSE American), UK, Germany, Japan, Hong Kong, Canada and Australia. Tick or untick individual exchanges.
- **Ready-made screens:** top gainers, top losers, most active, unusual volume, near 52-week high, near 52-week low, large caps, low P/E, high dividend, and above the 50- and 200-day moving averages.
- **Filters:**
  - price, change %, volume, relative volume, market cap, P/E, dividend yield, sector;
  - % from the 52-week high, % above the 52-week low, 52-week change;
  - distance from the 50- and 200-day moving averages.
  - Amounts accept shortcuts like `10L`, `5Cr`, `2M` or `10B`.
- **Columns:** click any header to sort, and use ☷ Columns to show or hide them, including 1W, 1M, 3M, 6M, YTD and 1Y returns (loaded for the page you're viewing).
- **Actions:** click a row to open its chart, use ＋ to add it to the current watchlist, or **☆ Save as watchlist** to save all the results.
- **How it gets data:** the screener fetches up to 1,500 of the largest matching companies from Yahoo, then filters and sorts them precisely in your browser. In India, BSE copies of NSE stocks are hidden by default.

## Shortcuts

| Keys | Action |
|---|---|
| Start typing | Symbol search |
| Alt+T / Alt+H / Alt+J / Alt+V / Alt+F / Alt+Shift+R | Trend line / horizontal line / horizontal ray / vertical line / Fib / rectangle |
| Del · Esc | Delete selected drawing · cancel |
| Alt+A | New alert |
| Alt+R | Replay on/off |
| Shift+→ · Shift+Space | Replay: next bar · play/pause |

## Files

| File | Role |
|---|---|
| `server.mjs` | API, caching, key storage (`data/config.json`), per-market source routing |
| `providers.mjs` | Yahoo, Binance, Fyers, Twelve Data, Polygon adapters and symbol mapping |
| `src/app.js` | Wiring: toolbar, loading, live updates, quotes, search, shortcuts |
| `src/chart.js` | Price chart, volume, indicator overlays and panes, legend, coordinate helpers |
| `src/drawings.js` | Drawing tools (a Lightweight Charts series primitive) |
| `src/indicators.js` | Indicator maths and registry |
| `screener.mjs` · `src/screener.js` | Screener backend (Yahoo screener + performance) and UI |
| `src/watchlists.js` · `src/alerts.js` · `src/trading.js` · `src/replay.js` · `src/details.js` · `src/settings.js` | Panels |

## Disclaimer & limits

- **Free data:** Yahoo is unofficial and may be delayed, so it's for personal use only; don't publish its data.
- **Fyers token:** Fyers access tokens expire daily, so generate a new one each day.
- **Paper trading isn't realistic execution:** no fees, slippage or margin. Your data (watchlists, alerts, drawings, trades) is stored in this browser.
- **Not investment advice.** This is an educational tool. Market data may be delayed or wrong, and nothing here is a recommendation to buy or sell.

## License

MIT — see [LICENSE](LICENSE).
