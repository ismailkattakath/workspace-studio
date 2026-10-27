/**
 * "Apply Tailoring" — a custom step for Google Workspace Studio.
 *
 * Merges a small TAILORING PATCH from an "Ask Gemini" step into the base resume
 * from Load JSON Resume, in code, and emits the tailored resume.json.
 *
 * Why a patch and not a whole tailored resume from Gemini: a resume that is
 * public (jsonresume.org renders it from a gist) comes back nearly verbatim, and
 * Studio's Gemini blocks that output as "too closely matched protected external
 * content" (live, 2026-10-27). A patch is short, so it passes, and it can only
 * touch the fields below; employers, titles, dates, degrees, URLs and contact
 * details stay exactly as in the base resume.
 *
 * Patch (one JSON object, optionally ```json-fenced; every key optional, any
 * other key fails the step):
 *   { "label":    "headline",
 *     "summary":  "two or three sentences",
 *     "work":     [{ "index": 0, "highlights": [2, 0] }],
 *     "projects": [{ "index": 1, "highlights": [1] }],
 *     "skills":   ["Python", "LangChain"] }
 *
 * index is the entry's position in the base resume's work/projects array.
 * highlights are INDEXES into that entry's own base highlights: the patch can
 * pick, order and drop bullets but never write one, so every bullet stays the
 * operator's own words (deepjobseek's evidence rule, which Studio cannot query,
 * enforced the only way code can). skills names base skills, most relevant
 * first; unnamed ones keep their order after them. An index out of range, a
 * repeat or an unknown skill fails the step: no repair, the same rule as the
 * other steps.
 *
 * docTitle is the submitted-file name convention from deepjobseek's render.sh:
 * <FullNameInPascalCase>-<RoleTitleInPascalCase>, e.g. IsmailKattakath-GenAiDeveloper.
 */

var PATCH_KEYS = ['label', 'summary', 'work', 'projects', 'skills'];

function onConfigApplyTailoring() {
  var variables = function () {
    return CardService.newHostAppDataSource().setWorkflowDataSource(
      CardService.newWorkflowDataSource().setIncludeVariables(true));
  };
  var resume = CardService.newTextInput()
    .setFieldName('resume') // MUST equal the manifest inputs[].id
    .setTitle('Base resume (JSON)')
    .setMultiline(true)
    .setHint('Pick the "Resume (JSON)" output of Load JSON Resume.')
    .setHostAppDataSource(variables());
  var patch = CardService.newTextInput()
    .setFieldName('patch') // MUST equal the manifest inputs[].id
    .setTitle('Tailoring patch (JSON)')
    .setMultiline(true)
    .setHint('Pick the output of the Ask Gemini step that wrote the tailoring patch.')
    .setHostAppDataSource(variables());
  var jobTitle = CardService.newTextInput()
    .setFieldName('jobTitle') // MUST equal the manifest inputs[].id
    .setTitle('Job title (optional)')
    .setHint('Pick "Job title" from Parse Job Description; it names the document.')
    .setHostAppDataSource(variables());
  return CardService.newCardBuilder()
    .setHeader(CardService.newCardHeader().setTitle('Apply Tailoring'))
    .addSection(CardService.newCardSection()
      .addWidget(CardService.newTextParagraph().setText(
        'Applies a tailoring patch to your base resume. Only the headline and summary can be reworded; ' +
        'highlights and skills can only be <b>picked and reordered</b>, and employers, titles, dates and degrees stay as they are.'))
      .addWidget(resume)
      .addWidget(patch)
      .addWidget(jobTitle))
    .build();
}

function onExecuteApplyTailoring(event) {
  var inputs = (event && event.workflow && event.workflow.actionInvocation &&
                event.workflow.actionInvocation.inputs) || {};
  console.log('ApplyTailoring inputs present: ' + JSON.stringify(Object.keys(inputs)));

  var out = applyTailoringInput(readActionInput(inputs, 'resume'), readActionInput(inputs, 'patch'));
  if (out.error) return failStep('Could not apply the tailoring: ' + out.error);

  var map = {
    resume: AddOnsResponseService.newVariableData().addStringValue(JSON.stringify(out.resume)),
    docTitle: AddOnsResponseService.newVariableData().addStringValue(
      tailoredDocTitle(out.resume, readActionInput(inputs, 'jobTitle')))
  };
  var workflowAction = AddOnsResponseService.newReturnOutputVariablesAction().setVariableDataMap(map);
  var hostAppAction = AddOnsResponseService.newHostAppAction().setWorkflowAction(workflowAction);
  return AddOnsResponseService.newRenderActionBuilder().setHostAppAction(hostAppAction).build();
}

// ---- Pure half: tested by test-applytailoring.mjs ---------------------------

/** {resume} (tailored) or {error}; never throws. */
function applyTailoringInput(resumeText, patchText) {
  var base = parseResumeInput(resumeText);
  if (base.error) return { error: 'the base resume: ' + base.error };
  var got = parseJsonObjectInput(patchText,
    'no tailoring patch was given. Pick the output of the Ask Gemini step that wrote it.');
  if (got.error) return { error: 'the patch: ' + got.error };
  return applyTailoring(base.resume, got.value);
}

