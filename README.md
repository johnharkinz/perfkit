# perfkit

A local MCP server that reports web performance evidence for public URLs from Google's PageSpeed Insights and Chrome UX Report (CrUX), keeping **lab data** and **field data** strictly apart.

Tools so far:

- `performance_crux_current`: current field data (the latest 28-day CrUX window) for a URL: p75 INP, LCP and CLS (Core Web Vitals) plus FCP and TTFB, each rated, with histograms and collection dates.

## Requirements

- Node.js 24 LTS
- A Google API key with the **Chrome UX Report API** (and, for lab data, the **PageSpeed Insights API**) enabled.

## Add to Claude Code

```bash
npm install && npm run build
claude mcp add perfkit --env GOOGLE_API_KEY=your-key -- node /absolute/path/to/perfkit/dist/main.js
```

Then ask, for example: "Get current field data for https://developer.chrome.com/ on phone."

## Configuration

| Variable                  | Default  | Meaning                                                                 |
| ------------------------- | -------- | ----------------------------------------------------------------------- |
| `GOOGLE_API_KEY`          | required | Google API key; sent only in a request header, never logged or returned |
| `PERFKIT_PSI_TIMEOUT_MS`  | `60000`  | Per-attempt timeout for PageSpeed Insights                              |
| `PERFKIT_PSI_RETRIES`     | `1`      | Retries for PageSpeed Insights on 429, 5xx and timeouts                 |
| `PERFKIT_CRUX_TIMEOUT_MS` | `10000`  | Per-attempt timeout for the CrUX API                                    |
| `PERFKIT_CRUX_RETRIES`    | `3`      | Retries for the CrUX API on 429, 5xx and timeouts                       |

Retries use exponential backoff with jitter. Other 4xx responses are not retried.

## Caching

Results are cached in memory (per server process) so that repeat questions save API quota. A cached result has `cached: true` and `cachedAt`, and its `collectedAt` is when the data was actually fetched. Errors are never cached. You can override these optional environment variables (`0` disables caching for that kind):

| Variable                                 | Default           | Applies to                    |
| ---------------------------------------- | ----------------- | ----------------------------- |
| `PERFKIT_CACHE_TTL_PAGESPEED_SECONDS`    | `1800` (30 min)   | Lab data (PSI)                |
| `PERFKIT_CACHE_TTL_CRUX_CURRENT_SECONDS` | `43200` (12 h)    | Current field data, `no_data` |
| `PERFKIT_CACHE_TTL_CRUX_HISTORY_SECONDS` | `604800` (7 days) | Field history                 |
| `PERFKIT_CACHE_MAX_ENTRIES`              | `500`             | LRU bound on cached results   |

## Development

| Command                                     | What it does                                                        |
| ------------------------------------------- | ------------------------------------------------------------------- |
| `npm run lint`                              | ESLint, Prettier check and a TypeScript type check                  |
| `npm test`                                  | Offline tests (in-memory MCP client, fake `fetch`, saved responses) |
| `npm run build`                             | Compile to `dist/`                                                  |
| `LIVE=1 GOOGLE_API_KEY=… npm run test:live` | Opt-in test against the real Google APIs                            |
| `GOOGLE_API_KEY=… npm run inspect`          | Build and open the server in the MCP Inspector                      |

Logs are JSON lines on stderr; stdout carries only MCP protocol traffic.
