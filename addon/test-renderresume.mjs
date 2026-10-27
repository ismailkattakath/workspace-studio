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
const ctx = createContext({ console });
for (const f of ['LoadJsonResume.gs', 'RenderResume.gs']) {
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
const got = ctx.buildRenderOutputs('a', 'b', 'c', 'd');
check('render returns exactly the declared outputs',
  JSON.stringify(Object.keys(got).sort()) === JSON.stringify(declaredOut),
  `${JSON.stringify(Object.keys(got))} vs ${JSON.stringify(declaredOut)}`);
check('outputs are strings even when given undefined',
  Object.values(ctx.buildRenderOutputs(undefined, null, '', 'x')).every((v) => typeof v === 'string'));
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

// The scope bill IS the design: two scopes, never documents or full drive.
check('scopes are exactly external_request + drive.file',
  JSON.stringify([...manifest.oauthScopes].sort()) === JSON.stringify([
    'https://www.googleapis.com/auth/drive.file',
    'https://www.googleapis.com/auth/script.external_request',
  ]));
check('no DocumentApp or DriveApp call (each one forces a broader scope)',
  !/\b(DocumentApp|DriveApp)\s*\./.test(renderSrc.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')));
check('no Drive/Docs advanced-service call (REST via UrlFetchApp only)',
  !/\b(Drive|Docs)\.[A-Z]/.test(renderSrc.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')));
const services = (manifest.dependencies?.enabledAdvancedServices || []).map((s) => `${s.serviceId}/${s.version}`).sort();
check('Drive v3 + Docs v1 advanced services declared (the 403 fix)',
  JSON.stringify(services) === JSON.stringify(['docs/v1', 'drive/v3']), JSON.stringify(services));

// Allowlist rules (Apps Script manifest reference): https, full domain, a
// non-empty path, and at most one LEADING wildcard.
const allow = manifest.urlFetchWhitelist || [];
check('allowlist entries are https with a path and at most one leading *',
  allow.length > 0 && allow.every((u) => /^https:\/\/(\*\.)?[a-z0-9.-]+\.[a-z]+\/\S*$/.test(u)), JSON.stringify(allow));
for (const url of [ctx.DRIVE_UPLOAD_URL, ctx.DRIVE_FILES_URL + 'x/export']) {
  check(`allowlist covers ${url.split('?')[0]}`, allow.some((p) => url.startsWith(p)));
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
check('name is the h1', f.includes('<h1>Ada Lovelace</h1>'));
check('email becomes a mailto link', f.includes('<a href="mailto:ada@example.com">ada@example.com</a>'));
check('safe URLs become links', f.includes('<a href="https://github.com/ada">GitHub: ada</a>'));
check('open-ended role reads as present', f.includes('1842-01 – present'));
for (const heading of ['Summary', 'Experience', 'Projects', 'Education', 'Skills']) {
  check(`renders the ${heading} section`, f.includes(`<h2>${heading}</h2>`));
}
check('experience comes before education', f.indexOf('<h2>Experience</h2>') < f.indexOf('<h2>Education</h2>'));
for (const heading of ['Awards', 'Certifications', 'Publications', 'Volunteering', 'Languages', 'Interests', 'References']) {
  check(`absent section ${heading} has no heading`, !f.includes(`<h2>${heading}</h2>`));
}
check('an empty section array has no heading', !ctx.resumeToHtml({ basics: { name: 'A' }, awards: [] }).includes('<h2>Awards</h2>'));
check('the document has no external resources', !/<(link|script|img)\b|src=/i.test(f));

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
  console.log(`       ${who}: ${out.length} chars of HTML, ${(out.match(/<h2>/g) || []).length} sections`);
}

console.log();
if (failures.length) { console.log(`${failures.length} FAILED: ${failures.join(', ')}`); process.exit(1); }
console.log('all RenderResume properties hold');
