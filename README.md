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

## Development

| Command                                     | What it does                                                        |
| ------------------------------------------- | ------------------------------------------------------------------- |
| `npm run lint`                              | ESLint, Prettier check and a TypeScript type check                  |
| `npm test`                                  | Offline tests (in-memory MCP client, fake `fetch`, saved responses) |
| `npm run build`                             | Compile to `dist/`                                                  |
| `LIVE=1 GOOGLE_API_KEY=… npm run test:live` | Opt-in test against the real Google APIs                            |
| `GOOGLE_API_KEY=… npm run inspect`          | Build and open the server in the MCP Inspector                      |

Logs are JSON lines on stderr; stdout carries only MCP protocol traffic.
