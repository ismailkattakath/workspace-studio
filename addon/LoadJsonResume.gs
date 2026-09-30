/**
 * "Load JSON Resume" — a custom step for Google Workspace Studio.
 *
 * Fetches a resume.json in the jsonresume.org standard from a URL the user
 * configures, and emits it as flow outputs for later steps to consume.
 *
 * WHAT THIS STEP DELIBERATELY DOES NOT DO: tailor the resume. Workspace Studio
 * flows already have a native "ask Gemini" step, so the tailoring belongs
 * there, not here. Keeping the LLM out buys four things — users need no API key
 * and pay nothing for this step, it composes with whatever AI step they prefer,
 * it stays deterministic and therefore testable, and — the important one — this
 * code never interprets the job posting. A posting arriving from an inbox is
 * attacker-controlled text; here it is simply never read.
 *
 * The intended flow shape:
 *
 *   [starter: posting arrives] -> [Load JSON Resume] -> [ask Gemini: tailor to
 *   this posting] -> [Gmail: create draft]
 *
 * Schema: https://github.com/jsonresume/resume-schema (verified 2026-09-30 —
 * top-level sections basics, work, volunteer, education, awards, certificates,
 * publications, skills, languages, interests, references, projects, meta).
 */

// Hard caps. A configuration field is user-supplied and a remote document is
// not under our control, so both are bounded rather than trusted.
var MAX_BYTES = 2 * 1024 * 1024; // a resume.json far past this is not a resume
var FETCH_TIMEOUT_MS = 20 * 1000;

// Sections rendered into resumeText, in the order a reader expects them.
var TEXT_SECTIONS = ['work', 'projects', 'education', 'skills', 'certificates', 'awards'];

/**
 * Builds the configuration card.
 *
 * TAKES NO EVENT PARAMETER, and does not prefill. An earlier version read saved
 * values out of `event.commonEventObject.formInputs` — that was wrong on both
 * counts. Every Studio example declares this callback bare
 * (`function onConfigFunctionCreateDocument() {`), and no Studio page uses
 * `setValue` to restore a field. Persistence is Studio's job, done through the
 * `setFieldName` <-> manifest `inputs[].id` binding below; the card only has to
 * describe the field.
 *
 * ONE FIELD ON PURPOSE. The promise of this step is "point it at your
 * resume.json and it works", so anything else asked here is friction.
 */
function onConfigLoadJsonResume() {
  var urlInput = CardService.newTextInput()
    .setFieldName('resumeUrl') // MUST equal the manifest inputs[].id — that binding is
                               // what delivers the value to onExecuteFunction.
    .setTitle('Your JSON Resume URL')
    .setHint(
      'https://registry.jsonresume.org/<username>.json  ·  ' +
      'https://raw.githubusercontent.com/<user>/<repo>/main/resume.json  ·  ' +
      'or any HTTPS URL serving the jsonresume.org schema'
    )
    // Lets the user pipe a variable from an EARLIER step into this field instead
    // of typing a literal URL — e.g. a URL an upstream step looked up. Every
    // Studio example attaches this to its TextInput; without it the field only
    // accepts hand-typed text.
    .setHostAppDataSource(
      CardService.newHostAppDataSource().setWorkflowDataSource(
        CardService.newWorkflowDataSource().setIncludeVariables(true)
      )
    );

  var section = CardService.newCardSection()
    .addWidget(
      CardService.newTextParagraph().setText(
        'Loads a resume in the <b>jsonresume.org</b> standard and makes it available ' +
        'to the rest of this flow. Pair it with an AI step to tailor the resume to a ' +
        'job posting.'
      )
    )
    .addWidget(urlInput);

  return CardService.newCardBuilder()
    .setHeader(CardService.newCardHeader().setTitle('Load JSON Resume'))
    .addSection(section)
    .build();
}


/**
 * Runs when the step executes.
 *
 * MUST return every output declared in appsscript.json — Workspace Studio
 * errors the step otherwise — so every failure path below still returns the
 * full set, with the reason in `resumeText` rather than an exception that tells
 * the user nothing.
 */
