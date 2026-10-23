# perfkit

perfkit reports web performance evidence for public URLs from Google's PageSpeed Insights and Chrome UX Report, keeping lab and field data strictly apart.

## Language

**Lab data**:
Measurements from a single simulated Lighthouse run performed by PageSpeed Insights.
_Avoid_: Synthetic, Lighthouse data, PSI data

**Field data**:
Real Chrome users' experience of a page or origin over a 28-day window, as published by the Chrome UX Report.
_Avoid_: RUM, real-user data, CrUX data

**Current field data**:
The most recent 28-day window of field data.
_Avoid_: Live data, latest

**Field history**:
A series of up to 40 weekly field data windows, each overlapping its neighbours.
_Avoid_: Weekly samples, trend data

**Device**:
The class of device a measurement applies to: phone, desktop, tablet, or all combined.
_Avoid_: Strategy, form factor

**No data**:
A valid finding that Google publishes no field data for the requested target; not an error.
_Avoid_: Missing, not found, empty

**Scope**:
Whether field data describes a single URL or a whole origin.
_Avoid_: Aggregation level, page-level

**Origin**:
The scheme and host of a URL, with no path, query or fragment; `www.example.com` and `example.com` are different origins.
_Avoid_: Domain, site

**Core Web Vitals**:
Exactly three field metrics: INP, LCP and CLS.
_Avoid_: CWV metrics (when meaning FCP or TTFB too)

**Supporting metric**:
A field metric reported alongside the Core Web Vitals but not one of them: FCP and TTFB.

**Rating**:
The good, needs-improvement or poor classification of a field metric's p75 value against Google's thresholds; lab data is never rated.
_Avoid_: Status, grade, assessment

**Performance score**:
Lighthouse's 0–100 score for a single lab run; never a Core Web Vitals assessment.
_Avoid_: Lighthouse score, PSI score, CWV score
