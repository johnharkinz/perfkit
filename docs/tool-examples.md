# Tool examples

This page shows, for each perfkit tool, some example prompts, an example tool call (the `arguments` an AI client sends) and an abridged result.

> **All values in these results are illustrative.** They show the shape of perfkit's output, as defined by the output schemas in `src/domain/response.ts`. They are not real measurements of any site. Results are **abridged**: long arrays are shortened and some fields are left out. The full field list is in each tool's output schema, which your MCP client can list.

Every tool returns the same JSON twice: as `structuredContent` and as a text block. Real errors set the MCP `isError` flag. `no_data` doesn't, because it is a valid finding.

## performance_pagespeed (lab data)

Example prompts:

- "Run PageSpeed Insights on https://developer.chrome.com/ for mobile."
- "What are the top Lighthouse performance audits for https://example.com/pricing on desktop?"
- "Get the lab performance and accessibility scores for https://example.com/."

Example call:

```json
{
  "name": "performance_pagespeed",
  "arguments": { "url": "https://developer.chrome.com/", "device": "PHONE", "categories": ["performance"] }
}
```

Abridged result (illustrative values):

```json
{
  "schemaVersion": "1.0.0",
  "requestedUrl": "https://developer.chrome.com/",
  "provider": "pagespeed",
  "dataType": "lab",
  "device": "PHONE",
  "strategy": "mobile",
  "status": "ok",
  "collectedAt": "2026-10-23T12:00:00.000Z",
  "cached": false,
  "warnings": [],
  "performanceScore": 87,
  "labMetrics": {
    "FCP": { "value": 1520, "unit": "ms", "score": 0.95, "displayValue": "1.5 s", "auditId": "first-contentful-paint" },
    "LCP": {
      "value": 2830,
      "unit": "ms",
      "score": 0.82,
      "displayValue": "2.8 s",
      "auditId": "largest-contentful-paint"
    },
    "CLS": {
      "value": 0.04,
      "unit": "unitless",
      "score": 0.99,
      "displayValue": "0.04",
      "auditId": "cumulative-layout-shift"
    },
    "TBT": { "value": 210, "unit": "ms", "score": 0.86, "displayValue": "210 ms", "auditId": "total-blocking-time" },
    "SI": { "value": 3100, "unit": "ms", "score": 0.93, "displayValue": "3.1 s", "auditId": "speed-index" }
  },
  "audits": [
    {
      "id": "render-blocking-insight",
      "title": "Render blocking requests",
      "description": "Requests are blocking the page's initial render, which may delay LCP. …",
      "displayValue": "Est savings of 450 ms",
      "score": 0,
      "savings": { "ms": 450, "metrics": { "FCP": 450, "LCP": 450 } }
    },
    {
      "id": "unused-javascript",
      "title": "Reduce unused JavaScript",
      "description": "Reduce unused JavaScript and defer loading scripts until they are required …",
      "displayValue": "Est savings of 120 KiB",
      "score": 0.5,
      "savings": { "ms": 300, "bytes": 122880 }
    },
    {
      "id": "lcp-breakdown-insight",
      "title": "LCP breakdown",
      "description": "Each subpart has specific improvement strategies. …",
      "displayValue": null,
      "score": 0,
      "elements": [{ "selector": "main > section > img.hero", "nodeLabel": "Hero image" }]
    },
    {
      "id": "cls-culprits-insight",
      "title": "Layout shift culprits",
      "description": "Layout shifts occur when elements move absent any user interaction. …",
      "displayValue": null,
      "score": 1,
      "elements": [{ "selector": "header > div.banner", "nodeLabel": "Cookie banner", "score": 0.03 }]
    }
  ],
  "finalUrl": "https://developer.chrome.com/",
  "lighthouseVersion": "13.5.0",
  "run": {
    "fetchTime": "2026-10-23T11:59:41.000Z",
    "formFactor": "mobile",
    "throttlingMethod": "simulate",
    "benchmarkIndex": 2400,
    "totalTimeMs": 14200,
    "runWarnings": []
  }
}
```

Things to note:

- `performanceScore` is Lighthouse's 0–100 score for one simulated run. Lab metrics have Lighthouse's own 0–1 `score` but no `rating`, and TBT is not INP.
- `savings` appears only when Lighthouse supplied an estimate. The LCP breakdown and layout-shift culprits audits are always included, even when they pass.
- If PSI tested a different URL (a redirect), `finalUrl` shows it and `warnings` says so.
- With `"categories": ["performance", "accessibility", "seo"]`, the result also has `"categoryScores": { "accessibility": 95, "seo": 100 }`.

## performance_crux_current (current field data)

Example prompts:

- "What do real phone users experience on https://developer.chrome.com/?"
- "Show current Core Web Vitals for the whole origin of https://www.example.com/blog/post on desktop."
- "Compare current field data for https://example.com/checkout on phone, tablet and desktop."

