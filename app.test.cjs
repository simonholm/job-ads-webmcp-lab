const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');

const source = readFileSync(`${__dirname}/app.js`, 'utf8');
const sample = JSON.parse(readFileSync(`${__dirname}/job-ads.json`, 'utf8'));
// Adapt the compact fixture to the nested fields returned by /search.
const ads = sample.map(ad => ({
  id: ad.id, headline: ad.headline, publication_date: ad.publication_date,
  employer: { name: ad.employer }, workplace_address: { street_address: ad.workplace_address },
  application_deadline: ad.last_application_date, employment_type: { label: ad.employment_type },
  duration: { label: ad.duration }, working_hours_type: { label: ad.working_hours_type },
  webpage_url: ad.webpage_url
}));
const response = data => ({ ok: true, json: async () => data });
const searchPage = (total, offset, length = Math.min(100, total - offset)) => ({
  total: { value: total },
  hits: Array.from({ length }, (_, i) => ({ ...ads[0], id: String(offset + i) }))
});

// DOM/API doubles exercise the actual page script; no real network is used.
async function page({ webmcp = false, respond, registrationError = false, timeoutSignal } = {}) {
  const nodes = new Map();
  const calls = [];
  function element() {
    return {
      textContent: '', value: '', disabled: false, children: [], listeners: {},
      append(child) { this.children.push(child); },
      replaceChildren() { this.children = []; },
      addEventListener(name, callback) { this.listeners[name] = callback; }
    };
  }
  const registered = [];
  const document = {
    querySelector(selector) {
      if (!nodes.has(selector)) nodes.set(selector, element());
      return nodes.get(selector);
    },
    createElement: element
  };
  if (webmcp) document.modelContext = {
    async registerTool(tool) {
      if (registrationError) throw new Error('Registration denied');
      registered.push(tool);
    }
  };
  const original = JSON.stringify(ads);
  await vm.runInNewContext(source, {
    document, URL, URLSearchParams, TypeError, SyntaxError,
    AbortSignal: { timeout(ms) {
      assert.equal(ms, 20_000);
      return typeof timeoutSignal === 'function' ? timeoutSignal() : timeoutSignal || new AbortController().signal;
    } },
    fetch: async (url, options) => {
      url = new URL(url);
      assert.equal(url.origin, 'https://jobsearch.api.jobtechdev.se');
      assert.equal(options.credentials, 'omit');
      assert.equal(options.headers.Accept, 'application/json');
      if (url.pathname === '/search') {
        for (const [key, value] of Object.entries({ limit: '100', sort: 'pubdate-desc', resdet: 'full' })) {
          assert.equal(url.searchParams.get(key), value);
        }
      } else {
        assert.match(url.pathname, /^\/ad\/[^/]+$/);
        assert.equal(url.search, '');
      }
      calls.push({ url, signal: options.signal });
      if (respond) return respond(url, options, calls.length);
      const from = url.searchParams.get('published-after');
      const to = url.searchParams.get('published-before');
      const hits = ads.filter(ad => ad.publication_date >= from && ad.publication_date <= to);
      return response({ total: { value: hits.length }, hits });
    }
  });
  return {
    nodes, registered, calls,
    submit(from, to) {
      nodes.get('#from-date').value = from;
      nodes.get('#to-date').value = to;
      return nodes.get('#date-range').listeners.submit({ preventDefault() {} });
    },
    unchanged() { assert.equal(JSON.stringify(ads), original); }
  };
}

test('startup registers without fetching anything; human search works without WebMCP', async () => {
  const p = await page();
  assert.equal(p.calls.length, 0);
  assert.equal(p.nodes.get('#show-ads').disabled, false);
  assert.match(p.nodes.get('#webmcp-status').textContent, /unavailable/);
  await p.submit('2026-08-27', '2026-08-31');
  assert.equal(p.nodes.get('#results').children.length, 6);
  assert.equal(p.calls[0].url.searchParams.get('published-after'), '2026-08-27T00:00:00');
  assert.equal(p.calls[0].url.searchParams.get('published-before'), '2026-08-31T23:59:59');
  await p.submit('2026-08-28', '2026-08-28');
  assert.equal(p.nodes.get('#results').children.length, 3);
  await p.submit('2026-09-01', '2026-09-10');
  assert.equal(p.nodes.get('#results').children.length, 0);
  assert.match(p.nodes.get('#summary').textContent, /^0 job ads/);
  p.unchanged();
});

