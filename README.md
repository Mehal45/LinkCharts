# LinkCharts

A free, open-source, TradingView-style charting app for global markets: India, the US, other world exchanges, crypto, forex and commodities.

- Drawing tools and 20+ indicators
- **Stock screener** with filters and sortable columns
- Multiple watchlists and price alerts
- Bar replay and paper trading, including paper trading inside replay

No account or API key is needed to start. It uses free data out of the box, and you can add your own provider keys.

> Charts are rendered with [TradingView Lightweight Charts™](https://github.com/tradingview/lightweight-charts) (Apache-2.0). LinkCharts is not affiliated with TradingView.

## Installation

### Windows: download the installer (easiest)

1. Go to the **[latest release](https://github.com/Mehal45/LinkCharts/releases/latest)** and download **`LinkCharts-Setup-….exe`**.
2. Open it. If Windows shows *"Windows protected your PC"*, click **More info → Run anyway** (the installer isn't code-signed yet).
3. Click **Next** through the installer. LinkCharts opens in its own window, with shortcuts on the desktop and in the Start menu.

No Node.js, browser or black window needed. Updates: download and run the newer installer; your data stays.

### Mac, Linux, or running from the source

It takes about 5 minutes. No account, API key or coding is needed.

### Step 1: Install Node.js (one time only)

1. Go to **[nodejs.org](https://nodejs.org)** and download the **LTS** version.
2. Open the downloaded file and click **Next** through the installer, keeping the default options.

### Step 2: Download LinkCharts

1. At the top of this GitHub page, click the green **Code** button, then **Download ZIP**.
2. Find the ZIP in your Downloads folder and unzip it: right-click → **Extract All** on Windows, or double-click it on a Mac.
3. Move the unzipped `LinkCharts-main` folder somewhere you'll keep it, such as Documents.

### Step 3: Start it

| Your computer | What to do |
|---|---|
| **Windows** | Open the folder and double-click **`Start LinkCharts.bat`**. If Windows shows *"Windows protected your PC"*, click **More info → Run anyway**. |
| **Mac** | Open the folder, **right-click** **`Start LinkCharts.command`** and choose **Open**, then **Open** again. You only need the right-click the first time; after that, a double-click works. |
| **Linux** | In a terminal inside the folder, run `npm start`. |

LinkCharts opens in your browser at **http://localhost:5174**. Chrome, Edge and Firefox all work.

- **Keep the black window open** while you use LinkCharts. Closing it stops the app.
- **Next time,** just repeat Step 3. Your watchlists, drawings, alerts and settings are saved on your PC (see [Your data is saved on your PC](#your-data-is-saved-on-your-pc)).

### Updating to a new version

Download the new ZIP (Step 2). Then copy the **`data`** folder from your old LinkCharts folder into the new one, so your saved data and API keys come with you.

### If something goes wrong

| Problem | Fix |
|---|---|
| *"Node.js is not installed"* or `'node' is not recognized` | Do Step 1, then **restart your computer** and try again. |
| *"Port 5174 is already in use"* | LinkCharts is probably already running in another window, so just open http://localhost:5174. To use a different port, run `node server.mjs 5175` in the folder and open http://localhost:5175. |
| The page is blank or won't load | Make sure the black window is still open, then refresh the page. |

### For developers

```bash
git clone https://github.com/Mehal45/LinkCharts.git
cd LinkCharts
npm start          # starts the server and opens the browser
npm run serve      # starts the server only
```

There are no dependencies to install and no build step.

The server only listens on your own computer (127.0.0.1), because it can store your API keys. Each person runs their own copy.

## Data sources

17 sources: 6 work with no key, and 11 use your own account or API key. Add keys in **⚙ → Data sources & API keys**. Each provider has its own fields (some need two values, such as an app ID and token), and a **Test** button checks the key.

### Free (no key)

| Source | Covers | Notes |
|---|---|---|
| Yahoo Finance | India, US, world stocks & indices, forex, futures, crypto | Default for most markets; unofficial and usually delayed |
| Binance | Crypto | **Real-time** over WebSocket (USD pairs map to USDT) |
| Coinbase Exchange | Crypto (USD/EUR/GBP) | Public candles |
| Kraken | Crypto | Public candles, ~720 bars per interval |
| Upstox (public history) | India (NSE/BSE stocks, NIFTY/SENSEX indices) | Broker-grade candles, including today's intraday, with no login |
| CoinGecko | Thousands of coins | Works keyless; an optional free Demo key raises the limit. Intraday wicks are approximate |

### Indian brokers (your account)

| Source | You enter | Notes |
|---|---|---|
| Fyers API v3 | App ID + access token | Token expires daily |
| Zerodha Kite Connect | API key + access token | Needs the historical-data add-on; token expires daily |

### Global data APIs (your key)

| Source | Covers | Free plan |
|---|---|---|
| Twelve Data | US, world, forex, crypto (India on paid plans) | 800 requests/day |
| Polygon.io (Massive) | US, crypto, forex | 5 requests/min, delayed |
| Alpaca | US stocks (IEX feed), crypto | Free account, paper keys work |
| Tiingo | US stocks (decades of EOD), IEX intraday, crypto, forex | Free key |
| Financial Modeling Prep | US free; world, India, forex, crypto on paid plans | 250 requests/day |
| EODHD | 70+ exchanges incl. NSE/BSE, indices, forex, crypto | 20 requests/day, 1 year EOD |
| Marketstack | 70+ exchanges incl. NSE | 100 requests/month, EOD only |
| Alpha Vantage | US (incl. intraday), BSE, world, forex, crypto (daily+) | 25 requests/day |
| Tradier | US stocks, ETFs, indices | Brokerage or sandbox token (detected automatically) |

**Choosing a source:** the settings screen has a per-market table (India, US, other exchanges, crypto, forex, futures). "Automatic" uses the best source you've connected. If it fails (expired token, rate limit, unsupported symbol), the app falls back to Yahoo, and the ⚠ on the source badge explains why.

**Testing status:**
- **Free sources:** tested end to end with real data.
- **Key-based providers:** each was called with a dummy key and returned its proper "invalid key" error, which confirms the requests are well-formed. None has been tested with a real paid account yet.
- **Reporting problems:** if one misbehaves with your key, please open an issue.

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

## Multiple charts

Click **⊞ Layout** above the chart to show several charts side by side. There are 10 layouts:

- 1 chart
- 2 side by side, or 2 stacked
- 3 in a row, 3 stacked, or 1 big + 2
- a 2 × 2 grid, or 1 big + 3 below
- a 3 × 2 or 4 × 2 grid (up to 8 charts)

- **Separate charts:** each chart has its own symbol, interval, chart type, indicators, drawings and replay, and loads its own data (crypto charts stream live).
- **The active chart:** click a chart to make it active (it gets an outline), or press **Alt+1 … Alt+8**. The search box, watchlist, interval and chart-type buttons, indicators, drawing tools, replay and trade ticket all act on it, and the details panel follows it.
- **Sync across charts** (in the same menu):
  - **Symbol:** every chart shows the same symbol.
  - **Interval:** every chart changes interval together.
  - **Crosshair:** hovering one chart puts the crosshair on the same moment in real time on the others, even across different time zones and intervals.
- **Shared lines:** price alerts and paper-trading positions or orders appear on every chart showing that symbol.
- **Remembered:** the layout and each chart's settings are saved. Closing charts and reopening a bigger layout brings them back.

## Themes

A theme picker with live thumbnails appears the first time someone opens LinkCharts. After that, reopen it any time with **🎨 Theme** in the top bar. Every theme restyles the whole interface and the chart itself: background, grid, candle, volume and indicator colours.

| Group | Themes |
|---|---|
| Classic | **Midnight** (default), **Daylight** |
| Style | **Glossy Glass** (frosted panels over a moving gradient), **Aesthetic** (pastel), **Black & White**, **White & Black** (print style), **Terminal** (green phosphor, monospace), **Sunset** |
| Trading psychology | **Calm Mind**, **Focus**, **Colour-blind safe** |

**About the psychology themes:**
- **Calm Mind:** swaps alarm-red falling candles for a calm slate-blue and hides the grid, to dampen panic selling and revenge trades.
- **Focus:** dims everything except the chart until you point at it, to cut distraction and overtrading.
- **Colour-blind safe:** uses blue/orange instead of red/green, which helps with red-green colour blindness.

## Stock screener

Click **🔍 Screener** in the header. Esc goes back to the chart.

- **Markets and data sources:**
  - **India:** NSE's official index lists (NIFTY 50, 100, 200, 500, Midcap 150, Smallcap 250, Microcap 250, Total Market 750). Pick one under *Universe*. Industry is used as the sector. There's no market cap, P/E or dividend data, so India sorts by *Value traded* and hides those filters.
  - **United States:** every NASDAQ, NYSE and NYSE American stock from Nasdaq's public screener, with price, change, volume, market cap and sector. The largest N by market cap (250–1,500) get the full set of figures.
  - **UK, Germany, Japan, Hong Kong, Canada, Australia:** these still use Yahoo's screener, which currently refuses sessions from apps like this. The screener shows a message when it's unavailable.
  - **How the figures are made:** relative volume, 52-week range, moving-average distance and 1W–1Y returns are calculated from a year of daily prices for each stock. The first scan takes about 5–20 seconds, then results are cached for a few minutes.
- **Ready-made screens:** top gainers, top losers, most active, unusual volume, near 52-week high, near 52-week low, large caps, low P/E, high dividend, and above the 50- and 200-day moving averages. Screens that need data a market doesn't have are greyed out.
- **Filters:**
  - price, change %, volume, relative volume, market cap, P/E, dividend yield, sector;
  - % from the 52-week high, % above the 52-week low, 52-week change;
  - distance from the 50- and 200-day moving averages.
  - Amounts accept shortcuts like `10L`, `5Cr`, `2M` or `10B`.
- **Columns:** click any header to sort, and use ☷ Columns to show or hide them.
- **Actions:** click a row to open its chart, use ＋ to add it to the current watchlist, or **☆ Save as watchlist** to save all the results.

## Your data is saved on your PC

Everything you set up is saved automatically to **`data/userdata.json`** on your computer (in the Windows app: **`%APPDATA%\LinkCharts\data\`**, so it survives updates and reinstalls). That includes watchlists, alerts, drawings, paper-trading account and history, chart layouts, indicators, theme and screener settings.

- **Survives everything:** reloading, restarting the server or PC, clearing browser data, private windows, and switching browsers.
- **Speed:** the browser keeps a copy so it opens instantly. Changes are written to the file within a second, and the last ones are flushed when you close the tab.
- **Back up or move:** copy `data/userdata.json` (and `data/config.json` for API keys) to another LinkCharts folder.
- **Start fresh:** stop the server and delete `data/userdata.json`, then clear the site's data in your browser.
- **Private:** the `data/` folder is in `.gitignore`, so your data and keys are never uploaded to GitHub.

## Shortcuts

| Keys | Action |
|---|---|
| Start typing | Symbol search |
| Alt+T / Alt+H / Alt+J / Alt+V / Alt+F / Alt+Shift+R | Trend line / horizontal line / horizontal ray / vertical line / Fib / rectangle |
| Del · Esc | Delete selected drawing · cancel |
| Alt+A | New alert |
| Alt+R | Replay on/off |
| Alt+1 … Alt+8 | Make chart 1–8 the active chart |
| Shift+→ · Shift+Space | Replay: next bar · play/pause |

## Files

| File | Role |
|---|---|
| `Start LinkCharts.bat` · `Start LinkCharts.command` | Double-click launchers for Windows and Mac |
| `desktop/main.cjs` | Windows app: runs the server inside the app and shows it in its own window (`npm run app` to try it, `npm run dist:win` to build the installer) |
| `server.mjs` | API, caching, key storage (`data/config.json`), saved user data (`data/userdata.json`), per-market source routing |
| `src/boot.js` | Startup: loads saved data from disk before the app starts |
| `providers.mjs` | Provider registry, Yahoo, Binance, Fyers, Twelve Data, Polygon |
| `providers-extra.mjs` | Coinbase, Kraken, Upstox, CoinGecko, Kite, Alpaca, Tiingo, FMP, EODHD, Marketstack, Alpha Vantage, Tradier + shared time-zone/resampling helpers |
| `src/app.js` | Wiring: toolbar, loading, live updates, quotes, search, shortcuts |
| `src/chart.js` | Price chart, volume, indicator overlays and panes, legend, coordinate helpers |
| `src/drawings.js` | Drawing tools (a Lightweight Charts series primitive) |
| `src/indicators.js` | Indicator maths and registry |
| `screener.mjs` · `screener-sources.mjs` · `src/screener.js` | Screener: market routing, NSE/Nasdaq sources with Yahoo price history, and the UI |
| `src/themes.js` | Theme definitions (UI variables + chart palette) and the theme picker |
| `src/watchlists.js` · `src/alerts.js` · `src/trading.js` · `src/replay.js` · `src/details.js` · `src/settings.js` | Panels |

## Disclaimer & limits

- **Free data:** Yahoo is unofficial and may be delayed, so it's for personal use only; don't publish its data.
- **Broker tokens:** Fyers and Kite access tokens expire daily, so generate a new one each day.
- **Paper trading isn't realistic execution:** no fees, slippage or margin. Your data (watchlists, alerts, drawings, trades) is stored in this browser.
- **Not investment advice.** This is an educational tool. Market data may be delayed or wrong, and nothing here is a recommendation to buy or sell.

## License

MIT — see [LICENSE](LICENSE).