/** Pure merge. Never mutates `base`. */
function applyTailoring(base, patch) {
  var problems = patchProblems(base, patch);
  if (problems.length) {
    return { error: 'the patch does not fit the resume: ' + problems.slice(0, 5).join('; ') +
      (problems.length > 5 ? ' (and ' + (problems.length - 5) + ' more)' : '') + '.' };
  }
  var resume = JSON.parse(JSON.stringify(base));
  if ('label' in patch || 'summary' in patch) resume.basics = isPlainObject(resume.basics) ? resume.basics : {};
  if ('label' in patch) resume.basics.label = patch.label.trim();
  if ('summary' in patch) resume.basics.summary = patch.summary.trim();
  ['work', 'projects'].forEach(function (section) {
    (patch[section] || []).forEach(function (p) {
      var original = base[section][p.index].highlights;
      resume[section][p.index].highlights = p.highlights.map(function (i) { return original[i]; });
    });
  });
  if (patch.skills) resume.skills = reorderSkills(resume.skills, patch.skills);

  var shape = resumeShapeProblems(resume);
  if (shape.length) return { error: 'the tailored resume is not valid: ' + shape.slice(0, 5).join('; ') + '.' };
  return { resume: resume };
}

/** Everything wrong with a patch, against the base it will be applied to. */
function patchProblems(base, patch) {
  var problems = [];
  Object.keys(patch).forEach(function (k) {
    if (PATCH_KEYS.indexOf(k) < 0) problems.push('unknown key "' + k + '" (allowed: ' + PATCH_KEYS.join(', ') + ')');
  });
  ['label', 'summary'].forEach(function (k) {
    if (k in patch && (typeof patch[k] !== 'string' || !patch[k].trim())) problems.push(k + ' must be a non-empty string');
  });
  ['work', 'projects'].forEach(function (section) {
    if (!(section in patch)) return;
    var entries = Array.isArray(base[section]) ? base[section] : [];
    if (!Array.isArray(patch[section])) { problems.push(section + ' must be an array'); return; }
    var seen = {};
    patch[section].forEach(function (p, i) {
      var where = section + '[' + i + ']';
      if (!isPlainObject(p)) { problems.push(where + ' must be an object'); return; }
      Object.keys(p).forEach(function (k) {
        if (k !== 'index' && k !== 'highlights') problems.push(where + ' has unknown key "' + k + '" (only index and highlights may change)');
      });
      if (typeof p.index !== 'number' || p.index % 1 !== 0 || p.index < 0 || p.index >= entries.length) {
        problems.push(where + '.index must be 0 to ' + (entries.length - 1) + ' (the base resume has ' + entries.length + ' ' + section + ' entries)');
      } else if (seen[p.index]) {
        problems.push(where + '.index ' + p.index + ' is repeated');
      } else {
        seen[p.index] = true;
      }
      var own = (entries[p.index] && Array.isArray(entries[p.index].highlights)) ? entries[p.index].highlights : [];
      if (!Array.isArray(p.highlights) || !p.highlights.length) {
        problems.push(where + '.highlights must be a non-empty array of highlight indexes');
      } else {
        var seenH = {};
        p.highlights.forEach(function (h) {
          if (typeof h !== 'number' || h % 1 !== 0 || h < 0 || h >= own.length) {
            problems.push(where + '.highlights: ' + JSON.stringify(h) + ' is not an index 0 to ' + (own.length - 1) +
              ' (highlights are picked by index, never written)');
          } else if (seenH[h]) {
            problems.push(where + '.highlights: index ' + h + ' is repeated');
          }
          seenH[h] = true;
        });
      }
    });
  });
  if ('skills' in patch) {
    var names = (Array.isArray(base.skills) ? base.skills : []).map(function (s) { return str(s && s.name).trim().toLowerCase(); });
    if (!Array.isArray(patch.skills) || patch.skills.some(function (n) { return typeof n !== 'string'; })) {
      problems.push('skills must be an array of skill names');
    } else {
      var seenSkill = {};
      patch.skills.forEach(function (n) {
        var key = n.trim().toLowerCase();
        if (names.indexOf(key) < 0) problems.push('skill "' + n + '" is not in the base resume');
        else if (seenSkill[key]) problems.push('skill "' + n + '" is repeated');
        seenSkill[key] = true;
      });
    }
  }
  return problems;
}

/** Named skills first, in the patch's order; the rest keep their order after. */
function reorderSkills(skills, order) {
  var keyOf = function (s) { return str(s && s.name).trim().toLowerCase(); };
  var wanted = order.map(function (n) { return n.trim().toLowerCase(); });
  var first = wanted.map(function (k) {
    return skills.filter(function (s) { return keyOf(s) === k; })[0];
  });
  var rest = skills.filter(function (s) { return first.indexOf(s) < 0; }); // a duplicate name is kept, not dropped
  return first.concat(rest);
}

/** <FullNameInPascalCase>-<RoleTitleInPascalCase>; the name alone without a title. */
function tailoredDocTitle(resume, jobTitle) {
  var name = pascalCase(resume && resume.basics && resume.basics.name);
  var role = pascalCase(jobTitle);
  return joinNonEmpty([name || 'Resume', role], '-');
}

/** "Gen AI developer (Hybrid)" -> "GenAiDeveloperHybrid"; accents kept as letters. */
function pascalCase(text) {
  return str(text).split(/[^0-9A-Za-z\u00C0-\u024F]+/).filter(function (w) { return w; })
    .map(function (w) { return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase(); }).join('');
}
