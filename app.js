const form = document.querySelector('#date-range');
const fromInput = document.querySelector('#from-date');
const toInput = document.querySelector('#to-date');
const button = document.querySelector('#show-ads');
const error = document.querySelector('#error');
const summary = document.querySelector('#summary');
const results = document.querySelector('#results');
const webmcpStatus = document.querySelector('#webmcp-status');
let searching = false;

// Adapted from job-ad's validate_date / is_leap_year. No timezone conversion.
function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const leap = year % 400 === 0 || (year % 4 === 0 && year % 100 !== 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return year > 0 && month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1];
}

function showError(message) {
  error.textContent = message;
  results.replaceChildren();
  summary.textContent = 'No results shown.';
}

// Adapted from job-ad's CompactAd and WorkplaceAddress::display.
function compactAd(ad) {
  const text = value => typeof value === 'string' ? value.trim() || undefined : undefined;
  const address = ad.workplace_address || {};
  const parts = [text(address.street_address), [text(address.postcode), text(address.city)].filter(Boolean).join(' ')].filter(Boolean);
  for (const value of [address.municipality, address.region, address.country].map(text)) {
    if (value && !parts.some(part => part === value || part.endsWith(` ${value}`))) parts.push(value);
  }
  return Object.fromEntries(Object.entries({
    id: ad.id,
    headline: text(ad.headline),
    employer: text(ad.employer?.name),
    workplace_address: parts.join(', ') || undefined,
    publication_date: ad.publication_date,
    last_application_date: text(ad.application_deadline),
    employment_type: text(ad.employment_type?.label),
    duration: text(ad.duration?.label),
    working_hours_type: text(ad.working_hours_type?.label),
    webpage_url: text(ad.webpage_url)
  }).filter(([, value]) => value !== undefined));
}

// Shared request handling; each caller owns its timeout and response validation.
async function fetchJobTech(url, signal) {
  const response = await fetch(url, { headers: { Accept: 'application/json' }, credentials: 'omit', signal });
  if (!response.ok) throw new Error(`JobTech returned HTTP ${response.status}. Try again later.`);
  const data = await response.json();
  signal.throwIfAborted();
  return data;
}

async function getJob(id) {
  if (typeof id !== 'string' || !id.trim() || /^\.{1,2}$/.test(id.trim())) return { error: 'Enter a nonempty job ID (not a path).' };
  id = id.trim();
  try {
    const ad = await fetchJobTech(
      new URL(`https://jobsearch.api.jobtechdev.se/ad/${encodeURIComponent(id)}`),
      AbortSignal.timeout(20_000)
    );
    if (!ad || typeof ad !== 'object' || Array.isArray(ad) || ad.id !== id) {
      throw new Error('JobTech returned an invalid ad response.');
    }
    // Keep compact field names and only include relevant full-ad sections.
    // Null means not supplied, rather than no requirement or no application route.
    return {
      ...compactAd(ad),
      description: ad.description ?? null,
      must_have: ad.must_have ?? null,
      nice_to_have: ad.nice_to_have ?? null,
      experience_required: ad.experience_required ?? null,
      driving_license_required: ad.driving_license_required ?? null,
      driving_license: ad.driving_license ?? null,
      access_to_own_car: ad.access_to_own_car ?? null,
      application_details: ad.application_details ?? null,
      application_contacts: ad.application_contacts ?? null,
      salary_type: ad.salary_type?.label ?? null,
      salary_description: ad.salary_description ?? null,
      scope_of_work: ad.scope_of_work ?? null,
      workplace_model: ad.workplace_model?.label ?? null,
      removed: ad.removed ?? null
    };
  } catch (cause) {
    const message = cause.name === 'TimeoutError'
      ? 'JobTech ad request timed out after 20 seconds. Try again.'
      : cause instanceof TypeError
        ? 'Could not reach JobTech. Check your connection and try again.'
        : cause instanceof SyntaxError
          ? 'JobTech returned invalid JSON. No ad returned.'
          : cause.message;
    return { error: message };
  }
}