test('search tool shares human results and retains the compact result contract', async () => {
  const p = await page({ webmcp: true });
  assert.equal(p.calls.length, 0);
  assert.equal(p.registered.length, 2);
  const tool = p.registered[0];
  assert.equal(tool.name, 'get_job_ads');
  assert.deepEqual(Array.from(tool.inputSchema.required), ['from_date', 'to_date']);
  assert.deepEqual(Object.keys(tool.inputSchema.properties), ['from_date', 'to_date', 'q', 'municipality', 'region', 'occupation_field', 'use_default_region', 'use_default_occupation_field']);
  assert.equal(tool.inputSchema.additionalProperties, false);
  assert.equal(tool.annotations.readOnlyHint, true);
  await p.submit('2026-08-28', '2026-08-28');
  const human = JSON.stringify(p.nodes.get('#results').children);
  const result = JSON.parse(await tool.execute({ from_date: '2026-08-28', to_date: '2026-08-28' }));
  assert.equal(result.total, 3);
  assert.deepEqual(result.job_ads, sample.slice(1, 4));
  assert.equal(JSON.stringify(p.nodes.get('#results').children), human);
  await tool.execute({ from_date: '2026-08-31', to_date: '2026-08-31' });
  assert.equal(p.nodes.get('#from-date').value, '2026-08-31');
  assert.equal(p.nodes.get('#to-date').value, '2026-08-31');
  assert.equal(p.nodes.get('#results').children.length, 1);
  p.unchanged();
});

test('invalid/reversed ranges clear stale results without making requests', async () => {
  const p = await page({ webmcp: true });
  for (const [from, to] of [
    ['', '2026-08-31'], ['2026-8-01', '2026-08-31'],
    ['2026-02-29', '2026-03-01'], ['1900-02-29', '1900-03-01'],
    ['2026-04-31', '2026-05-01'], ['0000-01-01', '2026-01-01'],
    ['2026-13-01', '2026-13-02'], ['2026-08-31', '2026-08-27'],
    [undefined, '2026-08-31'], [42, '2026-08-31']
  ]) {
    await p.submit('2026-08-27', '2026-08-31');
    const count = p.calls.length;
    await p.submit(from, to);
    const message = p.nodes.get('#error').textContent;
    assert.ok(message);
    assert.equal(p.nodes.get('#results').children.length, 0);
    assert.equal(JSON.parse(await p.registered[0].execute({ from_date: from, to_date: to })).error, message);
    assert.equal(p.calls.length, count);
  }
  for (const args of [undefined, null, {}]) assert.ok(JSON.parse(await p.registered[0].execute(args)).error);
  await p.submit('2026-08-27', '2026-08-31');
  assert.equal(p.nodes.get('#error').textContent, '');
  assert.equal(p.nodes.get('#results').children.length, 6);
});

test('valid leap days retain unzoned full-day API bounds', async () => {
  const p = await page();
  await p.submit('2000-02-29', '2000-02-29');
  assert.equal(p.calls[0].url.searchParams.get('published-after'), '2000-02-29T00:00:00');
  assert.equal(p.calls[0].url.searchParams.get('published-before'), '2000-02-29T23:59:59');
});

test('pagination gathers all results through offset 2000, keeping filters and one timeout signal', async () => {
  for (const total of [0, 100, 101, 2100]) {
    const p = await page({ respond: url => response(searchPage(total, Number(url.searchParams.get('offset')))) });
    await p.submit('2026-08-27', '2026-08-31');
    assert.equal(p.nodes.get('#results').children.length, total);
    assert.deepEqual(p.calls.map(c => Number(c.url.searchParams.get('offset'))), Array.from({ length: Math.max(1, Math.ceil(total / 100)) }, (_, i) => i * 100));
    for (const call of p.calls) {
      assert.equal(call.signal, p.calls[0].signal);
      assert.equal(call.url.searchParams.get('published-after'), '2026-08-27T00:00:00');
      assert.equal(call.url.searchParams.get('published-before'), '2026-08-31T23:59:59');
      assert.equal(call.url.searchParams.get('region'), 'xTCk_nT5_Zjm');
      assert.equal(call.url.searchParams.get('occupation-field'), 'apaJ_2ja_LuF');
    }
  }
});

