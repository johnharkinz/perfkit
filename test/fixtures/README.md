# Saved Google responses

Offline tests serve these files through a fake `fetch`.

**These fixtures are synthetic.** No `GOOGLE_API_KEY` was available when they were written. Each is built from the documented response shapes (CrUX API docs, the CrUX discovery document, and the documented error envelope), with realistic values. Replace each one with a real capture, cleaned of anything sensitive, once a key is available (`LIVE=1 npm run test:live` exercises the same endpoints).

| File                          | Endpoint                                                      | Request                                                                                                                    |
| ----------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `crux/current-url-phone.json` | `chromeuxreport.googleapis.com/v1/records:queryRecord`        | `{"url":"https://developer.chrome.com/","formFactor":"PHONE","metrics":[INP,LCP,CLS,FCP,TTFB]}`                            |
| `crux/history-url-phone.json` | `chromeuxreport.googleapis.com/v1/records:queryHistoryRecord` | `{"url":"https://developer.chrome.com/","formFactor":"PHONE","collectionPeriodCount":40,"metrics":[INP,LCP,CLS,FCP,TTFB]}` |

Saved variants of the current endpoint (same documented shapes):

| File                                  | Variant                                                                                          |
| ------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `crux/current-origin-phone.json`      | Origin record: `{"origin":"https://developer.chrome.com","formFactor":"PHONE",...}`              |
| `crux/current-not-found.json`         | 404 body, documented verbatim in the CrUX guide (`chrome ux report data not found`)              |
| `crux/current-url-tablet-no-inp.json` | URL record on TABLET with INP and TTFB absent (Google silently omits metrics it has no data for) |

The history fixtures are **synthetic** too, built from the documented History API shape (see the CrUX History API docs): `collectionPeriods` oldest first, weekly 28-day windows ending on Saturdays (last window 2026-09-20 to 2026-10-17), and every timeseries the same length as `collectionPeriods`.

| File                               | Variant                                                                                                                                                  |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `crux/history-url-phone-gaps.json` | Null-gap variant: 6 windows (`collectionPeriodCount: 6`) where windows 2 and 5 are missing (p75s `null`, densities `"NaN"`, as CrUX sends missing weeks) |

A history 404 uses `crux/current-not-found.json` (the History API returns the same body).

Other variants (aliases, string p75s, key mismatches, 429/5xx) are derived from these files inside the tests.

When cleaning a real capture: remove any API key, project number or consumer ID, and keep the shape untouched (including CrUX's string-typed CLS values and the TTFB metric name as returned).