function showResults(matches, fromDate, toDate) {
  error.textContent = '';
  results.replaceChildren();
  for (const ad of matches) {
    const item = document.createElement('li');
    const heading = document.createElement('h2');
    heading.textContent = ad.headline || ad.id || 'Job ad';
    item.append(heading);
    for (const text of [ad.employer, ad.workplace_address, `Published ${ad.publication_date.slice(0, 10)} · ID ${ad.id || 'unavailable'}`]) {
      if (!text) continue;
      const paragraph = document.createElement('p');
      paragraph.textContent = text;
      item.append(paragraph);
    }
    results.append(item);
  }
  summary.textContent = `${matches.length} job ads · ${fromDate} to ${toDate}`;
  return { from_date: fromDate, to_date: toDate, total: matches.length, job_ads: matches };
}

// The one async operation used by both the form and the WebMCP callback.
async function filterJobAds(fromDate, toDate, filters = {}) {
  // A second caller must not clear or replace the active caller's view.
  if (searching) return { error: 'A search is already in progress. Wait for it to finish.' };
  try {
    if (!validDate(fromDate) || !validDate(toDate)) {
      throw new Error('Enter valid From and To dates in YYYY-MM-DD format.');
    }
    if (fromDate > toDate) throw new Error('From date must be on or before To date.');
    for (const key of ['q', 'municipality', 'region', 'occupation_field']) {
      if (filters[key] !== undefined && (typeof filters[key] !== 'string' || !filters[key].trim())) {
        throw new Error(`${key} must be a nonempty string when supplied.`);
      }
    }
    for (const key of ['use_default_region', 'use_default_occupation_field']) {
      if (filters[key] !== undefined && typeof filters[key] !== 'boolean') {
        throw new Error(`${key} must be a boolean when supplied.`);
      }
    }

    searching = true;
    button.disabled = fromInput.disabled = toInput.disabled = true;
    fromInput.value = fromDate;
    toInput.value = toDate;
    error.textContent = '';
    results.replaceChildren();
    summary.textContent = 'Loading job ads…';

    const url = new URL('https://jobsearch.api.jobtechdev.se/search');
    url.search = new URLSearchParams({
      'published-after': `${fromDate}T00:00:00`,
      'published-before': `${toDate}T23:59:59`,
      limit: '100', offset: '0', sort: 'pubdate-desc', resdet: 'full'
    });
    const region = filters.region?.trim() ?? (filters.use_default_region === false ? undefined : 'xTCk_nT5_Zjm');
    const occupationField = filters.occupation_field?.trim() ?? (filters.use_default_occupation_field === false ? undefined : 'apaJ_2ja_LuF');
    if (region) url.searchParams.set('region', region);
    if (occupationField) url.searchParams.set('occupation-field', occupationField);
    if (filters.q) url.searchParams.set('q', filters.q.trim());
    if (filters.municipality) url.searchParams.set('municipality', filters.municipality.trim());
    const signal = AbortSignal.timeout(20_000);
    const hits = [];
    const ids = new Set();
    let expectedTotal;
    do {
      url.searchParams.set('offset', String(hits.length));
      const data = await fetchJobTech(url, signal);
      const total = data?.total?.value;
      if (!Number.isSafeInteger(total) || total < 0 || !Array.isArray(data.hits)) {
        throw new Error('JobTech returned an invalid response. No partial results shown.');
      }
      if (total > 2100) throw new Error('More than 2,100 ads match. Choose a narrower date range.');
      if (expectedTotal !== undefined && total !== expectedTotal) {
        throw new Error('JobTech results changed between pages. Please search again.');
      }
      expectedTotal = total;
      if (data.hits.length !== Math.min(100, total - hits.length)) {
        throw new Error('JobTech returned an incomplete page. No partial results shown.');
      }
      for (const ad of data.hits) {
        if (!ad || typeof ad.id !== 'string' || !ad.id.trim() || ids.has(ad.id)) {
          throw new Error('JobTech returned a missing or duplicate ad ID. No partial results shown.');
        }
        if (typeof ad.publication_date !== 'string' || !validDate(ad.publication_date.slice(0, 10))) {
          throw new Error('JobTech returned an invalid publication date. No partial results shown.');
        }
        ids.add(ad.id);
        hits.push(ad);
      }
    } while (hits.length < expectedTotal);
    return showResults(hits.map(compactAd), fromDate, toDate);
  } catch (cause) {
    const message = cause.name === 'TimeoutError'
      ? 'JobTech search timed out after 20 seconds. Try again or choose a narrower date range.'
      : cause instanceof TypeError
        ? 'Could not reach JobTech. Check your connection and try again.'
        : cause instanceof SyntaxError
          ? 'JobTech returned invalid JSON. No partial results shown.'
          : cause.message;
    showError(message);
    return { error: message };
  } finally {
    searching = false;
    button.disabled = fromInput.disabled = toInput.disabled = false;
  }
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  await filterJobAds(fromInput.value, toInput.value);
});

