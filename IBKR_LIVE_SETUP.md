# IBKR Paper Trading — Live Forward-Test Setup

This guide covers connecting the SPX 0DTE Dashboard to Interactive Brokers' paper trading environment for forward-testing the combo strategy on live market data.

## Prerequisites

- **Interactive Brokers account** with paper trading enabled
- **IB Gateway** or **TWS** (Trader Workstation) installed
- Node.js v18+ (v22 recommended)

## Step 1: Install and Configure IB Gateway / TWS

1. Download and install [IB Gateway](https://www.interactivebrokers.com/en/trading/ib-gateway.php) or TWS from your IBKR account portal.
2. Launch IB Gateway (recommended — lighter than TWS).
3. Log in with your **paper trading** credentials (username usually ends in `-paper`).
4. Go to **Configuration → API → Settings** and ensure:
   - **Enable API connections** is checked
   - **Trusted IP Addresses** includes `127.0.0.1`
   - **Port** is set to `5000` (Client Portal API)

### For macOS

If you encounter certificate warnings when the app tries to connect to `https://localhost:5000`, this is expected — the Client Portal API uses a self-signed cert. The backend handles this automatically (`rejectUnauthorized: false`).

## Step 2: Verify API Access

With IB Gateway running and logged in:

```bash
curl -k https://localhost:5000/v1/api/iserver/auth/status
```

Expected response:

```json
{"authenticated": true, "connected": true, "competing": false, "fail": ""}
```

If `authenticated` is `false`, complete the login process in the IB Gateway window.

## Step 3: Run the Backend in Live Mode

From the `options-api/` directory:

```bash
IB_LIVE=true npm start
```

The backend will:
1. Start serving historical data as usual (parquet files)
2. Attempt to connect to IB Gateway at `https://localhost:5000/v1/api`
3. If connected and authenticated, begin polling the SPXW option chain and spot price
4. Serve live data through `/api/live/*` endpoints

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `IB_LIVE` | `false` | Set to `true` to enable the live IBKR feed |
| `IB_GATEWAY_URL` | `https://localhost:5000/v1/api` | Gateway REST API base URL |
| `IB_POLL_INTERVAL` | `15000` | Milliseconds between chain snapshot polls |

## Step 4: Run the Frontend

In a separate terminal, from the `spx-app/` directory:

```bash
npm run dev
```

The Vite dev server will proxy `/api` requests to the backend (port 3080 by default).

## Step 5: Use the Live Tab

1. Open `http://localhost:5173` in your browser
2. Click the **Live** tab in the navigation bar
3. Three connection states:
   - **Connecting to IB Gateway** — app is checking the Gateway status
   - **IB Gateway Not Reachable** — ensure Gateway is running on port 5000
   - **Not Authenticated** — log in to the Gateway window
   - **LIVE** indicator (green pulsing dot) — connected and receiving data
4. The live tab displays:
   - Current SPX spot price with intraday change
   - Session uptime
   - Option chain strike count and last update time
   - **TradeScanner** running on live data — shows qualifying combos in real-time

## How the Live Data Feed Works

```
IB Gateway (localhost:5000)
    ↓ REST API (Client Portal Protocol)
Backend (localhost:3080)
    ↓ polls every 15s by default
Option Chain Snapshot
    ├── SPXW contract discovery (weekly expiry)
    ├── Market data snapshot for all strikes
    └── Spot price (SPX index)
        ↓
Cached in memory
    ↓
Served at /api/live/chain and /api/live/spot
    ↓
Frontend LiveTab → TradeScanner
```

The backend caches the latest chain snapshot and updates it on each poll interval. The frontend polls the backend every 3 seconds for fresh spot data, and every 4th poll (~12s) refreshes the full option chain.

## Architecture

### Files Added/Modified

| File | Purpose |
|---|---|
| `options-api/ibkr-client.js` | IB Gateway REST API client — auth, contracts, market data, orders |
| `options-api/server.js` | Added `/api/live/*` endpoints, live feed loop |
| `spx-app/src/components/LiveTab.tsx` | Live dashboard with connection status, spot ticker, scanner |
| `spx-app/src/App.tsx` | Added "Live" tab to navigation |

### API Endpoints (Backend)

| Endpoint | Method | Description |
|---|---|---|
| `/api/live/status` | GET | Connection and auth status, current spot |
| `/api/live/chain` | GET | Latest option chain snapshot |
| `/api/live/spot` | GET | Current spot, price path, uptime |
| `/api/live/order` | POST | Place a paper trade via IBKR |

## Troubleshooting

### "IB Gateway Not Reachable"

- Confirm IB Gateway/TWS is running
- Confirm the port is 5000 (Client Portal API)
- Check if the Gateway is listening: `lsof -i :5000`
- Restart Gateway and try again

### "Not Authenticated"

- Bring the IB Gateway window to the front
- Complete the login (credentials + 2FA if enabled)
- Verify the session is active

### No chain data / zero strikes

- Ensure it's a market hours (SPXW options trade 9:30 AM – 4:00 PM ET)
- The weekly SPXW expiry may not be available on holiday weeks
- Check that your paper trading account has market data subscriptions

### Connection refused from frontend

- Confirm the backend is running (`npm start` in `options-api/`)
- Confirm the Vite proxy is configured: check `spx-app/vite.config.ts` for `/api` proxy to `localhost:3080`

## Next Steps After Setup

Once live data is flowing and the scanner shows qualifying combos:

1. **Monitor which combos trigger** at different spot levels throughout the day
2. **Compare live scanner results** with backtest expectations
3. **Paper trade selected combos** via the IBKR API (order endpoint is ready)
4. **Gather intraday chain data** from the live feed to improve backtest data quality
