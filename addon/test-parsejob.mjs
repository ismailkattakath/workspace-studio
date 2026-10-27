/**
 * Tests for the pure half of ParseJobDescription.gs: the job-schema gate, the
 * reply address and subject, and its manifest contract.
 *
 * Same approach as test-renderresume.mjs: every .gs file into ONE context, as
 * Apps Script loads a project. ParseJobDescription.gs reuses
 * parseJsonObjectInput(), isPlainObject(), joinNonEmpty() and ISO8601_PARTIAL
 * from RenderResume.gs, and str() / readActionInput() / failStep() from
 * LoadJsonResume.gs.
 *
 * Run: nix run nixpkgs#nodejs -- addon/test-parsejob.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createContext, runInContext } from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const read = (f) => readFileSync(join(here, f), 'utf8');

const stub = new Proxy(function () {}, {
  get: (_t, k) => (k === 'then' ? undefined : () => stub),
});
const ctx = createContext({ console, CardService: stub, AddOnsResponseService: stub });
let earlierGlobals = [];
for (const f of ['LoadJsonResume.gs', 'RenderResume.gs', 'ParseJobDescription.gs']) {
  if (f === 'ParseJobDescription.gs') earlierGlobals = Object.keys(ctx);
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

const src = read('ParseJobDescription.gs');
const redefined = [...src.matchAll(/^(?:function|var)\s+([A-Za-z_$][\w$]*)/gm)]
  .map((m) => m[1]).filter((n) => earlierGlobals.includes(n));
check('ParseJobDescription.gs redefines nothing from the other files', redefined.length === 0, JSON.stringify(redefined));

// ---- manifest contract -----------------------------------------------------
const manifest = JSON.parse(read('appsscript.json'));
const el = manifest.addOns.flows.workflowElements.find((e) => e.id === 'parseJobDescription');
check('manifest declares the parseJobDescription step', !!el);
for (const fn of [el.workflowAction.onConfigFunction, el.workflowAction.onExecuteFunction]) {
  check(`callback ${fn} is defined`, typeof ctx[fn] === 'function');
}
const fieldNames = [...src.matchAll(/setFieldName\('([^']+)'\)/g)].map((m) => m[1]).sort();
check('every card field matches a manifest input',
  JSON.stringify(fieldNames) === JSON.stringify(el.workflowAction.inputs.map((i) => i.id).sort()));

// The variable map onExecute builds must name exactly the declared outputs.
const mapKeys = [...src.matchAll(/^\s{4}(\w+): AddOnsResponseService\.newVariableData\(\)/gm)].map((m) => m[1]).sort();
const declared = el.workflowAction.outputs.map((o) => o.id).sort();
check('onExecute returns exactly the declared outputs', JSON.stringify(mapKeys) === JSON.stringify(declared),
  `${JSON.stringify(mapKeys)} vs ${JSON.stringify(declared)}`);
const replyOut = el.workflowAction.outputs.find((o) => o.id === 'replyTo');
check('replyTo is an EMAIL_ADDRESS output (Draft an email\'s To only offers those)',
  replyOut?.dataType.basicType === 'EMAIL_ADDRESS');
check('replyTo is filled with addEmailAddress', /replyTo: AddOnsResponseService\.newVariableData\(\)\.addEmailAddress\(/.test(src));
check('buildJobOutputs keys equal the declared outputs',
  JSON.stringify(Object.keys(ctx.buildJobOutputs({ title: 't' }, { email: 'a@b.co' })).sort()) === JSON.stringify(declared));

// ---- the schema gate --------------------------------------------------------
const good = {
  job: {
    title: 'Senior Data Platform Engineer', company: 'Contoso Analytics', type: 'Contract',
    date: '2026-10-15', remote: 'Full', salary: 'CAD 170,000 - 190,000',
    location: { city: 'Ottawa', countryCode: 'CA' },
    responsibilities: ['Operate Kafka and Flink pipelines on GCP'],
    qualifications: ['6+ years in data engineering'],
    skills: [{ name: 'Python', keywords: ['dbt'] }, { name: 'BigQuery' }],
  },
  source: { email: 'jane@contoso.example', subject: 'Senior Data Platform Engineer role' },
};
const ok = ctx.parseJobInput(JSON.stringify(good));
check('a schema-valid posting parses', !ok.error && ok.job.title === good.job.title, JSON.stringify(ok.error));
check('a ```json fence is stripped', !ctx.parseJobInput('```json\n' + JSON.stringify(good) + '\n```').error);
check('one fenced block inside prose is accepted',
  !ctx.parseJobInput('Here it is:\n```json\n' + JSON.stringify(good) + '\n```\nDone.').error);

const bad = (name, mutate, expect) => {
  const v = structuredClone(good);
  mutate(v);
  const r = ctx.parseJobInput(JSON.stringify(v));
  check(name, !!r.error && (!expect || expect.test(r.error)), JSON.stringify(r));
};
bad('missing title fails', (v) => { delete v.job.title; }, /title is required/);
bad('remote as a boolean fails (Gemini did this live)', (v) => { v.job.remote = true; }, /remote must be a string/);
bad('responsibilities as a string fails', (v) => { v.job.responsibilities = 'lots'; }, /responsibilities must be an array of strings/);
bad('a skill as a bare string fails', (v) => { v.job.skills = ['Python']; }, /skills\[0\] must be an object/);
bad('skill keywords as a string fails', (v) => { v.job.skills[0].keywords = 'dbt'; }, /keywords must be an array/);
bad('location as a string fails', (v) => { v.job.location = 'Ottawa'; }, /location must be an object/);
bad('a free-text date fails', (v) => { v.job.date = 'last week'; }, /date must be/);
bad('no responsibilities, qualifications or skills fails',
  (v) => { delete v.job.responsibilities; delete v.job.qualifications; delete v.job.skills; }, /at least one/);
bad('no source email fails', (v) => { delete v.source; }, /source\.email/);
bad('a display-name source fails', (v) => { v.source.email = 'Jane <jane@contoso.example>'; }, /source\.email/);
bad('two addresses fail', (v) => { v.source.email = 'a@b.co, c@d.co'; }, /source\.email/);
check('no "job" object fails', /no "job" object/.test(ctx.parseJobInput('{"title":"x"}').error || ''));
check('empty input fails', !!ctx.parseJobInput('').error);
check('not JSON fails', !!ctx.parseJobInput('not json').error);
check('extra keys are allowed, as in the schema', (() => {
  const v = structuredClone(good); v.job.meta = { x: 1 }; v.job.benefits = ['dental'];
  return !ctx.parseJobInput(JSON.stringify(v)).error;
})());

// ---- reply subject ----------------------------------------------------------
const subj = (s, job = good.job) => ctx.buildJobOutputs(job, { email: 'a@b.co', subject: s }).replySubject;
check('subject gets a Re: prefix', subj('Senior role') === 'Re: Senior role');
check('an existing Re: is not doubled', subj('RE: Senior role') === 'RE: Senior role');
check('no subject falls back to title at company', subj('') === 'Re: Senior Data Platform Engineer at Contoso Analytics');
check('no subject, no company falls back to title', subj('', { title: 'Engineer' }) === 'Re: Engineer');
check('job output round-trips as JSON', JSON.parse(ctx.buildJobOutputs(good.job, good.source).job).company === 'Contoso Analytics');

if (failures.length) {
  console.log(`\n${failures.length} FAILED`);
  process.exit(1);
}
console.log('\nall passed');