test('oversized ranges, changed totals, short pages, duplicate IDs and malformed responses never show partial results', async () => {
  const scenarios = [
    [searchPage(2101, 0)],
    [searchPage(101, 0), searchPage(102, 100)],
    [searchPage(101, 0), searchPage(101, 100, 0)],
    [searchPage(101, 0), { total: { value: 101 }, hits: [{ ...ads[0], id: '0' }] }],
    [null], [{}], [{ total: { value: -1 }, hits: [] }],
    [{ total: { value: '1' }, hits: [ads[0]] }],
    [{ total: { value: 1 }, hits: [null] }],
    [{ total: { value: 1 }, hits: [{ ...ads[0], id: undefined }] }],
    [{ total: { value: 1 }, hits: [{ ...ads[0], publication_date: '2026-02-30' }] }]
  ];
  for (const pages of scenarios) {
    const p = await page({ webmcp: true, respond: (_, __, n) => response(pages[n - 1]) });
    const result = JSON.parse(await p.registered[0].execute({ from_date: '2026-08-27', to_date: '2026-08-31' }));
    assert.ok(result.error);
    assert.equal(p.nodes.get('#results').children.length, 0);
    assert.equal(p.nodes.get('#show-ads').disabled, false);
    assert.equal(p.calls.length, pages.length);
  }
});

test('HTTP, network and JSON failures are visible and recover on the next search', async () => {
  for (const fail of [
    () => ({ ok: false, status: 429 }),
    () => { throw new TypeError('Failed to fetch'); },
    () => ({ ok: true, json: async () => { throw new SyntaxError('Invalid JSON'); } })
  ]) {
    const p = await page({ respond: (_, __, n) => n === 1 ? fail() : response({ total: { value: 6 }, hits: ads }) });
    await p.submit('2026-08-27', '2026-08-31');
    assert.ok(p.nodes.get('#error').textContent);
    assert.equal(p.nodes.get('#results').children.length, 0);
    assert.equal(p.nodes.get('#show-ads').disabled, false);
    await p.submit('2026-08-27', '2026-08-31');
    assert.equal(p.nodes.get('#error').textContent, '');
    assert.equal(p.nodes.get('#results').children.length, 6);
  }
});

test('overlapping tool and form calls cannot issue another request or disturb the active view', async () => {
  let finish;
  const p = await page({ webmcp: true, respond: () => new Promise(resolve => { finish = resolve; }) });
  const active = p.submit('2026-08-27', '2026-08-31');
  assert.equal(p.nodes.get('#show-ads').disabled, true);
  assert.equal(p.nodes.get('#from-date').disabled, true);
  assert.equal(p.nodes.get('#to-date').disabled, true);
  assert.match(p.nodes.get('#summary').textContent, /Loading/);
  const second = JSON.parse(await p.registered[0].execute({ from_date: '2026-08-28', to_date: '2026-08-28' }));
  assert.match(second.error, /already in progress/);
  // Even a programmatic submit bypassing the disabled button cannot race.
  await p.nodes.get('#date-range').listeners.submit({ preventDefault() {} });
  assert.equal(p.calls.length, 1);
  assert.equal(p.nodes.get('#from-date').value, '2026-08-27');
  assert.match(p.nodes.get('#summary').textContent, /Loading/);
  assert.equal(p.nodes.get('#error').textContent, '');
  finish(response({ total: { value: 6 }, hits: ads }));
  await active;
  assert.equal(p.nodes.get('#results').children.length, 6);
  assert.equal(p.nodes.get('#show-ads').disabled, false);
});

