/**
 * "Parse Job Description" — a custom step for Google Workspace Studio.
 *
 * Studio's Gemini steps cannot enforce a response schema, so a Gemini step
 * writes the job posting as JSON and THIS step is the schema gate: it parses
 * it, checks it against the jsonresume.org job schema, and fails loudly on a
 * drifted shape. It never repairs (the same rule as Load JSON Resume).
 *
 * Inputs:
 *   jobJson        — the posting as jsonresume.org job JSON (from Ask Gemini),
 *                    optionally ```json-fenced.
 *   forwardedEmail — the trigger email's body: the posting the user FORWARDED
 *                    to the flow.
 *
 * Schema: @jsonresume/schema 1.7.0 job-schema.json (jsonresume/jsonresume.org,
 * packages/schema), read 2026-10-27. Every property there is optional and extra
 * keys are allowed; this step requires a title plus at least one of
 * responsibilities, qualifications or skills, and checks every type.
 *
 * The reply address NEVER comes from Gemini. The posting is untrusted text, and
 * a line in it could steer the model into naming any address; the draft would
 * then carry the tailored resume to that address. replyTo is read by code from
 * the FIRST forward header in the body, which the user's mail client wrote
 * above the forwarded content (Gmail: "---------- Forwarded message ---------",
 * measured on a real forward 2026-10-27; Apple Mail: "Begin forwarded
 * message:"). Text above that header is the user's own; a fake header inside
 * the posting comes later and is never read. No header, the step fails.
 *
 * replyTo is an EMAIL_ADDRESS output: Studio's "Draft an email" To field only
 * offers email-address outputs, never plain text (live, 2026-10-27).
 */

var JOB_STRING_FIELDS = ['title', 'company', 'type', 'date', 'description', 'remote', 'salary', 'experience'];
var JOB_STRING_LIST_FIELDS = ['responsibilities', 'qualifications'];
var EMAIL_PATTERN = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[A-Za-z]{2,}$/;
var FORWARD_MARKER = /^[ \t>]*(?:-{5,}\s*Forwarded message\s*-{5,}|Begin forwarded message:)[ \t]*$/im;

function onConfigParseJobDescription() {
  var variables = function () {
    return CardService.newHostAppDataSource().setWorkflowDataSource(
      CardService.newWorkflowDataSource().setIncludeVariables(true));
  };
  var job = CardService.newTextInput()
    .setFieldName('jobJson') // MUST equal the manifest inputs[].id
    .setTitle('Job posting as JSON')
    .setMultiline(true)
    .setHint('Pick the output of the Ask Gemini step that turned the posting into JSON.')
    .setHostAppDataSource(variables());
  var forwarded = CardService.newTextInput()
    .setFieldName('forwardedEmail') // MUST equal the manifest inputs[].id
    .setTitle('Forwarded email')
    .setMultiline(true)
    .setHint('Pick the starter email\'s body. The reply goes to the sender in its forward header.')
    .setHostAppDataSource(variables());
  return CardService.newCardBuilder()
    .setHeader(CardService.newCardHeader().setTitle('Parse Job Description'))
    .addSection(CardService.newCardSection()
      .addWidget(CardService.newTextParagraph().setText(
        'Checks a job posting written as JSON against the <b>jsonresume.org job schema</b>, ' +
        'and fails if it does not match.'))
      .addWidget(job)
      .addWidget(forwarded))
    .build();
}

function onExecuteParseJobDescription(event) {
  var inputs = (event && event.workflow && event.workflow.actionInvocation &&
                event.workflow.actionInvocation.inputs) || {};
  console.log('ParseJobDescription inputs present: ' + JSON.stringify(Object.keys(inputs)));

  var parsed = parseJobInput(readActionInput(inputs, 'jobJson'));
  if (parsed.error) return failStep('Could not parse the job description: ' + parsed.error);
  var source = parseForwardHeader(readActionInput(inputs, 'forwardedEmail'));
  if (source.error) return failStep('Could not find who to reply to: ' + source.error);

  var o = buildJobOutputs(parsed.job, source);
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

/**
 * {email, subject} from the FIRST forward header in an email body, or {error}.
 * Only the header lines directly under the marker are read, up to the first
 * blank line, so nothing from the forwarded content can supply an address.
 */
function parseForwardHeader(body) {
  var text = str(body).replace(/\r\n?/g, '\n');
  var marker = FORWARD_MARKER.exec(text);
  if (!marker) return { error: 'the email has no forward header. Forward the posting to the flow; do not paste it.' };

  var lines = text.slice(marker.index + marker[0].length).split('\n');
  var header = {};
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].replace(/^[ \t>]+/, '');
    if (!line.trim()) {
      if (Object.keys(header).length) break; // the blank line that ends the header
      continue; // Apple Mail puts a blank line under its marker
    }
    var m = /^(From|Subject|Date|To|Cc):\s*(.*)$/i.exec(line);
    if (!m) break;
    var key = m[1].toLowerCase();
    if (!(key in header)) header[key] = m[2].trim();
  }
  if (!header.from) return { error: 'the forward header has no From line.' };

  var angle = /<([^<>\s]+)>\s*$/.exec(header.from);
  var email = (angle ? angle[1] : header.from).trim();
  if (!EMAIL_PATTERN.test(email)) return { error: 'the forward header\'s From is not one email address.' };
  return { email: email, subject: str(header.subject).trim() };
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
