# arcadia-mcp

MCP server for the [Arcadia Arc](https://www.arcadia.com/arc) utility data API.

Connects to 7,000+ utilities to surface bill data, interval meter readings, and carbon calculations via the Model Context Protocol.

## Tools

| Tool | Description |
|------|-------------|
| `list_utility_accounts` | List all connected utility accounts |
| `get_account` | Get details for a specific account (meters, status) |
| `get_bills` | Retrieve utility statements with optional date range |
| `get_interval_data` | High-resolution (15min/30min/hourly/daily) consumption for a meter |
| `get_meters` | List meters for an account |
| `calculate_carbon` | Estimate CO₂ emissions from kWh using EPA eGRID 2023 factors |

## Usage

### Auth

Pass your Arcadia API key as a Bearer token in the `Authorization` header of every MCP request:

```
Authorization: Bearer arc_live_...
```

### MCP endpoint

```
POST /mcp
```

### Health check

```
GET /health
```

## Development

```bash
npm install
npm run dev       # tsx watch mode
npm run build     # tsc → dist/
npm start         # node dist/index.js
```

Set `PORT` env var to override the default port 3000.

## Deployment

Deploy to Railway — the `railway.toml` configures build and start commands automatically.

Set the `PORT` environment variable if needed (Railway injects it automatically).

## Carbon calculation

Uses EPA eGRID 2023 emission factors (lbs CO₂/MWh) for 20 US states. All other states default to 850 lbs CO₂/MWh (approximate US average). Returns both `kgCO2e` and `lbsCO2`.
