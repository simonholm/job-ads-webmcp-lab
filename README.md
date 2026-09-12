# job-ads-webmcp-lab

A disposable static experiment: can one browser-side operation serve both a
human form and a WebMCP tool? Both entry points call
`async filterJobAds(fromDate, toDate)` in `app.js`. It validates the range,
queries JobTech directly, updates the visible dates/results, and returns the
matching records. Both callers await the same operation.

There is exactly one tool, `get_job_ads`, with required `from_date` and `to_date`
arguments. It returns a JSON string containing `from_date`, `to_date`, `total`,
and `job_ads`, or an `error` message. Filtering never modifies the underlying
data. Only an explicit form submission or tool call requests data. There are no
API keys, writes, automatic refreshes, or autonomous actions.

## Live JobTech requests

Every search uses `GET https://jobsearch.api.jobtechdev.se/search` with:

- `published-after=FROMT00:00:00` and `published-before=TOT23:59:59`
- `region=xTCk_nT5_Zjm` (Örebro län)
- `occupation-field=apaJ_2ja_LuF` (Data/IT)
- `sort=pubdate-desc`, `resdet=full`, `limit=100`, and offsets 0, 100, 200…

The scope is fixed; there are no geographic or category controls. Requests use
`Accept: application/json`, `credentials: 'omit'`, and normal browser CORS.
JobTech currently permits these requests with `Access-Control-Allow-Origin: *`.
No proxy, backend, polyfill, or `no-cors` workaround is used. See the
[JobTech API schema](https://jobsearch.api.jobtechdev.se/swagger.json).

All pages must arrive before any results are shown. The operation rejects more
than 2,100 matches, changing totals, unexpected page lengths, missing/duplicate
IDs, and invalid publication dates. One 20-second timeout covers the entire
search, including every page and response body. A timeout or failed request
clears results and re-enables the form; there are no automatic retries.

While searching, the date fields and button are disabled. An overlapping tool
call returns an error without starting another request or disturbing the active
search. The tool registers even when JobTech is offline; request errors are
reported when a search is attempted.

## Run locally

From this directory:

```sh
python3 -m http.server 8000 --bind 127.0.0.1
```

Open <http://127.0.0.1:8000>. Python only serves files; there is no application
backend. Use HTTP instead of opening `index.html` as a `file://` URL, because the
page loads JSON with `fetch`.

Select dates and press **Show job ads**. Both end dates are inclusive, based on
the full-day API bounds above, without a timezone suffix or conversion. Live
counts can change as ads expire or are removed. The following are deterministic
expectations only for the six-record fixture used by the tests:

| From | To | Expected |
| --- | --- | --- |
| 2026-08-27 | 2026-08-31 | 6 ads |
| 2026-08-28 | 2026-08-28 | 3 ads |
| 2026-08-31 | 2026-08-31 | 1 ad |
| 2026-09-01 | 2026-09-10 | 0 ads |
| 2026-08-31 | 2026-08-27 | Clear error; previous results cleared |

Blank dates and impossible dates such as `2026-02-29` are also rejected. Human
and tool calls use the same validation. A valid call after an error recovers
normally.

## Browser requirements and WebMCP testing

Ordinary filtering works in modern browsers without WebMCP. This experiment
targets the experimental **`document.modelContext`** API documented on
2026-09-10. It includes no polyfill or legacy `navigator.modelContext` adapter.
The page reports unsupported browsers and registration failures without
disabling ordinary filtering.

Use an up-to-date Chrome build (Canary if necessary) with the current API.
Enable `chrome://flags/#enable-webmcp-testing`, relaunch, and open the page as a
top-level tab on localhost or HTTPS. WebMCP requires an origin-isolated document;
do not opt out using `Origin-Agent-Cluster: ?0`. Chrome also documents an origin
trial from version 149. See [Chrome's WebMCP setup guide](https://developer.chrome.com/docs/ai/webmcp/).
Version 149 alone does not guarantee the current API shape.

Wait for **WebMCP ready: get_job_ads registered.** Then, in DevTools Console:

```js
const tools = await document.modelContext.getTools();
const tool = tools.find(tool => tool.name === 'get_job_ads');
console.log(tool); // Inspect the two required date arguments.
const result = await document.modelContext.executeTool(tool, JSON.stringify({
  from_date: '2026-08-28',
  to_date: '2026-08-28'
}));
console.log(JSON.parse(result)); // Live total and records; the page shows those records.
```

Repeat with a reversed range and an impossible date. Expect an error and no
stale results; the browser may reject schema-invalid arguments before calling
the handler. `getTools` and `executeTool` follow
[Chrome's current imperative API](https://developer.chrome.com/docs/ai/webmcp/imperative-api).

Alternatively, use the [Model Context Tool Inspector](https://chromewebstore.google.com/detail/model-context-tool-inspec/gbpdfapgefenggkahomfgkhfehlcenpd)
linked by Chrome to discover and manually invoke `get_job_ads`. This manual
path needs no AI model. For a compatible browser agent, ask:
“Use get_job_ads to show ads published from 2026-08-28 through 2026-08-28.”
Confirm an actual tool invocation, returned records, and matching visible
results. Agent availability/configuration is external to this repository.

## Reused from job-ad

- The first six records of `job-ad/orebro-data-it-august.json`, copied on
  2026-09-10, retain the existing `--compact` field names and values. These are
  JobTech ads from Örebro län / Data/IT, published August 27–31, 2026.
- Calendar validation and leap-year handling adapted from `validate_date` and
  `is_leap_year` in `job-ad/src/main.rs`, inspected at commit
  `d9ae808a1461bad357a1329987865c35ac9aed10`. This page additionally rejects year
  zero to match HTML date inputs.
- Inclusive publication-date query parameters, fixed scope IDs, pagination
  completeness checks, and compact field/address mapping from `job-ad range`.

The original CLI has no webpage styles to reuse. The small HTML/CSS is new.
There are no imports, symlinks, or runtime dependencies on the original repo.

`job-ads.json` is retained only as an offline test fixture. The runtime never
loads it and never silently falls back to sample results when JobTech fails.
Tests adapt its compact fields to the nested JobTech response shape.

## Files and checks

```text
index.html       Date-range form and results
style.css        Minimal layout
app.js           Shared operation, rendering, and one WebMCP registration
job-ads.json     Six copied compact records, test fixture only
app.test.cjs     Dependency-free Node integration checks using DOM/API doubles
README.md
```

Run `node app.test.cjs` (Node 22+). Tests use DOM/API doubles and no network.
They cover shared human/tool results, query parameters and fixed scope, calendar
validation, empty results, all pagination offsets through 2,000, malformed or
incomplete responses, duplicate IDs, HTTP/network/JSON failures, timeout,
overlapping calls, compact mapping, and unavailable/failed WebMCP registration.
Startup must make zero requests. The test doubles do not prove native browser
support; use the browser steps above for that boundary.

Verified locally with Chrome for Testing 153.0.8010.12 and the experimental web
platform flag: live human and native WebMCP searches for August 1–31, 2026 both
returned the same 28 Örebro län / Data/IT ads. Invalid and empty ranges, the
form with WebMCP unavailable, and a mobile viewport passed. No request loaded
`job-ads.json`. These are observed live counts, not permanent test expectations.
Playwright was used externally for verification, not added as a dependency.

## GitHub Pages and limitations

The publishing destination is the existing site's `/job-ads-webmcp/` directory.
After review and approval, copy only the updated `app.js` and `index.html` into
that directory in `simonholm.github.io`. Its existing `style.css` and unused
`job-ads.json` need no change. Do not change the homepage, `/webmcp/`, or Pages
settings. The lab remains independent; there is no cross-repository import or
automated deployment. Relative asset paths work under the subpage prefix.

JobSearch contains current ads, not a complete historical archive. Old date
ranges can lose matches over time. Pagination checks detect common inconsistencies
but cannot guarantee a transactional snapshot of a changing upstream dataset.
Oversized or slow searches must be narrowed; the experiment does not split dates
to bypass the API ceiling. Network availability and CORS policy are controlled
by JobTech. Internet access is required for searches.

Ad text is rendered with `textContent`. The tool is marked read-only, but
intentionally changes the visible view; external ad text is marked untrusted.
WebMCP remains experimental and may change. There is no build step, dependency
installation, background refresh, keyword/company search, summary generation,
AI integration, extra tool, or server-side MCP endpoint.