Example call:

```json
{
  "name": "performance_crux_current",
  "arguments": { "url": "https://developer.chrome.com/", "scope": "url", "device": "PHONE" }
}
```

Abridged result (illustrative values; LCP, FCP and TTFB have the same shape as INP and CLS):

```json
{
  "schemaVersion": "1.0.0",
  "requestedUrl": "https://developer.chrome.com/",
  "provider": "crux",
  "dataType": "field_current",
  "scope": "url",
  "device": "PHONE",
  "status": "ok",
  "collectedAt": "2026-10-23T12:00:00.000Z",
  "cached": false,
  "warnings": [],
  "requestedKey": { "url": "https://developer.chrome.com/", "formFactor": "PHONE" },
  "returnedKey": { "url": "https://developer.chrome.com/", "formFactor": "PHONE" },
  "collectionPeriod": { "start": "2026-09-24", "end": "2026-10-21" },
  "metrics": {
    "INP": {
      "p75": 147,
      "unit": "ms",
      "rating": "good",
      "histogram": [
        { "start": 0, "end": 200, "density": 0.88 },
        { "start": 200, "end": 500, "density": 0.09 },
        { "start": 500, "end": null, "density": 0.03 }
      ],
      "group": "core_web_vital",
      "provenance": { "source": "crux", "cruxMetric": "interaction_to_next_paint" }
    },
    "CLS": {
      "p75": 0.02,
      "unit": "unitless",
      "rating": "good",
      "histogram": [
        { "start": 0, "end": 0.1, "density": 0.93 },
        { "start": 0.1, "end": 0.25, "density": 0.04 },
        { "start": 0.25, "end": null, "density": 0.03 }
      ],
      "group": "core_web_vital",
      "provenance": { "source": "crux", "cruxMetric": "cumulative_layout_shift" }
    }
  },
  "omittedMetrics": []
}
```

With `"scope": "origin"`, perfkit queries the origin (`requestedKey` becomes `{ "origin": "https://developer.chrome.com", "formFactor": "PHONE" }`), and the result describes the whole site, not one page. If CrUX returns a different key than requested (Google normalises some URLs), `returnedKey` shows it and a warning says so.

A page with too little traffic gives `no_data`, which is not an error:

```json
{
  "schemaVersion": "1.0.0",
  "requestedUrl": "https://example.com/rarely-visited-page",
  "provider": "crux",
  "dataType": "field_current",
  "scope": "url",
  "device": "PHONE",
  "status": "no_data",
  "collectedAt": "2026-10-23T12:00:00.000Z",
  "cached": false,
  "warnings": [
    "CrUX has no current field data for this URL on device PHONE (too little traffic in the window).",
    "Origin-level field data may exist: request it separately with scope \"origin\". It describes the whole site, not this URL."
  ],
  "requestedKey": { "url": "https://example.com/rarely-visited-page", "formFactor": "PHONE" },
  "metrics": {},
  "omittedMetrics": ["INP", "LCP", "CLS", "FCP", "TTFB"]
}
```

perfkit never fetches origin data in place of URL data. The client has to ask for it explicitly.

## performance_crux_history (field history)

Example prompts:

- "Show 40 weeks of phone INP for https://developer.chrome.com/."
- "Has LCP for the origin of https://example.com/ improved over the last 10 weeks on desktop?"

Example call:

```json
{
  "name": "performance_crux_history",
  "arguments": { "url": "https://developer.chrome.com/", "scope": "url", "device": "PHONE", "periods": 40 }
}
```

Abridged result (illustrative values; 3 of 40 windows and 2 of 5 metrics shown):

```json
{
  "schemaVersion": "1.0.0",
  "requestedUrl": "https://developer.chrome.com/",
  "provider": "crux",
  "dataType": "field_history",
  "scope": "url",
  "device": "PHONE",
  "status": "ok",
  "collectedAt": "2026-10-23T12:00:00.000Z",
  "cached": false,
  "warnings": [
    "Field history points are overlapping 28-day windows, not independent samples: each window shares about three weeks with its neighbours, so consecutive points move together."
  ],
  "periods": 40,
  "requestedKey": { "url": "https://developer.chrome.com/", "formFactor": "PHONE" },
  "returnedKey": { "url": "https://developer.chrome.com/", "formFactor": "PHONE" },
  "collectionPeriods": [
    { "start": "2025-12-21", "end": "2026-01-17" },
    { "start": "2025-12-28", "end": "2026-01-24" },
    { "start": "2026-09-20", "end": "2026-10-17" }
  ],
  "metrics": {
    "INP": [
      { "start": "2025-12-21", "end": "2026-01-17", "p75": 212, "rating": "needs_improvement" },
      { "start": "2025-12-28", "end": "2026-01-24", "p75": null, "rating": null },
      { "start": "2026-09-20", "end": "2026-10-17", "p75": 151, "rating": "good" }
    ],
    "CLS": [
      { "start": "2025-12-21", "end": "2026-01-17", "p75": 0.05, "rating": "good" },
      { "start": "2025-12-28", "end": "2026-01-24", "p75": null, "rating": null },
      { "start": "2026-09-20", "end": "2026-10-17", "p75": 0.02, "rating": "good" }
    ]
  },
  "units": { "INP": "ms", "LCP": "ms", "CLS": "unitless", "FCP": "ms", "TTFB": "ms" },
  "omittedMetrics": []
}
```

