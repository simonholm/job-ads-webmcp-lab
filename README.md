# job-ads-webmcp-lab

A disposable static experiment: can one browser-side operation serve both a
human form and a WebMCP tool? Both entry points call
`async filterJobAds(fromDate, toDate)` in `app.js`. It validates the range,
queries JobTech directly, updates the visible dates/results, and returns the
matching records. Both callers await the same operation.

The search tool is named `get_job_ads` (there is no `search_jobs` alias), with
required `from_date` and `to_date` arguments. It returns a JSON string containing
`from_date`, `to_date`, `total`, and compact `job_ads`, or an `error` message.
The `get_job` tool accepts one `id` from those results and returns selected
full-ad information as a JSON string, or an `error`. Filtering never modifies the underlying
data. Only an explicit form submission or tool call requests data. There are no
API keys, writes, automatic refreshes, or autonomous actions.

## Live JobTech requests

By default, searches use `GET https://jobsearch.api.jobtechdev.se/search` with:

- `published-after=FROMT00:00:00` and `published-before=TOT23:59:59`
- `region=xTCk_nT5_Zjm` (Örebro län)
- `occupation-field=apaJ_2ja_LuF` (Data/IT)
- `sort=pubdate-desc`, `resdet=full`, `limit=100`, and offsets 0, 100, 200…

The form keeps the fixed Örebro län / Data/IT scope. The search tool additionally
accepts optional `q`, `municipality`, `region`, and `occupation_field` strings,
plus `use_default_region` and `use_default_occupation_field` booleans. Both
booleans default to `true`, so a dates-only call sends exactly the original
filters. An explicit region or occupation field overrides its default even if
the corresponding boolean is `false`. Setting a boolean to `false` omits that
default only when no replacement is supplied. Null and blank filter values are
rejected; no omitted-versus-null convention is needed.

`municipality`, `region`, and `occupation_field` use JobTech taxonomy codes.
Municipality and region are independent filters: to search a municipality
outside Örebro län, also set `use_default_region: false`. Adding `q` alone keeps
both defaults; set `use_default_occupation_field: false` for cross-category text
search. `q` searches headlines, descriptions, and employer names using JobTech's
default free-text behavior, including its upstream query enrichment. The demo
adds no relevance heuristics and retains publication-date sorting. All supplied
filters remain on every pagination request. A later form submission uses the
original defaults again.

