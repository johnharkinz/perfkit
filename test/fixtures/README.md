# Saved Google responses

Offline tests serve these files through a fake `fetch`.

**These are real responses**, captured on 2026-10-23 with `curl` (key sent in the `X-Goog-Api-Key` header, so no response echoes it). They were checked for API keys, project numbers, consumer IDs, cookies and personal data: none are present. Values are what Google returned that day; tests assert on them, so a recapture means updating those assertions.

## CrUX

Saved exactly as returned (only re-indented):

| File                             | Endpoint                                                      | Request                                                                                                                    |
| -------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `crux/current-url-phone.json`    | `chromeuxreport.googleapis.com/v1/records:queryRecord`        | `{"url":"https://developer.chrome.com/","formFactor":"PHONE","metrics":[INP,LCP,CLS,FCP,TTFB]}`                            |
| `crux/current-origin-phone.json` | `chromeuxreport.googleapis.com/v1/records:queryRecord`        | `{"origin":"https://developer.chrome.com","formFactor":"PHONE","metrics":[...]}`                                           |
| `crux/current-not-found.json`    | `chromeuxreport.googleapis.com/v1/records:queryRecord`        | A URL with no data (`https://developer.chrome.com/perfkit-no-such-page-404/`): HTTP 404                                    |
| `crux/history-url-phone.json`    | `chromeuxreport.googleapis.com/v1/records:queryHistoryRecord` | `{"url":"https://developer.chrome.com/","formFactor":"PHONE","collectionPeriodCount":40,"metrics":[INP,LCP,CLS,FCP,TTFB]}` |

`[INP,LCP,CLS,FCP,TTFB]` is `interaction_to_next_paint`, `largest_contentful_paint`, `cumulative_layout_shift`, `first_contentful_paint`, `experimental_time_to_first_byte`. Shapes as Google sends them: CLS p75s and histogram bounds are strings, other p75s numbers, TTFB is named `experimental_time_to_first_byte`, history windows run oldest first. The History API returns the same 404 body as the current API, so history tests reuse `crux/current-not-found.json`.

Variants derived from the real captures:

| File                                  | Derived from                                                                                                                                                 |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `crux/current-url-tablet-no-inp.json` | A real TABLET URL record (same day) with `interaction_to_next_paint` and `experimental_time_to_first_byte` removed (Google omits metrics it has no data for) |
| `crux/history-url-phone-gaps.json`    | The last 6 windows of `history-url-phone.json`, with windows 2 and 5 blanked as CrUX sends missing weeks (p75s `null`, densities `"NaN"`)                    |

The real capture had no gaps. Other variants (aliases, string p75s, key mismatches, 429/5xx) are derived from these files inside the tests.

## PageSpeed Insights

`psi/runpagespeed-mobile.json` is a real `GET pagespeedonline/v5/runPagespeed?url=https://developer.chrome.com/&strategy=MOBILE&category=PERFORMANCE` response (Lighthouse 13.5.0), trimmed from about 580 KB to under 50 KB:

- Removed `lighthouseResult.entities`, `fullPageScreenshot` and `categoryGroups`, and the `configSettings` keys perfkit does not read.
- Removed the hidden-group audits that only carry large blobs (`screenshot-thumbnails`, `final-screenshot`, `script-treemap-data`, `network-requests`, `main-thread-tasks`, `diagnostics`, `metrics`, `resource-summary`, `network-rtt`, `network-server-latency`) and their `auditRefs`.
- For the other audits, `details` keeps only `type`, `overallSavingsMs` and `overallSavingsBytes` (tables, lists and opportunities keep an empty `items`), since that is all perfkit reads from them.
- `lcp-breakdown-insight`, `cls-culprits-insight` and `layout-shifts` keep their full `details` (element extraction reads them), and `document-latency-insight` keeps its `checklist` details, whose `items` is a keyed object, not an array (the shape that broke the first live run). `debugData` was dropped from these.

Everything else is untouched, including `loadingExperience`/`originLoadingExperience` (tests prove perfkit ignores PSI's embedded field data), `runWarnings`, run metadata, the no-break spaces Lighthouse puts in `displayValue`, and every remaining audit's scores, `metricSavings` and text. Error bodies (`FAILED_DOCUMENT_REQUEST`, 429, `runtimeError`) are built inside the tests from the documented envelopes.

When recapturing: keep the shape untouched, apply the same trim, and strip any URL query parameters that look sensitive.
