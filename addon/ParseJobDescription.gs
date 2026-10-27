/**
 * "Parse Job Description" — a custom step for Google Workspace Studio.
 *
 * Studio's Gemini steps cannot enforce a response schema, so a Gemini step
 * writes the job posting as JSON and THIS step is the schema gate: it parses
 * it, checks it against the jsonresume.org job schema, and fails loudly on a
 * drifted shape. It never repairs (the same rule as Load JSON Resume).
 *
 * Input (from an "Ask Gemini" step), one JSON object, optionally ```json-fenced:
 *
 *   { "job":    { ...jsonresume.org job schema... },
 *     "source": { "email": "jane@example.com", "subject": "Staff Engineer role" } }
 *
 * Schema: @jsonresume/schema 1.7.0 job-schema.json (jsonresume/jsonresume.org,
 * packages/schema), read 2026-10-27. Every property there is optional and extra
 * keys are allowed; this step requires a title plus at least one of
 * responsibilities, qualifications or skills, and checks every type.
 *
 * `source` is the ORIGINAL sender of a posting the user forwarded to the flow.
 * It becomes replyTo as an EMAIL_ADDRESS output: Studio's "Draft an email" To
 * field only offers email-address outputs, never plain text (live, 2026-10-27).
 */

var JOB_STRING_FIELDS = ['title', 'company', 'type', 'date', 'description', 'remote', 'salary', 'experience'];
var JOB_STRING_LIST_FIELDS = ['responsibilities', 'qualifications'];
var EMAIL_PATTERN = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[A-Za-z]{2,}$/;

function onConfigParseJobDescription() {
  var input = CardService.newTextInput()
    .setFieldName('jobJson') // MUST equal the manifest inputs[].id
    .setTitle('Job posting as JSON')
    .setMultiline(true)
    .setHint('Pick the output of the Ask Gemini step that turned the posting into JSON.')
    .setHostAppDataSource(
      CardService.newHostAppDataSource().setWorkflowDataSource(
        CardService.newWorkflowDataSource().setIncludeVariables(true)
      )
    );
  return CardService.newCardBuilder()
    .setHeader(CardService.newCardHeader().setTitle('Parse Job Description'))
    .addSection(CardService.newCardSection()
      .addWidget(CardService.newTextParagraph().setText(
        'Checks a job posting written as JSON against the <b>jsonresume.org job schema</b>, ' +
        'and fails if it does not match.'))
      .addWidget(input))
    .build();
}

function onExecuteParseJobDescription(event) {
  var inputs = (event && event.workflow && event.workflow.actionInvocation &&
                event.workflow.actionInvocation.inputs) || {};
  console.log('ParseJobDescription inputs present: ' + JSON.stringify(Object.keys(inputs)));

  var parsed = parseJobInput(readActionInput(inputs, 'jobJson'));
  if (parsed.error) return failStep('Could not parse the job description: ' + parsed.error);

  var o = buildJobOutputs(parsed.job, parsed.source);
  var map = {
    job: AddOnsResponseService.newVariableData().addStringValue(o.job),
    title: AddOnsResponseService.newVariableData().addStringValue(o.title),
    company: AddOnsResponseService.newVariableData().addStringValue(o.company),
    replyTo: AddOnsResponseService.newVariableData().addEmailAddress(o.replyTo),
    replySubject: AddOnsResponseService.newVariableData().addStringValue(o.replySubject)
  };
  var workflowAction = AddOnsResponseService.newReturnOutputVariablesAction().setVariableDataMap(map);
  var hostAppAction = AddOnsResponseService.newHostAppAction().setWorkflowAction(workflowAction);
  return AddOnsResponseService.newRenderActionBuilder().setHostAppAction(hostAppAction).build();
}

// ---- Pure half: tested by test-parsejob.mjs --------------------------------

/** {job, source} or {error}; never throws. */
function parseJobInput(text) {
  var got = parseJsonObjectInput(text);
  if (got.error) return got;
  var root = got.value;
  var job = isPlainObject(root.job) ? root.job : null;
  if (!job) return { error: 'expected {"job": {…}, "source": {…}}; there is no "job" object.' };
  var source = isPlainObject(root.source) ? root.source : {};

  var problems = jobShapeProblems(job);
  var email = str(source.email).trim();
  if (!EMAIL_PATTERN.test(email)) problems.push('source.email must be the original sender\'s email address');
  if (problems.length) {
    return { error: 'it does not match the jsonresume.org job schema: ' + problems.slice(0, 5).join('; ') +
      (problems.length > 5 ? ' (and ' + (problems.length - 5) + ' more)' : '') + '.' };
  }
  return { job: job, source: { email: email, subject: str(source.subject).trim() } };
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
  var substance = ['responsibilities', 'qualifications', 'skills'].some(function (f) {
    return Array.isArray(job[f]) && job[f].length > 0;
  });
  if (!substance) problems.push('at least one of responsibilities, qualifications or skills must be non-empty');
  return problems;
}

/** Every declared output, as plain values. */
function buildJobOutputs(job, source) {
  var subject = str(source && source.subject).trim();
  return {
    job: JSON.stringify(job),
    title: str(job.title).trim(),
    company: str(job.company).trim(),
    replyTo: str(source && source.email).trim(),
    replySubject: subject ? (/^re:/i.test(subject) ? subject : 'Re: ' + subject)
      : 'Re: ' + joinNonEmpty([str(job.title).trim(), str(job.company).trim()], ' at ')
  };
}