function onExecuteLoadJsonResume(event) {
  // DUMP THE EVENT FIRST. Reading the wrong object is the defining bug of this
  // platform's steps, and the only way to settle it is empirically: this line
  // puts the real payload in the Apps Script Executions view on run one, so a
  // future shape change is diagnosed in seconds instead of argued about. The
  // quickstart's own sample does the same thing.
  console.log('LoadJsonResume event: ' + JSON.stringify(event));

  // THE STUDIO PATH, not the generic add-on one. CONFIRMED BY A LIVE RUN
  // (2026-09-30), not inferred — the logged payload was, verbatim:
  //
  //   {"clientPlatform":"web",
  //    "commonEventObject":{"platform":"WEB","hostApp":"WORKFLOW"},
  //    "workflow":{"triggerEventSource":"TRIGGER_EVENT_SOURCE_AUTOMATED",
  //      "actionInvocation":{"triggerId":"…",
  //        "inputs":{"resumeUrl":{"stringValues":["https://…"]}}},
  //      "executionMetadata":{}},
  //    "hostApp":"flows"}
  //
  // Note commonEventObject: platform and hostApp, and NOTHING else. No
  // formInputs key to fall back on. An earlier version read
  // commonEventObject.formInputs[...] and would have resolved undefined against
  // this exact object — the URL comes back empty and the user sees "no URL is
  // configured" while looking at the URL they typed.
  var inputs = (event && event.workflow && event.workflow.actionInvocation &&
                event.workflow.actionInvocation.inputs) || {};
  var url = readActionInput(inputs, 'resumeUrl');

  var problem = validateUrl(url);
  if (problem) {
    return failStep('Could not load resume: ' + problem);
  }

  var raw;
  try {
    var response = UrlFetchApp.fetch(url, {
      method: 'get',
      muteHttpExceptions: true, // handle the status ourselves; a 404 body is not a resume
      followRedirects: true,
      validateHttpsCertificates: true,
      headers: { Accept: 'application/json' }
    });
    var status = response.getResponseCode();
    if (status < 200 || status >= 300) {
      return failStep('Could not load resume: the URL returned HTTP ' + status + '.');
    }
    raw = response.getContentText();
  } catch (err) {
    return failStep('Could not load resume: ' + err.message);
  }

  if (raw.length > MAX_BYTES) {
    return failStep('Could not load resume: the document exceeds the ' +
      Math.round(MAX_BYTES / 1024 / 1024) + ' MB limit.');
  }

  var resume;
  try {
    resume = JSON.parse(raw);
  } catch (err) {
    // The commonest cause by far: a GitHub *page* URL instead of a raw one, so
    // the body is HTML. Name that specifically rather than echoing a parser error.
    var hint = raw.slice(0, 200).indexOf('<') === 0
      ? ' The URL returned HTML, not JSON — if this is a GitHub or GitLab link, use the "raw" URL.'
      : '';
    return failStep('Could not load resume: the document is not valid JSON.' + hint);
  }

  if (!resume || typeof resume !== 'object' || Array.isArray(resume)) {
    return failStep('Could not load resume: the document is not a JSON object.');
  }
  // Shape check, not full schema validation. Every field in JSON Resume is
  // optional, so the only honest assertion is that at least one known section
  // is present — a stricter gate would reject legitimate sparse resumes.
  if (!hasAnyKnownSection(resume)) {
    return failStep('Could not load resume: no jsonresume.org sections found ' +
      '(expected at least one of basics, work, education, skills, projects).');
  }

  var basics = (resume.basics && typeof resume.basics === 'object') ? resume.basics : {};
  return outputs(
    JSON.stringify(resume),
    toPlainText(resume),
    str(basics.name),
    str(basics.label),
    str(basics.email)
  );
}

/**
 * Every declared output, every time — as a PLAIN MAP.
 *
 * Split from the Apps Script envelope below on purpose: this half is pure
 * JavaScript and can therefore be tested off Google's servers, which is where
 * the output contract actually gets checked.
 */
function buildOutputs(resume, resumeText, name, label, email) {
  return {
    resume: resume,
    resumeText: resumeText,
    name: name,
    label: label,
    email: email
  };
}

/**
 * Fails the step with a message the USER can read in the flow's Activity tab.
 *
 * The first version smuggled the reason into `resumeText` and returned success.
 * That is wrong twice over: the flow carries on as if it had a resume, and the
 * Activity tab — the only place a non-developer looks — shows nothing but the
 * step's name. ACTIONABLE + NOT_RETRYABLE is the honest pair here: every failure
 * this step can have (no URL, bad URL, not JSON, not a resume) is fixed by the
 * user editing their configuration, and none of them get better on a retry.
 */
function failStep(message) {
  var workflowAction = AddOnsResponseService.newReturnElementErrorAction()
    .setErrorLog(
      AddOnsResponseService.newWorkflowTextFormat().addTextFormatElement(
        AddOnsResponseService.newTextFormatElement().setText(message)
      )
    )
    .setErrorActionability(AddOnsResponseService.ErrorActionability.ACTIONABLE)
    .setErrorRetryability(AddOnsResponseService.ErrorRetryability.NOT_RETRYABLE);
  var hostAppAction = AddOnsResponseService.newHostAppAction().setWorkflowAction(workflowAction);
  return AddOnsResponseService.newRenderActionBuilder().setHostAppAction(hostAppAction).build();
}

/**
 * Wraps the output map in what Workspace Studio actually expects back.
 *
 * NOT a plain object. A step returns a RenderAction carrying a
 * ReturnOutputVariablesAction; returning the bare map errors the step. Verified
 * against Google's own examples, which use
 * `AddOnsResponseService.newVariableData().addStringValue(...)` and
 * `newReturnOutputVariablesAction().setVariableDataMap(...)`.
 */
function outputs(resume, resumeText, name, label, email) {
  var plain = buildOutputs(resume, resumeText, name, label, email);
  var variableDataMap = {};
  Object.keys(plain).forEach(function (key) {
    variableDataMap[key] = AddOnsResponseService.newVariableData().addStringValue(plain[key]);
  });

  var workflowAction = AddOnsResponseService.newReturnOutputVariablesAction()
    .setVariableDataMap(variableDataMap);
  var hostAppAction = AddOnsResponseService.newHostAppAction().setWorkflowAction(workflowAction);
  return AddOnsResponseService.newRenderActionBuilder().setHostAppAction(hostAppAction).build();
}

