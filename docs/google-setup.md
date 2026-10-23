# Google setup

perfkit needs one Google API key, `GOOGLE_API_KEY`, that can call two APIs:

| API                        | Service name                     | Used by                                                                                                                                           |
| -------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **PageSpeed Insights API** | `pagespeedonline.googleapis.com` | `performance_pagespeed`, and the `lab` section of `performance_overview`                                                                          |
| **Chrome UX Report API**   | `chromeuxreport.googleapis.com`  | `performance_crux_current`, `performance_crux_history` (the History API is part of the same API) and the field sections of `performance_overview` |

Both APIs are free. You need a Google account, but no billing account.

## 1. Pick or create a Google Cloud project

1. Open the [Google Cloud console](https://console.cloud.google.com/).
2. Use the project picker at the top to select an existing project, or choose **New project**, name it (for example `perfkit`) and create it.

Quotas apply per project. A dedicated project keeps perfkit's usage separate from anything else you run.

## 2. Enable the two APIs

In the project you chose:

1. Go to **APIs & Services → Library**.
2. Search for **PageSpeed Insights API**, open it and click **Enable**.
3. Search for **Chrome UX Report API**, open it and click **Enable**.

Or, with the `gcloud` CLI:

```bash
gcloud services enable pagespeedonline.googleapis.com chromeuxreport.googleapis.com --project YOUR_PROJECT_ID
```

## 3. Create an API key

1. Go to **APIs & Services → Credentials**.
2. Click **Create credentials → API key**.
3. Copy the key. You will give it to your MCP client as `GOOGLE_API_KEY` (see the [README](../README.md#connect-claude-code)).

## 4. Restrict the key to those two APIs

An unrestricted key can call every API enabled in the project. Restrict it so that a leaked key is worth as little as possible:

1. In **APIs & Services → Credentials**, click the key's name to edit it.
2. Optionally, rename it (for example `perfkit`).
3. Under **API restrictions**, choose **Restrict key**, and select only:
   - **PageSpeed Insights API**
   - **Chrome UX Report API**
4. Under **Application restrictions**, leave **None**. perfkit runs on your machine and calls Google directly, so website (HTTP referrer), Android and iOS restrictions don't apply. An **IP addresses** restriction works only if your public IP is stable.
5. Click **Save**. Changes can take a few minutes to take effect.

Or, with `gcloud`:

```bash
gcloud services api-keys update KEY_ID --project YOUR_PROJECT_ID \
  --api-target=service=pagespeedonline.googleapis.com \
  --api-target=service=chromeuxreport.googleapis.com
```

(`gcloud services api-keys list --project YOUR_PROJECT_ID` shows the `KEY_ID`.)

## 5. Check the key

The quickest end-to-end check is perfkit's own live tests (see the [README](../README.md#live-tests)):

```bash
cp .env.example .env    # then set GOOGLE_API_KEY in .env
LIVE=1 npm run test:live
```

A bad or restricted key shows up as a non-retryable `upstream_error` such as "CrUX API returned HTTP 403." or "PageSpeed Insights returned HTTP 400.". perfkit doesn't pass on Google's message text. If you see one, check that both APIs are enabled in the key's project and selected in its API restrictions. Then wait a few minutes and try again.

## Quotas

- The **Chrome UX Report API** allows 150 queries per minute per project, shared by current and history requests. This quota is free and can't be raised.
- The **PageSpeed Insights API** has per-day and per-minute quotas. See **APIs & Services → PageSpeed Insights API → Quotas & system limits** for your project's values. Calls made without a key share a quota that is usually exhausted, which is why perfkit requires one.

perfkit caches results in memory and retries rate-limited calls a few times with backoff. When a quota runs out anyway, the result is an `upstream_rate_limit` error.

## Keeping the key safe

- perfkit sends the key only in the `X-Goog-Api-Key` request header. It never puts the key in URLs, results, errors or logs.
- Don't commit the key. `.env` is git-ignored, and `.env.example` contains placeholders only.
- If a key leaks, delete or regenerate it in **APIs & Services → Credentials**, then update your MCP client's configuration.