Things to note:

- Points are ordered oldest first and line up one-to-one with `collectionPeriods`. Each point carries real dates, so you can line trends up with deployments.
- `null` means CrUX had no data for that window. It is never zero. perfkit doesn't compute deltas or percentage changes.
- `no_data` works as it does for current field data. The overlap warning is always `warnings[0]`.

## performance_overview (lab and field together)

Example prompts:

- "Give me a performance overview of https://developer.chrome.com/ on phone."
- "Compare URL-level and origin-level field data for https://example.com/products, and include the lab run."
- "Quick overview of https://example.com/ on desktop, no history."

Example call:

```json
{
  "name": "performance_overview",
  "arguments": { "url": "https://developer.chrome.com/", "device": "PHONE", "includeHistory": true }
}
```

Abridged result (illustrative values; each section is a complete result of the tool shown in brackets, abridged here to its status):

```json
{
  "schemaVersion": "1.0.0",
  "requestedUrl": "https://example.com/products",
  "device": "PHONE",
  "status": "partial",
  "collectedAt": "2026-10-23T12:00:00.000Z",
  "includeHistory": true,
  "warnings": [],
  "lab": {
    "provider": "pagespeed",
    "dataType": "lab",
    "strategy": "mobile",
    "status": "error",
    "cached": false,
    "error": {
      "code": "upstream_timeout",
      "source": "pagespeed",
      "retryable": true,
      "message": "PageSpeed Insights did not finish within the overview's 75 s time budget. Call performance_pagespeed on its own to wait longer."
    }
  },
  "field": {
    "url": {
      "current": { "provider": "crux", "dataType": "field_current", "scope": "url", "status": "no_data" },
      "history": { "provider": "crux", "dataType": "field_history", "scope": "url", "status": "no_data" }
    },
    "origin": {
      "current": { "provider": "crux", "dataType": "field_current", "scope": "origin", "status": "ok" },
      "history": { "provider": "crux", "dataType": "field_history", "scope": "origin", "status": "ok" }
    }
  }
}
```

Things to note:

- The sections are `lab` (like `performance_pagespeed`), `field.url.current` and `field.origin.current` (like `performance_crux_current`), and `field.url.history` and `field.origin.history` (like `performance_crux_history` with 40 periods, left out when `includeHistory` is `false`).
- Overall `status`: `ok` when no section failed (`no_data` counts as success), `partial` when some failed, `error` when all failed. Only `error` sets the MCP `isError` flag.
- URL and origin data are never merged. In this example, the URL has no field data and the origin does. That is reported as is.
- A lab `upstream_timeout` means PSI ran past the overview's budget (`PERFKIT_OVERVIEW_BUDGET_MS`, 75 s by default). Call `performance_pagespeed` directly to wait longer.
- The overview shares the cache with the narrow tools, so a follow-up `performance_crux_history` call for the same URL and device is served from the cache.

## Errors

Rejected input never reaches Google:

```json
{
  "name": "performance_crux_current",
  "arguments": { "url": "http://localhost:3000/" }
}
```

```json
{
  "schemaVersion": "1.0.0",
  "requestedUrl": "http://localhost:3000/",
  "provider": "crux",
  "dataType": "field_current",
  "scope": "url",
  "device": "PHONE",
  "status": "error",
  "collectedAt": "2026-10-23T12:00:00.000Z",
  "cached": false,
  "warnings": [],
  "error": {
    "code": "invalid_input",
    "source": "perfkit",
    "retryable": false,
    "message": "url must not target localhost, .localhost, .local or .internal hosts."
  }
}
```

A public hostname that Google can't reach (for example an unpublished staging host) passes validation. PSI then reports that it couldn't load the page, as an error like the one below. perfkit doesn't invent measurements for it.

```json
{
  "code": "upstream_error",
  "source": "pagespeed",
  "retryable": false,
  "message": "PageSpeed Insights could not test the page: Lighthouse returned error: DNS_FAILURE. DNS servers could not resolve the provided domain."
}
```

Error codes: `invalid_input`, `upstream_rate_limit`, `upstream_timeout`, `upstream_error`, `internal_error`. `source` says which side failed (`perfkit`, `pagespeed` or `crux`), and `retryable` says whether trying again may help.