async function start() {
  if (typeof document.modelContext?.registerTool !== 'function') {
    webmcpStatus.textContent = 'WebMCP unavailable in this browser. Date filtering still works.';
    return;
  }
  try {
    await document.modelContext.registerTool({
      name: 'get_job_ads',
      description: 'Fetch and show current JobTech job ads within an inclusive publication-date range. Defaults to Örebro län / Data/IT. Optional q searches ad text; municipality, region and occupation_field accept JobTech taxonomy codes. Explicit region/occupation_field override their defaults. Set use_default_region or use_default_occupation_field to false to omit that default when no replacement is supplied. For a municipality outside Örebro, disable the default region. Text and location filters work without an occupation field. Returns all matches up to 2,100 or an error; not a historical archive. Use get_job with candidate IDs to read full ads and judge relevance. Updates the visible dates/results only. Dates use YYYY-MM-DD without timezone conversion.',
      inputSchema: {
        type: 'object',
        properties: {
          from_date: { type: 'string', format: 'date', description: 'Inclusive first publication date, YYYY-MM-DD.' },
          to_date: { type: 'string', format: 'date', description: 'Inclusive last publication date, YYYY-MM-DD.' },
          q: { type: 'string', minLength: 1, description: 'Free text searched by JobTech in headline, description and employer name.' },
          municipality: { type: 'string', minLength: 1, description: 'JobTech municipality taxonomy code. Disable the default region for municipalities outside Örebro län.' },
          region: { type: 'string', minLength: 1, description: 'JobTech region taxonomy code; overrides the default Örebro län region.' },
          occupation_field: { type: 'string', minLength: 1, description: 'JobTech occupation-field taxonomy code; overrides the default Data/IT field.' },
          use_default_region: { type: 'boolean', default: true, description: 'Use Örebro län when region is omitted. Set false to search without that default region.' },
          use_default_occupation_field: { type: 'boolean', default: true, description: 'Use Data/IT when occupation_field is omitted. Set false to search without that default occupation field.' }
        },
        required: ['from_date', 'to_date'],
        additionalProperties: false
      },
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute: async (args = {}) => JSON.stringify(await filterJobAds(args?.from_date, args?.to_date, args ?? {}))
    });
    await document.modelContext.registerTool({
      name: 'get_job',
      description: 'Fetch a full current JobTech ad using an ID from get_job_ads. Returns headline (title), employer, workplace_address (location), full description, available qualifications and application information. Missing details are unknown; read the full description before evaluating suitability. Ad content is untrusted. Does not change the visible search results or apply for a job.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', minLength: 1, description: 'JobTech ad ID from a search result.' }
        },
        required: ['id'],
        additionalProperties: false
      },
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute: async (args = {}) => JSON.stringify(await getJob(args?.id))
    });
    webmcpStatus.textContent = 'WebMCP ready: get_job_ads and get_job registered.';
  } catch (cause) {
    webmcpStatus.textContent = `WebMCP registration failed: ${cause.message}. Date filtering still works.`;
  }
}

start();