/**
 * HTTPS only, and no credentials in the URL.
 *
 * Not decoration: a configuration field is user-supplied, plain http would send
 * the request in the clear, and a `user:pass@host` URL would put a secret into
 * a stored step configuration where it does not belong.
 */
function validateUrl(url) {
  if (!url) return 'no URL is configured. Open the step and set your JSON Resume URL.';
  if (url.slice(0, 8).toLowerCase() !== 'https://') return 'the URL must start with https://.';
  if (url.indexOf('@') !== -1 && url.indexOf('@') < url.indexOf('/', 8)) {
    return 'the URL must not contain credentials.';
  }
  return '';
}

function hasAnyKnownSection(resume) {
  var known = ['basics', 'work', 'education', 'skills', 'projects', 'volunteer',
    'awards', 'certificates', 'publications', 'languages', 'interests', 'references'];
  for (var i = 0; i < known.length; i++) {
    if (Object.prototype.hasOwnProperty.call(resume, known[i])) return true;
  }
  return false;
}

/**
 * Flattens a resume to plain text for an AI step's context window.
 *
 * Deliberately lossy and deliberately plain: the consumer is a language model
 * reading prose, not a renderer. `resume` still carries the full JSON for any
 * step that needs structure.
 */
function toPlainText(resume) {
  var basics = (resume.basics && typeof resume.basics === 'object') ? resume.basics : {};
  var lines = [];

  if (basics.name) lines.push(str(basics.name));
  if (basics.label) lines.push(str(basics.label));
  var contact = [str(basics.email), str(basics.phone), str(basics.url)].filter(nonEmpty);
  if (contact.length) lines.push(contact.join(' · '));
  if (basics.summary) lines.push('', str(basics.summary));

  TEXT_SECTIONS.forEach(function (key) {
    var items = resume[key];
    if (!Array.isArray(items) || !items.length) return;
    lines.push('', key.toUpperCase());
    items.forEach(function (item) {
      if (!item || typeof item !== 'object') return;
      lines.push(headlineFor(key, item));
      if (item.summary) lines.push('  ' + str(item.summary));
      if (Array.isArray(item.highlights)) {
        item.highlights.forEach(function (h) {
          if (nonEmpty(str(h))) lines.push('  - ' + str(h));
        });
      }
      if (Array.isArray(item.keywords) && item.keywords.length) {
        lines.push('  ' + item.keywords.map(str).filter(nonEmpty).join(', '));
      }
    });
  });

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * One headline line per entry.
 *
 * The section shapes genuinely differ — work has position+name, education has
 * studyType+area+institution, skills has name+level — so a single generic
 * formatter would drop the field that matters in each. Verified against the
 * published schema rather than guessed.
 */
function headlineFor(key, item) {
  var dates = [str(item.startDate), str(item.endDate) || (item.startDate ? 'present' : '')]
    .filter(nonEmpty).join(' – ');
  var head;

  if (key === 'education') {
    head = [str(item.studyType), str(item.area)].filter(nonEmpty).join(' ');
    head = [head, str(item.institution)].filter(nonEmpty).join(' — ');
  } else if (key === 'skills' || key === 'languages' || key === 'interests') {
    head = [str(item.name) || str(item.language), str(item.level) || str(item.fluency)]
      .filter(nonEmpty).join(' — ');
    return head; // these carry no dates
  } else if (key === 'certificates' || key === 'awards') {
    head = [str(item.name) || str(item.title), str(item.issuer) || str(item.awarder)]
      .filter(nonEmpty).join(' — ');
    var when = str(item.date);
    return when ? head + '  (' + when + ')' : head;
  } else {
    // work, projects, volunteer, publications
    head = [str(item.position) || str(item.role), str(item.name) || str(item.organization)]
      .filter(nonEmpty).join(' — ');
  }

  return dates ? head + '  (' + dates + ')' : head;
}

/**
 * Reads one configured value out of a Studio action-invocation payload.
 *
 * The entry carries a TYPED ARRAY keyed by basic type — `stringValues` for a
 * STRING input, `integerValues` for an INTEGER — matching the manifest's
 * declared dataType. Google's calculator does exactly this:
 *
 *   event.workflow.actionInvocation.inputs["value1"].integerValues[0]
 *
 * Note this is NOT the generic add-on card shape
 * (`formInputs[field].stringInputs.value[0]`). That one is real, and correct for
 * a Gmail or Chat card callback — it is simply a different object than a Studio
 * step execution delivers.
 */
function readActionInput(inputs, id) {
  var entry = inputs && inputs[id];
  if (!entry) return '';
  if (Array.isArray(entry.stringValues) && entry.stringValues.length) {
    return str(entry.stringValues[0]).trim();
  }
  return '';
}

function str(v) {
  return (v === null || v === undefined) ? '' : String(v);
}

function nonEmpty(v) {
  return !!v && String(v).length > 0;
}
