/**
 * Tests for the pure half of RenderResume.gs, plus the manifest contract both
 * steps share.
 *
 * Same approach as test-loadjsonresume.mjs. Drive REST, CardService and
 * AddOnsResponseService only exist on Google's servers, so they are verified by
 * installing. resumeToHtml(), the input parser, the URL guards and the output
 * contract are plain JavaScript, and they are where a rendering or injection
 * bug would live.
 *
 * Run: nix run nixpkgs#nodejs -- addon/test-renderresume.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createContext, runInContext } from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const read = (f) => readFileSync(join(here, f), 'utf8');

// BOTH files into ONE context, in manifest order. That is how Apps Script
// loads a project: one shared global scope. RenderResume.gs reuses str(),
// readActionInput(), failStep(), hasAnyKnownSection() and MAX_BYTES from
// LoadJsonResume.gs, so loading it alone would hide a missing dependency.
// CardService is a recording stub: every call returns the stub and is
// logged, so the config cards can be BUILT here and their hint text read.
const cardCalls = [];
const cardStub = new Proxy(function () {}, {
  get: (_t, k) => (k === 'then' ? undefined : (...args) => { cardCalls.push([k, args]); return cardStub; }),
});
// OAuth2 / Properties stubs: a signed-out user with a registered client, so
// onConfigLoadJsonResume takes the "Connect JSON Resume" path offline.
const props = () => ({ getProperty: (k) => (k === 'JR_CLIENT_ID' ? 'test-client' : null), setProperty() {}, deleteProperty() {} });
const oauthService = new Proxy({}, {
  get: (_t, k) => (k === 'hasAccess' ? () => false : k === 'getAuthorizationUrl' ? () => 'https://jsonresume.org/oauth/authorize?x' : () => oauthService),
});
const ctx = createContext({
  console, CardService: cardStub,
  OAuth2: { createService: () => oauthService },
  PropertiesService: { getUserProperties: props, getScriptProperties: props },
  CacheService: { getUserCache: () => ({}) }, LockService: { getUserLock: () => ({}) },
});
let loadGlobals = [];
for (const f of ['LoadJsonResume.gs', 'RenderResume.gs']) {
  if (f === 'RenderResume.gs') loadGlobals = Object.keys(ctx);
  try {
    runInContext(read(f), ctx, { filename: f });
    console.log(`  ok   ${f} parses`);
  } catch (e) {
    console.log(`  FAIL ${f} does not parse — ${e.message}`);
    process.exit(1);
  }
}

const failures = [];
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  ok   ${name}`);
  else { console.log(`  FAIL ${name} ${detail}`); failures.push(name); }
};

// ONE global scope: a function RenderResume.gs redefines would silently
// replace LoadJsonResume.gs's copy in production. Detect it from the source.
const redefined = [...read('RenderResume.gs').matchAll(/^(?:function|var)\s+([A-Za-z_$][\w$]*)/gm)]
  .map((m) => m[1]).filter((n) => loadGlobals.includes(n));
check('RenderResume.gs redefines nothing from LoadJsonResume.gs', redefined.length === 0, JSON.stringify(redefined));

// ---- manifest contract -----------------------------------------------------
const manifest = JSON.parse(read('appsscript.json'));
const elements = manifest.addOns.flows.workflowElements;
const render = elements.find((e) => e.id === 'renderResume');
check('manifest declares the renderResume step', !!render);

// Every callback the manifest names must exist as a global function.
for (const el of elements) {
  for (const fn of [el.workflowAction.onConfigFunction, el.workflowAction.onExecuteFunction]) {
    check(`${el.id}: callback ${fn} is defined`, typeof ctx[fn] === 'function');
  }
}

// The outputs the code returns must be EXACTLY the outputs the manifest
// declares. Studio errors the step otherwise.
const declaredOut = render.workflowAction.outputs.map((o) => o.id).sort();
const got = ctx.buildRenderOutputs('a', 'b');
check('render returns exactly the declared outputs',
  JSON.stringify(Object.keys(got).sort()) === JSON.stringify(declaredOut),
  `${JSON.stringify(Object.keys(got))} vs ${JSON.stringify(declaredOut)}`);
check('outputs are strings even when given undefined',
  Object.values(ctx.buildRenderOutputs(undefined, null)).every((v) => typeof v === 'string'));
check('every output is a STRING scalar',
  render.workflowAction.outputs.every((o) => o.dataType.basicType === 'STRING' && o.cardinality === 'SINGLE'));

// Each card field binds to a manifest input BY NAME. A typo leaves the field
// orphaned, and the value never reaches onExecute.
const renderSrc = read('RenderResume.gs');
const fieldNames = [...renderSrc.matchAll(/setFieldName\('([^']+)'\)/g)].map((m) => m[1]).sort();
const inputIds = render.workflowAction.inputs.map((i) => i.id).sort();
check('every card field matches a manifest input',
  JSON.stringify(fieldNames) === JSON.stringify(inputIds),
  `${JSON.stringify(fieldNames)} vs ${JSON.stringify(inputIds)}`);

// Source with comments removed, so a word in a comment cannot fail or pass a
// check. A line comment starts at `//` NOT preceded by `:`, so the `//` in
// "https://" is code, not a comment. (The first version cut every line at
// "https://", which hid a re-added export call from the check below.)
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

// The scope bill IS the design: two scopes, never documents or full drive.
check('scopes are exactly external_request + drive.file',
  JSON.stringify([...manifest.oauthScopes].sort()) === JSON.stringify([
    'https://www.googleapis.com/auth/drive.file',
    'https://www.googleapis.com/auth/script.external_request',
  ]));
check('no DocumentApp or DriveApp call (each one forces a broader scope)',
  !/\b(DocumentApp|DriveApp)\s*\./.test(stripComments(renderSrc)));
check('no Drive/Docs advanced-service call (REST via UrlFetchApp only)',
  !/\b(Drive|Docs)\.[A-Z]/.test(stripComments(renderSrc)));
const services = (manifest.dependencies?.enabledAdvancedServices || []).map((s) => `${s.serviceId}/${s.version}`).sort();
check('Drive v3 + Docs v1 advanced services declared (the 403 fix)',
  JSON.stringify(services) === JSON.stringify(['docs/v1', 'drive/v3']), JSON.stringify(services));

// Allowlist rules (Apps Script manifest reference): https, full domain, a
// non-empty path, and at most one LEADING wildcard.
const allow = manifest.urlFetchWhitelist || [];
check('allowlist entries are https with a path and at most one leading *',
  allow.length > 0 && allow.every((u) => /^https:\/\/(\*\.)?[a-z0-9.-]+\.[a-z]+\/\S*$/.test(u)), JSON.stringify(allow));
for (const url of [ctx.DRIVE_UPLOAD_URL]) {
  check(`allowlist covers ${url.split('?')[0]}`, allow.some((p) => url.startsWith(p)));
}

// ---- the Doc is the only artifact: export LINKS, no stored PDF ----------
const code = stripComments(renderSrc);
check('no files.export call (nothing is exported or stored)', !/\/export\?mimeType|files\.export|driveExport/i.test(code));
check('nothing is uploaded except the HTML import',
  (code.match(/driveCreate\(/g) || []).length === 2 && /driveCreate\(token, \{ name: title, mimeType: GOOGLE_DOC_MIME \}/.test(code));
check('no pdfFileId output anywhere', !/pdfFileId/.test(code) && !JSON.stringify(manifest).includes('pdfFileId'));
const ID = '1AbC-d_9xYz';
const links = ctx.buildRenderOutputs(ID, 'https://docs.google.com/document/d/' + ID + '/edit');
check('pdfUrl is the Doc\'s own PDF export link',
  links.pdfUrl === `https://docs.google.com/document/d/${ID}/export?format=pdf`, links.pdfUrl);
check('docxUrl is the Doc\'s own DOCX export link',
  links.docxUrl === `https://docs.google.com/document/d/${ID}/export?format=docx`, links.docxUrl);
check('export links are URL-safe (no space, quote, angle, or extra query)',
  [links.pdfUrl, links.docxUrl].every((u) => /^https:\/\/docs\.google\.com\/document\/d\/[A-Za-z0-9_-]+\/export\?format=[a-z]+$/.test(u)));
for (const bad of ['', 'a/b', 'x?format=exe', 'a b', '"><script>', '../../x', undefined, null]) {
  const o = ctx.buildRenderOutputs(bad, '');
  check(`a non-Drive id ${JSON.stringify(bad)} yields NO export links`, o.pdfUrl === '' && o.docxUrl === '');
}

// ---- input parsing ---------------------------------------------------------
check('empty input is an error', !!ctx.parseResumeInput('').error);
check('invalid JSON is an error', !!ctx.parseResumeInput('{nope').error);
check('a JSON array is an error', !!ctx.parseResumeInput('[1,2]').error);
check('an unrelated object is an error', !!ctx.parseResumeInput('{"hello":"world"}').error);
check('a plain resume parses', ctx.parseResumeInput('{"basics":{"name":"A"}}').resume?.basics?.name === 'A');
check('a ```json fence from an AI step is stripped',
  ctx.parseResumeInput('```json\n{"basics":{"name":"A"}}\n```').resume?.basics?.name === 'A');
check('a bare ``` fence is stripped',
  ctx.parseResumeInput('```\n{"work":[]}\n```').resume !== undefined);
check('one fenced block inside prose is taken',
  ctx.parseResumeInput('Here is the tailored resume:\n```json\n{"basics":{"name":"A"}}\n```\nGood luck!').resume?.basics?.name === 'A');
check('two fenced blocks are an error',
  !!ctx.parseResumeInput('```json\n{"basics":{"name":"A"}}\n```\n```json\n{"basics":{"name":"B"}}\n```').error);

// ---- jsonresume.org shape (AI-rewritten input must not drift) ---------------
const shapeErr = (o) => ctx.parseResumeInput(JSON.stringify(o)).error || '';
check('a schema-valid resume passes',
  shapeErr({ basics: { name: 'A' }, work: [{ name: 'X', startDate: '2024-08', endDate: '2026-03-01', highlights: ['h'] }],
    skills: [{ name: 'S', keywords: ['k'] }], education: [{ startDate: '2006', courses: [] }] }) === '');
check('work as an object is rejected', /work must be an array/.test(shapeErr({ work: { name: 'X' } })));
check('a string entry is rejected', /work\[0\] must be an object/.test(shapeErr({ work: ['X'] })));
check('highlights as a string is rejected',
  /work\[0\]\.highlights must be an array of strings/.test(shapeErr({ work: [{ highlights: 'h' }] })));
check('a prose date is rejected',
  /work\[0\]\.startDate must be YYYY/.test(shapeErr({ work: [{ startDate: 'Aug 2024' }] })));
check('an empty endDate (current role) passes', shapeErr({ work: [{ startDate: '2024', endDate: '' }] }) === '');
check('basics.name as a number is rejected', /basics\.name must be a string/.test(shapeErr({ basics: { name: 1 } })));
check('extra unknown keys are allowed', shapeErr({ basics: { name: 'A' }, meta: { x: 1 }, work: [{ foo: 'bar' }] }) === '');
check('problems are capped at 5 with a count',
  /\(and 1 more\)/.test(shapeErr({ work: ['a', 'b', 'c', 'd', 'e', 'f'] })));

// ---- title ------------------------------------------------------------------
check('title defaults to the name', ctx.docTitleFor({ basics: { name: 'Ada' } }, '') === 'Ada — Résumé');
check('configured title wins', ctx.docTitleFor({ basics: { name: 'Ada' } }, ' CV for X ') === 'CV for X');
check('no name falls back to Résumé', ctx.docTitleFor({}, '') === 'Résumé');

// ---- multipart frame -------------------------------------------------------
const frame = ctx.multipartFrame('B', { name: 'n', mimeType: 'm' }, 'text/html; charset=UTF-8');
check('multipart head opens with the boundary and carries metadata',
  frame.head.startsWith('--B\r\nContent-Type: application/json') && frame.head.includes('{"name":"n","mimeType":"m"}'));
check('multipart head ends on the media part headers', frame.head.endsWith('Content-Type: text/html; charset=UTF-8\r\n\r\n'));
check('multipart tail closes the boundary', frame.tail === '\r\n--B--\r\n');

// ---- escaping and URL safety (the résumé is untrusted) --------------------
const hostile = {
  basics: {
    name: '<script>alert(1)</script>',
    label: 'a & b "c" \'d\'',
    email: '"><img src=x onerror=alert(1)>@x.com',
    url: 'javascript:alert(1)',
    image: 'https://tracker.example/pixel.gif',
    profiles: [{ network: 'X', username: 'u', url: 'data:text/html,<b>x</b>' }],
  },
  work: [{ name: 'Evil<iframe>', url: 'https://user:pw@evil.example/', position: 'P', highlights: ['<b>bold</b>'] }],
};
const h = ctx.resumeToHtml(hostile);
check('no raw <script> survives', !h.includes('<script>'));
check('no raw <img> or <iframe> survives', !/<img|<iframe/i.test(h));
check('script text is still visible, escaped', h.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
check('quotes and ampersands are escaped', h.includes('a &amp; b &quot;c&quot; &#39;d&#39;'));
check('javascript: never becomes an href', !/href="javascript:/i.test(h));
check('data: never becomes an href', !/href="data:/i.test(h));
check('credentials-in-URL never become an href', !h.includes('href="https://user:pw@'));
check('an invalid email is not a mailto link', !h.includes('mailto:"'));
check('basics.image is never fetched (no tracking beacon)', !h.includes('tracker.example'));
check('a highlight with markup renders as text', h.includes('&lt;b&gt;bold&lt;/b&gt;'));
check('safeWebUrl accepts https', ctx.safeWebUrl('https://example.com/a?b=c') === 'https://example.com/a?b=c');
check('safeWebUrl accepts an @ in the path', ctx.safeWebUrl('https://medium.com/@me') === 'https://medium.com/@me');
check('safeWebUrl rejects a URL with a quote', ctx.safeWebUrl('https://e.com/"onmouseover=x') === '');
check('safeEmail accepts a normal address', ctx.safeEmail('a.b+c@example.co') === 'a.b+c@example.co');

// ---- structure -------------------------------------------------------------
const full = {
  basics: {
    name: 'Ada Lovelace', label: 'Analyst', email: 'ada@example.com', phone: '+1 555',
    url: 'https://ada.example', summary: 'Wrote the first program.',
    location: { city: 'London', countryCode: 'GB' },
    profiles: [{ network: 'GitHub', username: 'ada', url: 'https://github.com/ada' }],
  },
  work: [{ name: 'Analytical Engine', position: 'Programmer', startDate: '1842-01', highlights: ['Note G'] }],
  education: [{ institution: 'Home', area: 'Mathematics', studyType: 'Tutoring', courses: ['Calculus'] }],
  skills: [{ name: 'Mathematics', level: 'Master', keywords: ['Bernoulli numbers'] }],
  projects: [{ name: 'Notes', description: 'Translation with notes.', url: 'https://notes.example' }],
};
const f = ctx.resumeToHtml(full);
const h2 = (html, heading) => new RegExp(`<h2 style="[^"]*">${heading}</h2>`).test(html);
check('name is the h1', /<h1 style="[^"]*">Ada Lovelace<\/h1>/.test(f));
check('email becomes a mailto link', f.includes('<a href="mailto:ada@example.com">ada@example.com</a>'));
check('safe URLs become links', f.includes('<a href="https://github.com/ada">GitHub: ada</a>'));
check('open-ended role reads as Present, with a month name', f.includes('Jan 1842 – Present'));
for (const heading of ['Summary', 'Experience', 'Projects', 'Education', 'Skills']) {
  check(`renders the ${heading} section`, h2(f, heading));
}
check('experience comes before education', f.indexOf('>Experience</h2>') < f.indexOf('>Education</h2>'));
for (const heading of ['Awards', 'Certifications', 'Publications', 'Volunteering', 'Languages', 'Interests', 'References']) {
  check(`absent section ${heading} has no heading`, !h2(f, heading));
}
check('an empty section array has no heading', !ctx.resumeToHtml({ basics: { name: 'A' }, awards: [] }).includes('>Awards</h2>'));
check('the document has no external resources', !/<(link|script|img)\b|src=/i.test(f));

// ---- live-run findings, 2026-10-27 ----------------------------------------
// #1 LENGTH: every block element carries its own inline font-size. The import
// maps h1-h3 to the Doc's named Heading styles and ignores the body's size.
const blocks = [...f.matchAll(/<(h1|h2|h3|p|li)\b([^>]*)>/g)];
check('every h1/h2/h3/p/li carries an inline font-size',
  blocks.length > 10 && blocks.every((m) => /style="[^"]*font-size:\d/.test(m[2])),
  blocks.filter((m) => !/font-size/.test(m[2])).map((m) => m[0]).join(' '));
const ptOf = (tag) => Number((new RegExp(`<${tag} style="[^"]*font-size:([\\d.]+)pt`).exec(f) || [])[1]);
check('h1 is compact (<= 20pt, not Docs\' default 24pt)', ptOf('h1') > 0 && ptOf('h1') <= 20, String(ptOf('h1')));
check('headings shrink h1 > h2 > h3', ptOf('h1') > ptOf('h2') && ptOf('h2') > ptOf('h3'));
check('every block element sets its margins', blocks.every((m) => /margin:/.test(m[2])));
const margins = ctx.marginRequests(43.2);
const ds = margins[0]?.updateDocumentStyle;
check('margin request sets all four margins in PT',
  ['marginTop', 'marginBottom', 'marginLeft', 'marginRight'].every((k) => ds?.documentStyle[k]?.magnitude === 43.2 && ds.documentStyle[k].unit === 'PT')
  && ds.fields === 'marginTop,marginBottom,marginLeft,marginRight');
// Second live run: a 10.5pt h3 imported as 10pt (half-points round down), so
// every size must be a whole number of points.
const sizes = [...f.matchAll(/font-size:([\d.]+)pt/g)].map((m) => m[1]);
check('every font-size is a whole number of points', sizes.length > 0 && sizes.every((s) => /^\d+$/.test(s)),
  sizes.filter((s) => !/^\d+$/.test(s)).join(','));
check('blocks use single line spacing', blocks.every((m) => /line-height:1\.0;/.test(m[2])));
const ns = ctx.namedStyleRequests()[0]?.updateNamedStyle;
check('Normal text named style: 10pt, single spacing, no paragraph gaps',
  ns?.namedStyle.namedStyleType === 'NORMAL_TEXT'
  && ns.namedStyle.textStyle.fontSize.magnitude === 10 && ns.namedStyle.textStyle.fontSize.unit === 'PT'
  && ns.namedStyle.paragraphStyle.lineSpacing === 100
  && ns.namedStyle.paragraphStyle.spaceAbove.magnitude === 0 && ns.namedStyle.paragraphStyle.spaceBelow.magnitude === 0
  && ns.fields === 'namedStyleType,textStyle.fontSize,paragraphStyle.lineSpacing,paragraphStyle.spaceAbove,paragraphStyle.spaceBelow');
// LIVE RUN 3 (2026-10-27): HTTP 400 "Named style type is required". The API
// requires namedStyleType in the mask AND on the namedStyle object.
const mask = String(ns?.fields || '').split(',');
check('updateNamedStyle mask names namedStyleType first', mask[0] === 'namedStyleType', ns?.fields);
check('updateNamedStyle carries namedStyle.namedStyleType', ns?.namedStyle?.namedStyleType === 'NORMAL_TEXT');
check('updateNamedStyle mask has only leaf paths (a parent resets its children)',
  mask.every((p) => p === 'namedStyleType' || /^(textStyle|paragraphStyle)\.\w+$/.test(p)), ns?.fields);
check('every masked leaf is actually set on the request',
  mask.filter((p) => p !== 'namedStyleType').every((p) => p.split('.').reduce((o, k) => o?.[k], ns.namedStyle) !== undefined));
check('allowlist covers the Docs batchUpdate URL', allow.some((p) => (ctx.DOCS_API_URL + 'x:batchUpdate').startsWith(p)));

// #2 HEADLINE WRAP: dates live on their own small line, never inside the h3.
const h3s = [...f.matchAll(/<h3[^>]*>([\s\S]*?)<\/h3>/g)].map((m) => m[1]);
check('no h3 contains a date', h3s.length > 0 && h3s.every((t) => !/\d{4}/.test(t)), JSON.stringify(h3s));
check('dates sit on the grey meta line right under the h3',
  /<\/h3><p style="[^"]*color:#555555[^"]*">Jan 1842 – Present<\/p>/.test(f));

// #3 DATES: ISO to "Mon YYYY", unparseable strings untouched.
for (const [inp, want] of [['2024', '2024'], ['2024-08', 'Aug 2024'], ['2024-08-01', 'Aug 2024'],
  [' 2026-03-01 ', 'Mar 2026'], ['2024-12-31', 'Dec 2024'], ['2024-13', '2024-13'], ['2024-00', '2024-00'],
  ['2024-02-45', '2024-02-45'], ['Summer 2019', 'Summer 2019'], ['', ''], [undefined, ''], [2024, '2024']]) {
  check(`formatDate(${JSON.stringify(inp)}) = ${JSON.stringify(want)}`, ctx.formatDate(inp) === want, JSON.stringify(ctx.formatDate(inp)));
}
check('a full range reads "Aug 2024 – Mar 2026"', ctx.dateRange('2024-08-01', '2026-03-01') === 'Aug 2024 – Mar 2026');
check('an open range ends in Present', ctx.dateRange('2024-08', '') === 'Aug 2024 – Present');
check('an end date alone is shown alone', ctx.dateRange('', '2020') === '2020');
check('single dates are formatted (certificates)',
  ctx.resumeToHtml({ certificates: [{ name: 'CKA', date: '2023-05-02' }] }).includes('May 2023'));

// #4 EDUCATION: studyType and area joined with a comma.
check('education joins studyType and area with ", "', f.includes('Tutoring, Mathematics'));

// Compact skills: one paragraph per group, no h3.
check('skills render as one compact paragraph, not an h3',
  /<p style="[^"]*"><b>Mathematics — Master<\/b>: Bernoulli numbers<\/p>/.test(f) && !h3s.some((t) => t.includes('Mathematics — Master')));

// The registry 301s to jsonresume.org (measured 2026-10-27:
// registry.jsonresume.org/{user}.json -> jsonresume.org/@{user}.json), and
// UrlFetchApp follows it, so the redirect target must be allowlisted too.
check('allowlist covers the registry redirect target', allow.includes('https://jsonresume.org/'));

// #5 PROJECT TYPE: the raw enum is not printed.
const proj = ctx.resumeToHtml({ projects: [{ name: 'X', type: 'application', roles: ['Lead'] }] });
check('project type enum is dropped', !proj.includes('application'));
check('project roles still show', proj.includes('Lead'));

// #6/#7 CARD HINTS: Studio renders hint text as HTML, so an <angle>
// placeholder vanishes. Build both cards through the stub and read the text.
ctx.jsonResumeConnectCard();
ctx.onConfigLoadJsonResume();
ctx.onConfigRenderResume();
const hints = cardCalls.filter(([k]) => k === 'setHint' || k === 'setTitle').map(([, a]) => String(a[0]));
check('card hints were captured', hints.length >= 2, String(hints.length));
check('no card hint or title contains "<"', hints.every((h) => !h.includes('<')), JSON.stringify(hints.filter((h) => h.includes('<'))));

// LOAD IS CONNECT-ONLY (operator decision, 2026-10-27): one source, the
// signed-in jsonresume.org account. No URL, paste or Drive input survives.
const loadEl = elements.find((e) => e.id === 'loadJsonResume');
check('Load declares no inputs', loadEl.workflowAction.inputs.length === 0);
check('the connect card says to refresh, in bold, without a link',
  cardCalls.some(([k, a]) => k === 'setText' && String(a[0]) === 'After connecting, <b>refresh</b> this page.'));
check('the connect card offers "Connect JSON Resume" through an AuthorizationAction',
  cardCalls.some(([k, a]) => k === 'setText' && a[0] === 'Connect JSON Resume') &&
  cardCalls.some(([k]) => k === 'setAuthorizationAction'));
check('the allowlist is jsonresume.org plus Google APIs only',
  JSON.stringify([...allow].sort()) === JSON.stringify(['https://docs.googleapis.com/', 'https://jsonresume.org/', 'https://www.googleapis.com/']),
  JSON.stringify(allow));
check('the /api/oauth/resume wrapper is unwrapped',
  ctx.unwrapResumePayload({ username: 'u', url: 'x', resume: { basics: { name: 'A' } } }).resume.basics.name === 'A' &&
  ctx.unwrapResumePayload({ username: 'u', resume: {} }).username === 'u');
check('a bare resume body passes through unwrapped',
  ctx.unwrapResumePayload({ basics: { name: 'B' } }).resume.basics.name === 'B');

// #6/#8 MANIFEST TEXT: no "<" anywhere, and output descriptions short enough
// to read as a variable chip ("Step 2: Doc URL").
const texts = [];
for (const e of elements) {
  texts.push(e.description);
  for (const io of [...e.workflowAction.inputs, ...e.workflowAction.outputs]) texts.push(io.description);
}
check('no manifest description contains "<"', texts.every((t) => !t.includes('<')));
check('no manifest description promises "any HTTPS URL"', texts.every((t) => !/any HTTPS URL/i.test(t)));
const outDescs = elements.flatMap((e) => e.workflowAction.outputs.map((o) => o.description));
check('output descriptions are chip-sized (<= 24 chars, no sentence)',
  outDescs.every((d) => d.length <= 24 && !d.endsWith('.')), JSON.stringify(outDescs));

// ---- degenerate inputs must not throw, and must not leak undefined/null ----
for (const [label, value] of [['empty object', {}], ['nulls', { basics: null, work: null }],
  ['wrong types', { basics: 'x', work: 'y', skills: 42 }],
  ['array items that are not objects', { work: ['a', null, 3], skills: [[1]] }],
  ['entries with no fields', { work: [{}], education: [{}], skills: [{}] }]]) {
  try {
    const out = ctx.resumeToHtml(value);
    check(`degenerate: ${label}`, !/undefined|null/.test(out), out.slice(0, 200));
  } catch (e) { check(`degenerate: ${label}`, false, e.message); }
}

// ---- real resumes from the live registry (skipped in the no-network sandbox)
for (const who of ['thomasdavis', 'jsonresume']) {
  let resume;
  try {
    const r = await fetch(`https://registry.jsonresume.org/${who}.json`, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) { console.log(`  skip registry/${who} (HTTP ${r.status})`); continue; }
    resume = await r.json();
  } catch (e) {
    console.log(`  skip registry/${who} (${e.message})`);
    continue;
  }
  const out = ctx.resumeToHtml(resume);
  check(`registry/${who}: renders non-trivial HTML`, out.length > 1000, `len=${out.length}`);
  check(`registry/${who}: no undefined/null leaked`, !/undefined|>null</.test(out));
  check(`registry/${who}: name is present`, !resume.basics?.name || out.includes(ctx.escapeHtml(resume.basics.name)));
  check(`registry/${who}: no script tag`, !/<script/i.test(out));
  console.log(`       ${who}: ${out.length} chars of HTML, ${(out.match(/<h2 /g) || []).length} sections`);
}

console.log();
if (failures.length) { console.log(`${failures.length} FAILED: ${failures.join(', ')}`); process.exit(1); }
console.log('all RenderResume properties hold');