test('timeout clears loading, rejects partial results, and permits another request', async () => {
  const controller = new AbortController();
  const p = await page({ webmcp: true,
    timeoutSignal: () => controller.signal.aborted ? new AbortController().signal : controller.signal,
    respond: (_, { signal }, n) => n === 1
      ? new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
      : response({ total: { value: 6 }, hits: ads })
  });
  const active = p.registered[0].execute({ from_date: '2026-08-27', to_date: '2026-08-31' });
  controller.abort(new DOMException('Expired', 'TimeoutError'));
  assert.match(JSON.parse(await active).error, /timed out after 20 seconds/);
  assert.equal(p.nodes.get('#show-ads').disabled, false);
  assert.equal(p.nodes.get('#from-date').disabled, false);
  assert.equal(p.nodes.get('#to-date').disabled, false);
  assert.equal(p.nodes.get('#results').children.length, 0);
  const recovered = JSON.parse(await p.registered[0].execute({ from_date: '2026-08-27', to_date: '2026-08-31' }));
  assert.equal(recovered.total, 6);
  assert.equal(p.nodes.get('#error').textContent, '');
});

test('compact mapping tolerates missing optional fields and deduplicates address components', async () => {
  const ad = { id: '1', publication_date: '2026-08-28T00:00:00', workplace_address: { street_address: ' A ', postcode: '12345', city: 'Örebro', municipality: 'Örebro', region: 'Örebro län', country: 'Sverige' } };
  const p = await page({ webmcp: true, respond: () => response({ total: { value: 1 }, hits: [ad] }) });
  const result = JSON.parse(await p.registered[0].execute({ from_date: '2026-08-28', to_date: '2026-08-28' }));
  assert.deepEqual(result.job_ads[0], { id: '1', publication_date: ad.publication_date, workplace_address: 'A, 12345 Örebro, Örebro län, Sverige' });
});

test('registration failure leaves human search usable', async () => {
  const p = await page({ webmcp: true, registrationError: true });
  assert.match(p.nodes.get('#webmcp-status').textContent, /registration failed/);
  await p.submit('2026-08-27', '2026-08-31');
  assert.equal(p.nodes.get('#results').children.length, 6);
});

test('search result ID retrieves a full ad through the registered get_job tool', async () => {
  const fullAd = {
    ...ads[0],
    description: {
      text: 'Full ad text\nRequires JavaScript. Apply through the employer.',
      text_formatted: '<p>Full ad text</p>', requirements: 'JavaScript experience',
      conditions: 'Hybrid work', company_information: 'A small employer', needs: 'Build web tools'
    },
    must_have: { skills: [{ label: 'JavaScript', concept_id: 'skill-1', weight: 1 }] },
    nice_to_have: { languages: [{ label: 'Swedish', concept_id: 'language-1' }] },
    experience_required: false, driving_license_required: false,
    access_to_own_car: false, driving_license: [],
    application_details: { information: 'Include a CV', reference: 'WEB-1', email: 'jobs@example.org', url: 'https://example.org/apply', via_af: false },
    application_contacts: [{ name: 'Recruiter', email: 'recruiter@example.org' }],
    salary_type: { label: 'Monthly salary' }, salary_description: 'By agreement',
    scope_of_work: { min: 80, max: 100 }, workplace_model: { label: 'Hybrid' }, removed: false,
    logo_url: 'https://example.org/logo.png', irrelevant_internal_field: 'omit me'
  };
  const original = JSON.stringify(fullAd);
  const p = await page({ webmcp: true, respond: url => response(url.pathname === '/search'
    ? { total: { value: 1 }, hits: [ads[0]] } : fullAd) });
  const tool = p.registered.find(tool => tool.name === 'get_job');
  assert.deepEqual(Array.from(tool.inputSchema.required), ['id']);
  assert.deepEqual(Object.keys(tool.inputSchema.properties), ['id']);
  assert.equal(tool.inputSchema.additionalProperties, false);
  assert.equal(tool.annotations.readOnlyHint, true);
  assert.equal(tool.annotations.untrustedContentHint, true);
  assert.match(p.nodes.get('#webmcp-status').textContent, /get_job_ads and get_job registered/);
  const search = JSON.parse(await p.registered[0].execute({ from_date: '2026-08-27', to_date: '2026-08-31' }));
  const view = JSON.stringify([...p.nodes]);
  const detail = JSON.parse(await tool.execute({ id: search.job_ads[0].id }));
  assert.equal(p.calls[1].url.pathname, `/ad/${ads[0].id}`);
  for (const [key, value] of Object.entries(sample[0])) assert.deepEqual(detail[key], value);
  for (const key of ['description', 'must_have', 'nice_to_have', 'experience_required', 'driving_license_required', 'driving_license', 'access_to_own_car', 'application_details', 'application_contacts', 'salary_description', 'scope_of_work', 'removed']) {
    assert.deepEqual(detail[key], fullAd[key]);
  }
  assert.equal(detail.salary_type, 'Monthly salary');
  assert.equal(detail.workplace_model, 'Hybrid');
  assert.equal(detail.logo_url, undefined);
  assert.equal(detail.irrelevant_internal_field, undefined);
  assert.equal(JSON.stringify([...p.nodes]), view);
  assert.equal(JSON.stringify(fullAd), original);
});

