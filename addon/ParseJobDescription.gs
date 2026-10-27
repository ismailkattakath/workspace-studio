/**
 * "Parse Job Description" — a custom step for Google Workspace Studio.
 *
 * Studio's Gemini steps cannot enforce a response schema, so a Gemini step
 * writes the job posting as JSON and THIS step is the schema gate: it parses
 * it, checks it against the jsonresume.org job schema, and fails loudly on a
 * drifted shape. It never repairs (the same rule as Load JSON Resume).
 *
 * Schema: @jsonresume/schema 1.7.0 job-schema.json (jsonresume/jsonresume.org,
 * packages/schema), read 2026-10-27. Every property there is optional and extra
 * keys are allowed; this step requires a title plus at least one of
 * responsibilities, qualifications or skills, and checks every type.
 *
 * Who to reply to is NOT this step's job: the flow's "Draft an email" takes the
 * sender straight from the "When I get an email" starter, so no model output
 * ever chooses a recipient.
 */

var JOB_STRING_FIELDS = ['title', 'company', 'type', 'date', 'description', 'remote', 'salary', 'experience'];
var JOB_STRING_LIST_FIELDS = ['responsibilities', 'qualifications'];
var FORMULA_START = /^[=+\-@\t\r]/;

function onConfigParseJobDescription() {
  var job = CardService.newTextInput()
    .setFieldName('jobJson') // MUST equal the manifest inputs[].id
    .setTitle('Job posting as JSON')
    .setMultiline(true)
    .setHint('Pick the output of the Ask Gemini step that turned the posting into JSON.')
    .setHostAppDataSource(
      CardService.newHostAppDataSource().setWorkflowDataSource(
        CardService.newWorkflowDataSource().setIncludeVariables(true)));
  return CardService.newCardBuilder()
    .setHeader(CardService.newCardHeader().setTitle('Parse Job Description'))
    .addSection(CardService.newCardSection()
      .addWidget(CardService.newTextParagraph().setText(
        'Checks a job posting written as JSON against the <b>jsonresume.org job schema</b>, ' +
        'and fails if it does not match.'))
      .addWidget(job))
    .build();
}

function onExecuteParseJobDescription(event) {
  var inputs = (event && event.workflow && event.workflow.actionInvocation &&
                event.workflow.actionInvocation.inputs) || {};
  console.log('ParseJobDescription inputs present: ' + JSON.stringify(Object.keys(inputs)));

  var parsed = parseJobInput(readActionInput(inputs, 'jobJson'));
  if (parsed.error) return failStep('Could not parse the job description: ' + parsed.error);

  var o = buildJobOutputs(parsed.job);
  var map = {
    job: AddOnsResponseService.newVariableData().addStringValue(o.job),
    title: AddOnsResponseService.newVariableData().addStringValue(o.title),
    company: AddOnsResponseService.newVariableData().addStringValue(o.company),
    location: AddOnsResponseService.newVariableData().addStringValue(o.location),
    remote: AddOnsResponseService.newVariableData().addStringValue(o.remote),
    type: AddOnsResponseService.newVariableData().addStringValue(o.type),
    salary: AddOnsResponseService.newVariableData().addStringValue(o.salary)
  };
  var workflowAction = AddOnsResponseService.newReturnOutputVariablesAction().setVariableDataMap(map);
  var hostAppAction = AddOnsResponseService.newHostAppAction().setWorkflowAction(workflowAction);
  return AddOnsResponseService.newRenderActionBuilder().setHostAppAction(hostAppAction).build();
}

// ---- Pure half: tested by test-parsejob.mjs --------------------------------

/** {job} or {error}; never throws. The input IS the job object. */
function parseJobInput(text) {
  var got = parseJsonObjectInput(text,
    'no job JSON was given. Open the step and pick the output of the Ask Gemini step.');
  if (got.error) return got;
  var problems = jobShapeProblems(got.value);
  if (problems.length) {
    return { error: 'it does not match the jsonresume.org job schema: ' + problems.slice(0, 5).join('; ') +
      (problems.length > 5 ? ' (and ' + (problems.length - 5) + ' more)' : '') + '.' };
  }
  return { job: got.value };
}

/** Structural check against job-schema.json, plus the minimum a posting needs. */
function jobShapeProblems(job) {
  var problems = [];
  if (!str(job.title).trim()) problems.push('title is required');
  JOB_STRING_FIELDS.forEach(function (f) {
    if (f in job && typeof job[f] !== 'string') problems.push(f + ' must be a string');
  });
  JOB_STRING_LIST_FIELDS.forEach(function (f) {
    if (!(f in job)) return;
    if (!Array.isArray(job[f]) || job[f].some(function (s) { return typeof s !== 'string'; })) {
      problems.push(f + ' must be an array of strings');
    }
  });
  if ('skills' in job) {
    if (!Array.isArray(job.skills)) {
      problems.push('skills must be an array');
    } else {
      job.skills.forEach(function (s, i) {
        if (!isPlainObject(s) || typeof s.name !== 'string' || !s.name.trim()) {
          problems.push('skills[' + i + '] must be an object with a name');
          return;
        }
        if ('level' in s && typeof s.level !== 'string') problems.push('skills[' + i + '].level must be a string');
        if ('keywords' in s && (!Array.isArray(s.keywords) || s.keywords.some(function (k) { return typeof k !== 'string'; }))) {
          problems.push('skills[' + i + '].keywords must be an array of strings');
        }
      });
    }
  }
  if ('location' in job && !isPlainObject(job.location)) problems.push('location must be an object');
  if ('date' in job && typeof job.date === 'string' && job.date && !ISO8601_PARTIAL.test(job.date)) {
    problems.push('date must be YYYY, YYYY-MM or YYYY-MM-DD');
  }
  // These fields become tracker Sheet cells. A posting could steer Gemini into
  // "=IMPORTXML(...)" and leak other cells if the Sheet evaluates it, so a value
  // that would start a formula fails the step (no repair, the rule above).
  var cells = ['title', 'company', 'type', 'remote', 'salary'].map(function (f) { return [f, job[f]]; });
  if (isPlainObject(job.location)) {
    Object.keys(job.location).forEach(function (k) { cells.push(['location.' + k, job.location[k]]); });
  }
  cells.forEach(function (c) {
    if (typeof c[1] === 'string' && FORMULA_START.test(c[1].trim())) problems.push(c[0] + ' must not start with = + - @');
  });
  var substance = ['responsibilities', 'qualifications', 'skills'].some(function (f) {
    return Array.isArray(job[f]) && job[f].length > 0;
  });
  if (!substance) problems.push('at least one of responsibilities, qualifications or skills must be non-empty');
  return problems;
}

/** Every declared output, as plain values. */
function buildJobOutputs(job) {
  return {
    job: JSON.stringify(job),
    title: str(job.title).trim(),
    company: str(job.company).trim(),
    location: isPlainObject(job.location) ? joinNonEmpty(['address', 'city', 'region', 'postalCode', 'countryCode']
      .map(function (k) { return str(job.location[k]).trim(); }), ', ') : '',
    remote: str(job.remote).trim(),
    type: str(job.type).trim(),
    salary: str(job.salary).trim()
  };
}
