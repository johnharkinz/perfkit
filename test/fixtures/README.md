# Saved Google responses

Offline tests serve these files through a fake `fetch`.

**These fixtures are synthetic.** No `GOOGLE_API_KEY` was available when they were written. Each is built from the documented response shapes (CrUX API docs, the CrUX discovery document, and the documented error envelope), with realistic values. Replace each one with a real capture, cleaned of anything sensitive, once a key is available (`LIVE=1 npm run test:live` exercises the same endpoints).

| File                          | Endpoint                                               | Request                                                                                         |
| ----------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `crux/current-url-phone.json` | `chromeuxreport.googleapis.com/v1/records:queryRecord` | `{"url":"https://developer.chrome.com/","formFactor":"PHONE","metrics":[INP,LCP,CLS,FCP,TTFB]}` |

Saved variants of the current endpoint (same documented shapes):

| File                                  | Variant                                                                                          |
| ------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `crux/current-origin-phone.json`      | Origin record: `{"origin":"https://developer.chrome.com","formFactor":"PHONE",...}`              |
| `crux/current-not-found.json`         | 404 body, documented verbatim in the CrUX guide (`chrome ux report data not found`)              |
| `crux/current-url-tablet-no-inp.json` | URL record on TABLET with INP and TTFB absent (Google silently omits metrics it has no data for) |

Other variants (aliases, string p75s, key mismatches, 429/5xx) are derived from these files inside the tests.

When cleaning a real capture: remove any API key, project number or consumer ID, and keep the shape untouched (including CrUX's string-typed CLS values and the TTFB metric name as returned).