test('get_job validates IDs, safely encodes them, and keeps absent details unknown', async () => {
  const id = 'id/with?query#fragment';
  const p = await page({ webmcp: true, respond: () => response({ id, headline: 'Sparse ad' }) });
  const tool = p.registered[1];
  for (const args of [undefined, null, {}, { id: '' }, { id: ' ' }, { id: 123 }, { id: '.' }, { id: '..' }]) {
    assert.match(JSON.parse(await tool.execute(args)).error, /job ID/);
  }
  assert.equal(p.calls.length, 0);
  const detail = JSON.parse(await tool.execute({ id: ` ${id} ` }));
  assert.equal(p.calls[0].url.pathname, `/ad/${encodeURIComponent(id)}`);
  assert.equal(detail.id, id);
  assert.equal(detail.description, null);
  assert.equal(detail.must_have, null);
  assert.equal(detail.nice_to_have, null);
  assert.equal(detail.experience_required, null);
  assert.equal(detail.application_details, null);
});

test('get_job reports HTTP, network, JSON and invalid-ad failures without disturbing search results', async () => {
  for (const fail of [
    () => ({ ok: false, status: 404 }),
    () => ({ ok: false, status: 429 }),
    () => { throw new TypeError('Failed to fetch'); },
    () => ({ ok: true, json: async () => { throw new SyntaxError('Invalid JSON'); } }),
    ...[null, [], {}, { id: 'wrong-id' }].map(ad => () => response(ad))
  ]) {
    let attempts = 0;
    const p = await page({ webmcp: true, respond: url => url.pathname === '/search'
      ? response({ total: { value: 6 }, hits: ads })
      : ++attempts === 1 ? fail() : response(ads[0]) });
    await p.submit('2026-08-27', '2026-08-31');
    const view = JSON.stringify([...p.nodes]);
    assert.ok(JSON.parse(await p.registered[1].execute({ id: ads[0].id })).error);
    assert.equal(JSON.stringify([...p.nodes]), view);
    assert.equal(JSON.parse(await p.registered[1].execute({ id: ads[0].id })).id, ads[0].id);
  }
});

test('get_job timeout covers the response body and permits another request', async () => {
  const controller = new AbortController();
  const p = await page({ webmcp: true,
    timeoutSignal: () => controller.signal.aborted ? new AbortController().signal : controller.signal,
    respond: (_, __, n) => n === 1 ? { ok: true, json: async () => {
      controller.abort(new DOMException('Expired', 'TimeoutError'));
      return ads[0];
    } } : response(ads[0])
  });
  assert.match(JSON.parse(await p.registered[1].execute({ id: ads[0].id })).error, /timed out after 20 seconds/);
  assert.equal(JSON.parse(await p.registered[1].execute({ id: ads[0].id })).id, ads[0].id);
});

