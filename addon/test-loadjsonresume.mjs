/**
 * Tests for the pure logic of LoadJsonResume.gs.
 *
 * Apps Script cannot run off Google's servers, so the Workspace Studio
 * integration itself has to be verified by installing the add-on. Everything
 * that does NOT touch CardService or UrlFetchApp is plain JavaScript though,
 * and that is where the bugs live: the formInputs shape, the URL guard, the
 * per-section headline formatting. Those are tested here, against REAL resumes
 * fetched from the public JSON Resume registry rather than a fixture someone
 * wrote to match the code.
 *
 * Run: nix run nixpkgs#nodejs -- addon/test-loadjsonresume.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createContext, runInContext } from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, 'LoadJsonResume.gs'), 'utf8');

// Load the script's pure half into a fresh context.
//
// `node:vm` rather than `new Function(...)`: the latter needs the source
// CONCATENATED into a function body, which is a code-injection shape even when
// the string is our own file — and a security hook flagged it, correctly. vm is
// the purpose-built stdlib API, takes the source as a value rather than
// splicing it into a template, and states the intent plainly.
//
// No stubs: CardService and UrlFetchApp are Apps Script globals, and the two
// functions that use them are never called here. A ReferenceError would mean
// something under test had reached for a global it should not.
const ctx = createContext({ console, fetch, AbortSignal });
runInContext(src, ctx, { filename: 'LoadJsonResume.gs' });

const failures = [];
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  ok   ${name}`);
  else { console.log(`  FAIL ${name} ${detail}`); failures.push(name); }
};

// ---- URL guard -------------------------------------------------------------
check('rejects an empty URL', ctx.validateUrl('') !== '');
check('rejects plain http', ctx.validateUrl('http://example.com/resume.json') !== '');
check('rejects credentials in the URL', ctx.validateUrl('https://u:p@example.com/r.json') !== '');
check('accepts a registry URL', ctx.validateUrl('https://registry.jsonresume.org/x.json') === '');
check('accepts an @ in the PATH, not the host',
  ctx.validateUrl('https://example.com/@scope/resume.json') === '',
  ctx.validateUrl('https://example.com/@scope/resume.json'));

// ---- formInputs shape ------------------------------------------------------
// The nested shape is the classic silent bug: read it wrong and the field looks
// empty while the user can see a value in the card.
check('reads the nested Workspace Studio shape',
  ctx.readStringInput({ resumeUrl: { stringInputs: { value: ['https://a/r.json'] } } }, 'resumeUrl') === 'https://a/r.json');
check('trims whitespace',
  ctx.readStringInput({ resumeUrl: { stringInputs: { value: ['  https://a/r.json  '] } } }, 'resumeUrl') === 'https://a/r.json');
check('missing field yields empty string', ctx.readStringInput({}, 'resumeUrl') === '');
check('empty value array yields empty string',
  ctx.readStringInput({ resumeUrl: { stringInputs: { value: [] } } }, 'resumeUrl') === '');
check('tolerates a flattened string payload',
  ctx.readStringInput({ resumeUrl: 'https://a/r.json' }, 'resumeUrl') === 'https://a/r.json');

// ---- section shape check ---------------------------------------------------
check('accepts a sparse but valid resume', ctx.hasAnyKnownSection({ basics: { name: 'A' } }) === true);
check('accepts a work-only resume', ctx.hasAnyKnownSection({ work: [] }) === true);
check('rejects an unrelated object', ctx.hasAnyKnownSection({ hello: 'world' }) === false);

// ---- outputs contract ------------------------------------------------------
// Workspace Studio errors the step unless EVERY declared output comes back.
const declared = ['resume', 'resumeText', 'name', 'label', 'email'];
const got = ctx.outputs('a', 'b', 'c', 'd', 'e');
check('returns exactly the declared outputs',
  declared.every(k => k in got) && Object.keys(got).length === declared.length,
  JSON.stringify(Object.keys(got)));

// ---- headline formatting per section ---------------------------------------
check('work headline carries position, employer and dates',
  ctx.headlineFor('work', { position: 'Principal Engineer', name: 'Acme', startDate: '2020-01', endDate: '2024-06' })
    === 'Principal Engineer — Acme  (2020-01 – 2024-06)');
check('an open-ended role reads as present',
  ctx.headlineFor('work', { position: 'Engineer', name: 'Acme', startDate: '2024-01' })
    .includes('present'));
check('education uses studyType/area/institution',
  ctx.headlineFor('education', { studyType: 'BSc', area: 'Computer Science', institution: 'A University' })
    .startsWith('BSc Computer Science — A University'));
check('skills carry no dates',
  ctx.headlineFor('skills', { name: 'Nix', level: 'Advanced' }) === 'Nix — Advanced');
check('certificates use issuer and date',
  ctx.headlineFor('certificates', { name: 'CKA', issuer: 'CNCF', date: '2023-05' })
    === 'CKA — CNCF  (2023-05)');

// ---- real resumes from the live registry -----------------------------------
const people = ['thomasdavis', 'jsonresume'];
for (const who of people) {
  const url = `https://registry.jsonresume.org/${who}.json`;
  let resume;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) { console.log(`  skip registry/${who} (HTTP ${r.status})`); continue; }
    resume = await r.json();
  } catch (e) {
    console.log(`  skip registry/${who} (${e.message})`);
    continue;
  }
  check(`registry/${who}: recognised as a resume`, ctx.hasAnyKnownSection(resume) === true);
  const text = ctx.toPlainText(resume);
  check(`registry/${who}: flattens to non-trivial text`, text.length > 300, `len=${text.length}`);
  check(`registry/${who}: no undefined/null leaked into the text`,
    !text.includes('undefined') && !text.includes('null'));
  check(`registry/${who}: name appears when present`,
    !resume.basics?.name || text.includes(resume.basics.name));
  check(`registry/${who}: no run of blank lines`, !/\n{3,}/.test(text));
  console.log(`       ${who}: ${text.length} chars, ${text.split('\n').length} lines`);
}

// ---- degenerate inputs must not throw --------------------------------------
for (const [label, value] of [['empty object', {}], ['nulls', { basics: null, work: null }],
  ['wrong types', { basics: 'x', work: 'y', skills: 42 }],
  ['array items that are not objects', { work: ['a', null, 3] }]]) {
  try { ctx.toPlainText(value); check(`degenerate: ${label}`, true); }
  catch (e) { check(`degenerate: ${label}`, false, e.message); }
}

console.log();
if (failures.length) { console.log(`${failures.length} FAILED: ${failures.join(', ')}`); process.exit(1); }
console.log('all LoadJsonResume properties hold');
