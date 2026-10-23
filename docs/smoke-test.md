# Claude Code smoke test

This is a manual end-to-end check of perfkit in Claude Code, covering the five usage scenarios from the handoff. It uses real Google APIs, so the numbers will differ from run to run. Check the **shape and labelling** of each answer, not specific values.

## Before you start

1. Build perfkit: `npm ci && npm run build`.
2. Connect it to Claude Code with your key (see [google-setup.md](google-setup.md) to get one):

   ```bash
   claude mcp add perfkit -e GOOGLE_API_KEY=your-key -- node /absolute/path/to/perfkit/dist/main.js
   ```

3. Start Claude Code and run `/mcp`. Check that `perfkit` is connected and lists four tools: `performance_pagespeed`, `performance_crux_current`, `performance_crux_history` and `performance_overview`.
4. For each scenario below, paste the prompt, approve the tool call, and expand the tool result to read the raw JSON as well as Claude's summary.
5. Note the date, Claude Code version (`claude --version`) and perfkit commit (`git rev-parse --short HEAD`) for your record.

## 1. Overview of a mobile URL

**Prompt:** "Give me a performance overview of https://developer.chrome.com/ on phone."

Check:

- [ ] Claude calls `performance_overview` with `device: "PHONE"` (and `includeHistory` true or left out).
- [ ] The result has `lab`, `field.url.current`, `field.url.history`, `field.origin.current` and `field.origin.history`, each with its own `status`.
- [ ] The overall `status` is `ok`, or `partial` with the failing section named. If the lab section is an `upstream_timeout` that mentions the time budget, the field sections are still present.
- [ ] `lab.strategy` is `mobile`, `lab.performanceScore` is 0–100, and the lab metrics have no `rating`.
- [ ] Field metrics have p75s, ratings and a `collectionPeriod`. The URL and origin numbers are reported separately, not merged.
- [ ] Claude's answer keeps lab data (one simulated run) and field data (28 days of real Chrome users) apart, and doesn't call the performance score a Core Web Vitals assessment.
- [ ] Claude doesn't present TBT as INP, and doesn't claim causes beyond what the audits say.

## 2. 40 weeks of phone INP

**Prompt:** "Show me 40 weeks of phone INP for https://developer.chrome.com/."

Check:

- [ ] Claude calls `performance_crux_history` with `device: "PHONE"` and `periods: 40` (or the default), `scope: "url"`.
- [ ] `metrics.INP` has 40 points (or as many as CrUX returned), oldest first, each with real `start`/`end` dates.
- [ ] Any missing week is `null`, not `0`, and Claude doesn't treat it as zero.
- [ ] `warnings[0]` says the points are overlapping 28-day windows. Claude doesn't describe them as independent weekly samples, and doesn't compute percentage changes across null points.

## 3. URL vs. origin comparison

**Prompt:** "Compare current phone field data for https://developer.chrome.com/docs/ with its whole origin."

Check:

- [ ] Claude makes two `performance_crux_current` calls, one with `scope: "url"` and one with `scope: "origin"` (or uses `performance_overview`'s `field.url` and `field.origin` sections).
- [ ] The origin result's `requestedKey.origin` is `https://developer.chrome.com` (scheme plus host, no path).
- [ ] Both results have `scope` set correctly. If `returnedKey` differs from `requestedKey`, there is a warning saying Google normalised the key.
- [ ] Claude's answer clearly says which numbers describe the page and which describe the whole site.

## 4. A low-traffic page returning no_data

**Prompt:** "Get current phone field data for <a public but rarely visited page>." (Pick a real page on a small site, for example a deep blog post on a personal site. If it unexpectedly has data, try a more obscure page.)

Check:

- [ ] The result has `status: "no_data"`, not `error`, and the tool call isn't flagged as an error.
- [ ] `omittedMetrics` lists all five metrics, `metrics` is empty, and the warnings suggest asking for `scope: "origin"` separately.
- [ ] perfkit made no origin request on its own. Claude reports "no field data for this URL" as a finding. If Claude then asks for origin data, it presents it as origin-level, not as the page's data.

## 5. An inaccessible staging URL

**Prompt:** "Run PageSpeed Insights on https://staging.perfkit-smoke-test-unpublished.com/ on phone." (Any well-formed public hostname that Google can't resolve or reach works, for example an unpublished staging subdomain of a site you own.)

Check:

- [ ] Claude calls `performance_pagespeed` (or the overview). The lab result has `status: "error"` with `source: "pagespeed"` and `code: "upstream_error"`, and a message like "PageSpeed Insights could not test the page: … DNS_FAILURE …" or "… FAILED_DOCUMENT_REQUEST …".
- [ ] There is no `performanceScore`, no lab metrics and no audits: nothing is invented.
- [ ] Claude tells you that PSI couldn't reach the page and that perfkit only works for public URLs.
- [ ] Optional: try `http://localhost:3000/` or `https://staging/` as well. These are rejected straight away with `invalid_input` from `source: "perfkit"`, without calling Google.

## Across all scenarios

- [ ] Your API key doesn't appear in any tool result or in Claude's answers.
- [ ] Repeating a prompt within the cache lifetime returns results with `cached: true` and a `cachedAt` time.
- [ ] Every result has `schemaVersion: "1.0.0"`, `provider`, `dataType`, `device` and `collectedAt`.

## Recording results

For each scenario, note pass or fail, the tool calls Claude made, the statuses returned, and anything surprising (for example a key mismatch warning, a redirect warning or a timeout). Leave out the API key and any private URLs.