test('optional search filters compose independently and preserve defaults only when requested', async () => {
  const scenarios = [
    [{}, { region: 'xTCk_nT5_Zjm', 'occupation-field': 'apaJ_2ja_LuF' }],
    [{ q: 'Rust', use_default_occupation_field: false }, { q: 'Rust', region: 'xTCk_nT5_Zjm' }],
    [{ q: 'Rust', use_default_region: false, use_default_occupation_field: false }, { q: 'Rust' }],
    [{ municipality: 'municipality-code', use_default_region: false, use_default_occupation_field: false }, { municipality: 'municipality-code' }],
    [{ region: 'another-region' }, { region: 'another-region', 'occupation-field': 'apaJ_2ja_LuF' }],
    [{ region: 'another-region', use_default_occupation_field: false }, { region: 'another-region' }],
    [{ use_default_occupation_field: false }, { region: 'xTCk_nT5_Zjm' }],
    [{ q: ' Rust & C++ ', municipality: ' municipality-code ', region: ' custom-region ', occupation_field: ' custom-field ', use_default_region: false, use_default_occupation_field: false },
      { q: 'Rust & C++', municipality: 'municipality-code', region: 'custom-region', 'occupation-field': 'custom-field' }],
    [{ use_default_region: true, use_default_occupation_field: true }, { region: 'xTCk_nT5_Zjm', 'occupation-field': 'apaJ_2ja_LuF' }]
  ];
  for (const [filters, expected] of scenarios) {
    const p = await page({ webmcp: true, respond: url => response(searchPage(101, Number(url.searchParams.get('offset')))) });
    const result = JSON.parse(await p.registered[0].execute({ from_date: '2026-08-27', to_date: '2026-08-31', ...filters }));
    assert.equal(result.total, 101);
    assert.equal(p.calls.length, 2);
    for (const { url } of p.calls) {
      for (const key of ['q', 'municipality', 'region', 'occupation-field']) {
        assert.equal(url.searchParams.get(key), expected[key] ?? null);
      }
    }
    // The form continues to use the original fixed defaults after a broad tool call.
    await p.submit('2026-08-27', '2026-08-31');
    const url = p.calls[2].url;
    assert.equal(url.searchParams.get('region'), 'xTCk_nT5_Zjm');
    assert.equal(url.searchParams.get('occupation-field'), 'apaJ_2ja_LuF');
    assert.equal(url.searchParams.has('q'), false);
    assert.equal(url.searchParams.has('municipality'), false);
  }
});

test('invalid optional filters fail before fetching; null is not a removal control', async () => {
  const p = await page({ webmcp: true });
  for (const key of ['q', 'municipality', 'region', 'occupation_field']) {
    for (const value of [null, '', ' ', 1, false, [], {}]) {
      const result = JSON.parse(await p.registered[0].execute({ from_date: '2026-08-27', to_date: '2026-08-31', [key]: value }));
      assert.match(result.error, new RegExp(key));
    }
  }
  for (const key of ['use_default_region', 'use_default_occupation_field']) {
    for (const value of [null, 'false', 0]) {
      assert.match(JSON.parse(await p.registered[0].execute({ from_date: '2026-08-27', to_date: '2026-08-31', [key]: value })).error, /boolean/);
    }
  }
  assert.equal(p.calls.length, 0);
});

test('broad text search can retrieve a non-IT candidate and then its full ad', async () => {
  const ad = { ...ads[0], occupation_field: { label: 'Industriell tillverkning' }, description: { text: 'Rust programming for industrial control equipment.' } };
  const p = await page({ webmcp: true, respond: url => {
    if (url.pathname === '/search') {
      assert.equal(url.searchParams.get('q'), 'Rust');
      assert.equal(url.searchParams.has('occupation-field'), false);
      return response({ total: { value: 1 }, hits: [ad] });
    }
    return response(ad);
  } });
  const search = JSON.parse(await p.registered[0].execute({ from_date: '2026-08-27', to_date: '2026-08-31', q: 'Rust', use_default_occupation_field: false }));
  const detail = JSON.parse(await p.registered[1].execute({ id: search.job_ads[0].id }));
  assert.equal(detail.description.text, ad.description.text);
});
