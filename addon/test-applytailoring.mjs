/**
 * Tests for the pure half of ApplyTailoring.gs: the patch is the ONLY way the
 * resume changes, and it can only touch headline, summary, highlights and skill
 * order. Same approach as the other suites: every .gs file in one context.
 *
 * Run: nix run nixpkgs#nodejs -- addon/test-applytailoring.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createContext, runInContext } from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const read = (f) => readFileSync(join(here, f), 'utf8');

const stub = new Proxy(function () {}, { get: (_t, k) => (k === 'then' ? undefined : () => stub) });
const ctx = createContext({ console, CardService: stub, AddOnsResponseService: stub });
let earlier = [];
for (const f of ['LoadJsonResume.gs', 'RenderResume.gs', 'ParseJobDescription.gs', 'ApplyTailoring.gs']) {
  if (f === 'ApplyTailoring.gs') earlier = Object.keys(ctx);
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

const src = read('ApplyTailoring.gs');
const redefined = [...src.matchAll(/^(?:function|var)\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]).filter((n) => earlier.includes(n));
check('ApplyTailoring.gs redefines nothing from the other files', redefined.length === 0, JSON.stringify(redefined));

// ---- manifest contract -----------------------------------------------------
const manifest = JSON.parse(read('appsscript.json'));
const el = manifest.addOns.flows.workflowElements.find((e) => e.id === 'applyTailoring');
check('manifest declares the applyTailoring step', !!el);
for (const fn of [el.workflowAction.onConfigFunction, el.workflowAction.onExecuteFunction]) {
  check(`callback ${fn} is defined`, typeof ctx[fn] === 'function');
}
const fields = [...src.matchAll(/setFieldName\('([^']+)'\)/g)].map((m) => m[1]).sort();
check('every card field matches a manifest input',
  JSON.stringify(fields) === JSON.stringify(el.workflowAction.inputs.map((i) => i.id).sort()));
const mapKeys = [...src.matchAll(/(\w+): AddOnsResponseService\.newVariableData\(\)/g)].map((m) => m[1]).sort();
check('onExecute returns exactly the declared outputs',
  JSON.stringify(mapKeys) === JSON.stringify(el.workflowAction.outputs.map((o) => o.id).sort()), JSON.stringify(mapKeys));

// ---- the merge -------------------------------------------------------------
const base = {
  basics: { name: 'Ada Lovelace', label: 'Engineer', email: 'ada@example.com', summary: 'Old summary.' },
  work: [
    { name: 'Acme', position: 'Staff Engineer', startDate: '2020-01', highlights: ['A1', 'A2', 'A3'] },
    { name: 'Initech', position: 'Engineer', startDate: '2015-05', endDate: '2019-12', highlights: ['I1'] },
  ],
  education: [{ institution: 'Uni', studyType: 'BSc', area: 'Maths', endDate: '2014' }],
  projects: [{ name: 'P', highlights: ['P1', 'P2'] }],
  skills: [{ name: 'Python' }, { name: 'Go' }, { name: 'LangChain', keywords: ['RAG'] }],
};
const apply = (patch) => ctx.applyTailoringInput(JSON.stringify(base), JSON.stringify(patch));

const ok = apply({
  label: 'Gen AI Engineer', summary: ' New summary. ',
  work: [{ index: 0, highlights: [2, 0] }],
  projects: [{ index: 0, highlights: [1] }],
  skills: ['LangChain', 'python'],
});
check('a valid patch applies', !ok.error, JSON.stringify(ok.error));
const t = ok.resume;
check('label and summary change (trimmed)', t.basics.label === 'Gen AI Engineer' && t.basics.summary === 'New summary.');
check('highlights are picked by index, in the patch order, as the base wording', JSON.stringify(t.work[0].highlights) === '["A3","A1"]');
check('an unpatched entry is untouched', JSON.stringify(t.work[1]) === JSON.stringify(base.work[1]));
check('project highlights change', JSON.stringify(t.projects[0].highlights) === '["P2"]');
check('skills: named first (case-insensitive), the rest keep their order',
  JSON.stringify(t.skills.map((s) => s.name)) === '["LangChain","Python","Go"]');
check('skill keywords survive the reorder', JSON.stringify(t.skills[0].keywords) === '["RAG"]');
check('locked facts are identical: employers, titles, dates, education, contact',
  t.work.map((w) => [w.name, w.position, w.startDate, w.endDate].join('|')).join() ===
    base.work.map((w) => [w.name, w.position, w.startDate, w.endDate].join('|')).join() &&
  JSON.stringify(t.education) === JSON.stringify(base.education) &&
  t.basics.name === base.basics.name && t.basics.email === base.basics.email);
check('the base resume object is not mutated', base.work[0].highlights.length === 3 && base.basics.label === 'Engineer');
check('an empty patch returns the base unchanged', JSON.stringify(apply({}).resume) === JSON.stringify(base));
check('a ```json fenced patch is accepted', !ctx.applyTailoringInput(JSON.stringify(base), '```json\n{"summary":"x"}\n```').error);

const bad = (name, patch, re) => {
  const r = apply(patch);
  check(name, !!r.error && re.test(r.error), JSON.stringify(r));
};
bad('an unknown top-level key fails (no new facts sneak in)', { education: [] }, /unknown key "education"/);
bad('changing an employer name fails', { work: [{ index: 0, name: 'Google', highlights: [0] }] }, /unknown key "name"/);
bad('changing a date fails', { work: [{ index: 0, startDate: '2010', highlights: [0] }] }, /unknown key "startDate"/);
bad('an index past the end fails', { work: [{ index: 2, highlights: [0] }] }, /index must be 0 to 1/);
bad('a negative index fails', { work: [{ index: -1, highlights: [0] }] }, /index must be/);
bad('a fractional index fails', { work: [{ index: 0.5, highlights: [0] }] }, /index must be/);
bad('a repeated entry index fails', { work: [{ index: 0, highlights: [0] }, { index: 0, highlights: [1] }] }, /repeated/);
bad('empty highlights fail', { work: [{ index: 0, highlights: [] }] }, /non-empty array/);
bad('a WRITTEN highlight fails (bullets are picked, never written)', { work: [{ index: 0, highlights: ['A1 but better'] }] }, /never written/);
bad('a highlight index past that entry\'s bullets fails', { work: [{ index: 1, highlights: [1] }] }, /not an index 0 to 0/);
bad('a repeated highlight index fails', { work: [{ index: 0, highlights: [1, 1] }] }, /index 1 is repeated/);
bad('a skill not in the base fails (no invented skills)', { skills: ['Kubernetes'] }, /"Kubernetes" is not in the base resume/);
bad('a repeated skill fails', { skills: ['Go', 'go'] }, /repeated/);
bad('an empty summary fails', { summary: ' ' }, /summary must be a non-empty string/);
bad('work as an object fails', { work: { index: 0 } }, /work must be an array/);
check('a non-JSON patch fails', /the patch/.test(ctx.applyTailoringInput(JSON.stringify(base), 'sure! here you go').error || ''));
check('an empty patch input fails', !!ctx.applyTailoringInput(JSON.stringify(base), '').error);
check('a broken base resume fails', /the base resume/.test(ctx.applyTailoringInput('{"work":{}}', '{}').error || ''));

const dup = { ...base, skills: [{ name: 'Go' }, { name: 'Python' }, { name: 'Go', level: 'x' }] };
const d = ctx.applyTailoringInput(JSON.stringify(dup), '{"skills":["Python"]}');
check('a duplicate skill name in the base is kept, not dropped', d.resume && d.resume.skills.length === 3, JSON.stringify(d));

// ---- document title (deepjobseek's <FullName>-<RoleTitle> convention) --------
check('docTitle is <FullName>-<Role> in PascalCase', ctx.tailoredDocTitle(base, 'Gen AI developer (Hybrid)') === 'AdaLovelace-GenAiDeveloperHybrid', ctx.tailoredDocTitle(base, 'Gen AI developer (Hybrid)'));
check('docTitle without a job title is the name alone', ctx.tailoredDocTitle(base, '') === 'AdaLovelace');
check('docTitle keeps accented letters', ctx.pascalCase('résumé écrit') === 'RésuméÉcrit', ctx.pascalCase('résumé écrit'));
check('docTitle has no character a file name would choke on', /^[\p{L}0-9-]+$/u.test(ctx.tailoredDocTitle(base, 'C++ / .NET: Lead?')));

if (failures.length) {
  console.log(`\n${failures.length} FAILED`);
  process.exit(1);
}
console.log('\nall passed');
