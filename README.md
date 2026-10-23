# perfkit

perfkit is a local [MCP](https://modelcontextprotocol.io/) server that gives an AI client web performance evidence for public URLs. The evidence comes from Google's **PageSpeed Insights** (PSI) and **Chrome UX Report** (CrUX) APIs. perfkit keeps lab data and field data strictly apart, and URL-level and origin-level data apart too. Every result is versioned, typed JSON that says where the evidence came from.

perfkit reports evidence. It does not diagnose causes or predict improvements.

## Tools

| Tool                       | Data                                                   | Inputs (defaults)                                                                              |
| -------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `performance_pagespeed`    | Lab data: one Lighthouse run via PSI                   | `url`, `device` `PHONE`\|`DESKTOP` (`PHONE`), `categories` (`["performance"]`)                 |
| `performance_crux_current` | Current field data: the latest 28-day CrUX window      | `url`, `scope` `url`\|`origin` (`url`), `device` `PHONE`\|`DESKTOP`\|`TABLET`\|`ALL` (`PHONE`) |
| `performance_crux_history` | Field history: up to 40 overlapping 28-day windows     | as `performance_crux_current`, plus `periods` 1–40 (`40`)                                      |
| `performance_overview`     | All of the above for a URL and its origin, in one call | `url`, `device` `PHONE`\|`DESKTOP` (`PHONE`), `includeHistory` (`true`)                        |

- **`performance_pagespeed`** returns the 0–100 performance score, unrated lab FCP, LCP, CLS, TBT and Speed Index with Lighthouse's own per-metric scores, and up to 10 failing performance audits. The LCP breakdown and layout-shift culprits audits are always included. Savings appear only when Google supplies an estimate above zero. `PHONE` maps to PSI's `mobile` strategy and `DESKTOP` to `desktop`. You can also ask for `accessibility`, `best-practices` and `seo`, which return scores only. If PSI tested a different URL because of a redirect, the result says so. It tests a URL only: there is no origin option, so for field data on a whole origin use the CrUX tools.
- **`performance_crux_current`** returns p75 INP, LCP and CLS (the Core Web Vitals) plus FCP and TTFB (supporting metrics). Each one is rated `good`, `needs_improvement` or `poor`, with its histogram and the collection period. `scope: "origin"` asks for the whole origin (scheme plus host, so `www.example.com` and `example.com` are different origins). `device: "ALL"` combines every device.
- **`performance_crux_history`** returns a series of `{start, end, p75, rating}` points per metric, oldest first. Missing points stay `null`, never zero. The points are overlapping windows, not independent weekly samples, and every result carries a warning saying so.
- **`performance_overview`** runs these sections in parallel: `lab`, `field.url.current`, `field.origin.current`, and (unless `includeHistory` is `false`) `field.url.history` and `field.origin.history`. Each section is a complete result with its own `status`. The overall `status` is `ok` when no section failed (`no_data` counts as success), `error` when every section failed, and `partial` otherwise. If PSI is still running when the overview's time budget (75 s by default) runs out, the `lab` section becomes an `upstream_timeout` error and the field sections are still returned. To wait longer for lab data, call `performance_pagespeed` on its own: it has no overall budget, just 60 s per attempt plus one retry.

See [docs/tool-examples.md](docs/tool-examples.md) for example prompts, calls and results.

### Lab data vs. field data

- **Lab data** (`dataType: "lab"`) comes from one simulated Lighthouse run on an emulated phone or desktop. It is useful for finding leads such as the LCP element, render-blocking resources and layout-shift culprits. It is **never rated** against Core Web Vitals thresholds, because one simulated run says little about real Chrome users. The **performance score** is Lighthouse's 0–100 score for that run. It is not a Core Web Vitals assessment. Lab TBT is not INP.
- **Field data** (`dataType: "field_current"` or `"field_history"`) is what real Chrome users experienced over a 28-day window, as published by CrUX. Its p75 values are rated with Google's thresholds (for example INP good ≤ 200 ms, poor > 500 ms). perfkit ignores the field data embedded in PSI responses and reads field data only from the CrUX APIs.
- **`no_data`** means CrUX publishes no field data for that URL or origin, usually because it has too little traffic. It is a valid finding, not an error. perfkit never substitutes origin data for missing URL data. It only suggests asking for origin scope separately.

Every result carries `schemaVersion`, `requestedUrl` (redacted), `provider`, `dataType`, `device`, `status`, `collectedAt`, `cached`/`cachedAt` and `warnings`. Field results also carry `scope`. Errors carry `error {code, source, retryable, message}`, where `code` is one of `invalid_input`, `upstream_rate_limit`, `upstream_timeout`, `upstream_error` or `internal_error`. Each tool declares an output schema and returns `structuredContent`, plus the same JSON as a text block for clients that read only text.

## Setup

You need:

- Node.js 24 LTS
- A Google API key with the **PageSpeed Insights API** and the **Chrome UX Report API** enabled, ideally restricted to just those two. See [docs/google-setup.md](docs/google-setup.md).

Build perfkit:

```bash
git clone https://github.com/johnharkinz/perfkit.git
cd perfkit
npm ci
npm run build
```

This produces `dist/main.js`, a stdio MCP server. It reads its configuration from environment variables, which the MCP client passes when it starts the server. If `GOOGLE_API_KEY` is missing, perfkit exits at startup with a message naming the variable.

### Connect Claude Code

```bash
claude mcp add perfkit -e GOOGLE_API_KEY=your-key -- node /absolute/path/to/perfkit/dist/main.js
```

- Use the absolute path to `dist/main.js` in your clone (run `pwd` in the repo to get it).
- Add `--scope user` to make perfkit available in every project, not just the current directory. The default is local scope.
- Pass other configuration variables with more `-e NAME=value` flags, for example `-e PERFKIT_OVERVIEW_BUDGET_MS=90000`.
- Run `claude mcp list`, or `/mcp` inside Claude Code, to check that perfkit is connected. Then ask, for example: "Give me a performance overview of https://developer.chrome.com/ on phone."

The `-e` flag stores the key in Claude Code's MCP configuration (`~/.claude.json` for local and user scope), so treat that file as a secret. Don't use `--scope project`, which would write the key into a `.mcp.json` file in the project and could get it committed.

After you rebuild perfkit, restart Claude Code (or reconnect from `/mcp`) to pick up the new build.

### Other MCP clients

perfkit has only been tested with Claude Code. Other clients that can launch a local **stdio** MCP server should be able to run it, but compatibility isn't promised. In general:

- **Command:** `node`. **Arguments:** the absolute path to `dist/main.js`. perfkit doesn't use a working directory or a `.env` file at runtime, so set the variables in the client's server config.
- **Environment:** `GOOGLE_API_KEY`, plus any optional variables from [Configuration](#configuration).
- Many clients use a JSON config like the one below. Check your client's documentation for the exact file and keys.

  ```json
  {
    "mcpServers": {
      "perfkit": {
        "command": "node",
        "args": ["/absolute/path/to/perfkit/dist/main.js"],
        "env": { "GOOGLE_API_KEY": "your-key" }
      }
    }
  }
  ```

- perfkit uses stdio only. It has no HTTP or SSE endpoint.
- The client should read `structuredContent` or the text block. Both carry the same JSON.
- PSI calls can take 10–60 s or more. Raise the client's tool-call timeout if it is shorter than about 90 s (or longer than `PERFKIT_OVERVIEW_BUDGET_MS`, if you raise that).
- To try the server without an AI client, run `GOOGLE_API_KEY=your-key npm run inspect`, which opens it in the MCP Inspector.

## Configuration

Only `GOOGLE_API_KEY` is required. All other variables are optional. An invalid value stops startup with a message naming the variable (never its value). [`.env.example`](.env.example) lists them all.

| Variable                                 | Default           | Meaning                                                                                                                                                                                       |
| ---------------------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GOOGLE_API_KEY`                         | required          | Google API key. It is sent only in a request header and never logged or returned.                                                                                                             |
| `PERFKIT_PSI_TIMEOUT_MS`                 | `60000`           | Per-attempt timeout for PageSpeed Insights (1–600000)                                                                                                                                         |
| `PERFKIT_PSI_RETRIES`                    | `1`               | Retries for PageSpeed Insights on 429, 5xx, timeouts and network failures (0–10)                                                                                                              |
| `PERFKIT_CRUX_TIMEOUT_MS`                | `10000`           | Per-attempt timeout for the CrUX APIs (1–600000)                                                                                                                                              |
| `PERFKIT_CRUX_RETRIES`                   | `3`               | Retries for the CrUX APIs on 429, 5xx, timeouts and network failures (0–10)                                                                                                                   |
| `PERFKIT_OVERVIEW_BUDGET_MS`             | `75000`           | Overall time budget for one `performance_overview` call (1–600000). A section still running then becomes `upstream_timeout`.                                                                  |
| `PERFKIT_CACHE_TTL_PAGESPEED_SECONDS`    | `1800` (30 min)   | Cache lifetime for lab data. `0` disables caching.                                                                                                                                            |
| `PERFKIT_CACHE_TTL_CRUX_CURRENT_SECONDS` | `43200` (12 h)    | Cache lifetime for current field data, and for `no_data` from either CrUX API. `0` disables caching.                                                                                          |
| `PERFKIT_CACHE_TTL_CRUX_HISTORY_SECONDS` | `604800` (7 days) | Cache lifetime for field history. `0` disables caching.                                                                                                                                       |
| `PERFKIT_CACHE_MAX_ENTRIES`              | `500`             | Maximum number of cached results (least recently used are evicted first). `0` disables caching.                                                                                               |
| `PERFKIT_DNS_CHECK`                      | off (`0`)         | `1` or `true` also rejects URLs whose host fails to resolve or resolves to a non-public IP address. It adds a DNS lookup per call. See [ADR 0001](docs/adr/0001-syntactic-url-validation.md). |

Retries use exponential backoff with jitter. Other 4xx responses are not retried.

**Caching.** Results are cached in memory, per server process, so that repeat questions save API quota. A cached result has `cached: true`, and its `cachedAt` and `collectedAt` are both the time Google's answer arrived. Errors are never cached. The narrow tools and `performance_overview` share cache entries. Restarting the server clears the cache.

**URL validation.** Before calling Google, perfkit rejects unsafe or non-public targets as `invalid_input`, by syntax alone: only http and https are allowed, URLs are capped at 2048 characters, embedded credentials are refused, and so are loopback, private, link-local and cloud-metadata IP literals, `localhost`, `*.local`, `*.internal` and single-label hosts. Fragments are dropped. Sensitive query parameters (`token`, `key`, `auth`, `session`, `password` and similar) are redacted in all results and logs.

**Logs** are JSON lines on stderr, with a correlation ID per tool call, latency, cache hits and upstream errors. stdout carries only MCP protocol traffic.

## Limitations

- **Public URLs only.** Google fetches the page, so perfkit can't test authenticated pages, pages behind a login or VPN, or staging hosts that Google can't reach. For an unreachable URL, PSI returns an error (for example a DNS or document-request failure), and perfkit passes it on as an `upstream_error` rather than inventing measurements. CrUX has no field data for such URLs either.
- **No causal diagnosis.** perfkit reports evidence (scores, p75s, audits, histograms). It doesn't explain why a page is slow or predict the effect of a fix. Lighthouse's savings estimates are passed through only when Google supplies them, and zero estimates are dropped.
- **CrUX moves slowly.** Each field data point covers 28 days of real Chrome users' experience, so a deployment shows up gradually over about four weeks. Current data updates daily, history updates weekly (on Mondays), and consecutive history points overlap by about three weeks. Low-traffic pages and origins return `no_data`. CrUX publishes no sample or visit counts, and perfkit doesn't invent them.
- **One lab run.** Lab results come from a single Lighthouse run on Google's infrastructure, and they vary from run to run. Within the cache lifetime (30 minutes by default), repeat calls return the cached run.
- **Quotas.** The CrUX APIs share a quota of 150 queries per minute per Google Cloud project. PSI has its own daily and per-minute quotas. One overview call makes up to five upstream calls (one PSI, four CrUX), plus retries.
- **Metrics.** Field data covers INP, LCP, CLS, FCP and TTFB only. Lab data covers FCP, LCP, CLS, TBT and Speed Index.
- **Transport.** stdio only, for one local user. There is no remote or multi-user deployment.

## Development

| Command                            | What it does                                                                                     |
| ---------------------------------- | ------------------------------------------------------------------------------------------------ |
| `npm run lint`                     | ESLint, Prettier check (including Markdown) and a TypeScript type check                          |
| `npm test`                         | Offline tests: an in-memory MCP client, a fake `fetch` and saved Google responses. No key needed |
| `npm run build`                    | Compile to `dist/`                                                                               |
| `LIVE=1 npm run test:live`         | Opt-in tests against the real Google APIs (needs `GOOGLE_API_KEY`)                               |
| `GOOGLE_API_KEY=… npm run inspect` | Build and open the server in the MCP Inspector                                                   |

### Live tests

The live tests call the real PSI and CrUX APIs for `https://developer.chrome.com/` and check the shape of each result, not specific values. They skip unless `LIVE=1` is set. Running them uses some of your quota. A PSI run can take over a minute.

`npm run test:live` loads a `.env` file from the repo root if there is one, using Node's built-in `--env-file-if-exists`. Put your key there to avoid typing it on the command line:

```bash
cp .env.example .env    # then edit .env and set GOOGLE_API_KEY
LIVE=1 npm run test:live
```

`.env` is git-ignored. Variables already set in your shell take precedence over `.env`, so `LIVE=1 GOOGLE_API_KEY=… npm run test:live` still works. Only the live tests read `.env`. The server itself (`npm start`, or an MCP client) doesn't, so give it the key through the client's configuration.

### Manual smoke test

[docs/smoke-test.md](docs/smoke-test.md) is a checklist for trying perfkit end to end in Claude Code.

### Project docs

- [GLOSSARY.md](GLOSSARY.md): the domain vocabulary (lab data, field data, scope, origin, rating, and so on)
- [docs/adr/](docs/adr/): architecture decision records