Requests use
`Accept: application/json`, `credentials: 'omit'`, and normal browser CORS.
JobTech currently permits these requests with `Access-Control-Allow-Origin: *`.
No proxy, backend, polyfill, or `no-cors` workaround is used. See the
[JobTech API schema](https://jobsearch.api.jobtechdev.se/swagger.json).

All pages must arrive before any results are shown. The operation rejects more
than 2,100 matches, changing totals, unexpected page lengths, missing/duplicate
IDs, and invalid publication dates. One 20-second timeout covers the entire
search, including every page and response body. A timeout or failed request
clears results and re-enables the form; there are no automatic retries.

`get_job` uses `GET https://jobsearch.api.jobtechdev.se/ad/{id}` with the same
fetch/header/HTTP/JSON/timeout handling and its own 20-second timeout. IDs are
validated and URL-encoded; a response with a different ID is rejected. It
does not change the form or search results. Returned fields include:

- Existing compact fields: `id`, `headline` (title), `employer` (name),
  `workplace_address` (formatted location), dates, employment type, duration,
  working hours, and `webpage_url` when supplied.
- Full `description`, including `text`, `text_formatted`, `requirements`,
  `conditions`, `needs`, and `company_information` when supplied; no truncation.
- `must_have`, `nice_to_have`, experience/car/licence flags and licence details.
- `application_details`, `application_contacts`, salary information,
  `scope_of_work`, `workplace_model`, and `removed`.

Relevant nested sections retain the JobTech structure; the entire raw response
is not returned. Missing full-ad sections are `null`, and explicit `false`
flags are preserved. Missing compact fields remain omitted, as before.

While searching, the date fields and button are disabled. An overlapping search tool
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

Wait for **WebMCP ready: get_job_ads and get_job registered.** Then, in DevTools Console:

```js
const tools = await document.modelContext.getTools();
const tool = tools.find(tool => tool.name === 'get_job_ads');
console.log(tool); // Inspect the two required date arguments.
const result = await document.modelContext.executeTool(tool, JSON.stringify({
  from_date: '2026-08-28',
  to_date: '2026-08-28'
}));
console.log(JSON.parse(result)); // Live total and records; the page shows those records.

// Broader retrieval, then read a candidate's actual ad before judging relevance.
const broad = JSON.parse(await document.modelContext.executeTool(tool, JSON.stringify({
  from_date: '2026-09-01', to_date: '2026-10-04', q: 'Rust',
  use_default_region: false, use_default_occupation_field: false
})));
if (broad.job_ads?.length) {
  const detailTool = tools.find(tool => tool.name === 'get_job');
  const ad = JSON.parse(await document.modelContext.executeTool(detailTool,
    JSON.stringify({ id: broad.job_ads[0].id })));
  console.log(ad); // Read description.text and all available qualification/application details.
}
```

These are concrete `get_job_ads` argument examples. Every row below also
requires `from_date: "2026-09-01"` and `to_date: "2026-10-04"`, and sends
`published-after=2026-09-01T00:00:00`,
`published-before=2026-10-04T23:59:59`, `limit=100`, `offset=0` (then 100, 200…),
`sort=pubdate-desc`, and `resdet=full`.

| Additional tool arguments | Additional JobTech query parameters |
| --- | --- |
| None | `region=xTCk_nT5_Zjm&occupation-field=apaJ_2ja_LuF` |
| `{"q":"Rust","use_default_occupation_field":false}` | `q=Rust&region=xTCk_nT5_Zjm` |
| `{"q":"Rust","use_default_region":false,"use_default_occupation_field":false}` | `q=Rust` |
| `{"municipality":"muSY_tsR_vDZ","use_default_region":false,"use_default_occupation_field":false}` | `municipality=muSY_tsR_vDZ` (Lund, all occupation fields) |
| `{"region":"CaRE_1nn_cSU","use_default_occupation_field":false}` | `region=CaRE_1nn_cSU` (Skåne län, all occupation fields) |
| `{"use_default_occupation_field":false}` | `region=xTCk_nT5_Zjm` (Örebro län, all occupation fields) |
| `{"occupation_field":"apaJ_2ja_LuF","use_default_region":false}` | `occupation-field=apaJ_2ja_LuF` (Data/IT without a region restriction) |

Then call `get_job` with `{"id":"31545243"}` (an observed live candidate ID;
it can expire). This sends `/ad/31545243`, with no search query parameters.
Choose an ID from the actual returned candidates rather than relying on a saved
example. Broad searches may exceed the existing 2,100-ad ceiling; narrow the
date range or add text/location filters.

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
app.js           Shared search, full-ad retrieval, rendering, two WebMCP registrations
job-ads.json     Six copied compact records, test fixture only
app.test.cjs     Dependency-free Node integration checks using DOM/API doubles
README.md
```

Run `node app.test.cjs` (Node 22+). Tests use DOM/API doubles and no network.
They cover shared human/tool results, query parameters and fixed scope, calendar
validation, empty results, all pagination offsets through 2,000, malformed or
incomplete responses, duplicate IDs, HTTP/network/JSON failures, timeout,
overlapping calls, compact mapping, and unavailable/failed WebMCP registration.
They also cover default and independent broad filters across pages, invalid
filter arguments, search-ID-to-full-ad retrieval (including a non-IT candidate),
selected full-ad fields, sparse ads, safely encoded IDs, invalid/mismatched ad
responses, and detail-request errors/timeouts without changing the search view.
Startup must make zero requests. The test doubles do not prove native browser
support; use the browser steps above for that boundary.

Verified locally with Chrome for Testing 153.0.8010.12 and the experimental web
platform flag: live human and native WebMCP searches for August 1–31, 2026 both
returned the same 28 Örebro län / Data/IT ads. Invalid and empty ranges, the
form with WebMCP unavailable, and a mobile viewport passed. No request loaded
`job-ads.json`. These are observed live counts, not permanent test expectations.
Playwright was used externally for verification, not added as a dependency.

On 2026-10-04, the current script's registered callbacks were also verified
against live JobTech using Node with DOM/WebMCP doubles. September 1–October 4
returned 43 default Örebro/Data-IT ads and 24 nationwide `q=Rust` ads without an
occupation filter. A candidate from each search was retrieved with `get_job`;
the full descriptions matched the endpoint responses (4,893 and 4,617 characters).
Independent `q=Rust` searches in Lund municipality and Skåne län, without an
occupation field, returned 6 and 8 candidates respectively; detail retrieval
also succeeded for both.
This verifies the live retrieval flow, not native browser/agent schema behavior.

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

Structured requirements, salary, application routes, and location details can
be missing, null, or empty. Empty `must_have` / `nice_to_have` lists do not prove
that no qualifications are required: those may exist only in `description.text`.
Some descriptions provide formatted HTML; it is returned as untrusted data,
never inserted into the DOM as HTML. A missing description means the agent
cannot fully assess the ad from this response. A source/ad link is returned only
when supplied, without inventing a fallback. An ad may disappear between search
and retrieval (HTTP 404), or be marked removed. Free-text matches and taxonomy
classification do not establish suitability; agents must read the full ads and
make their own relevance judgment. Other JobTech filters remain unexposed.

Ad text is rendered with `textContent`. The tool is marked read-only, but
intentionally changes the visible view; external ad text is marked untrusted.
WebMCP remains experimental and may change. There is no build step, dependency
installation, background refresh, summary generation, AI integration, semantic
ranking, embeddings, LLM classification, or server-side MCP endpoint.
