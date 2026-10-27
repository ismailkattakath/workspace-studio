/**
 * "Load JSON Resume" — a custom step for Google Workspace Studio.
 *
 * Loads the signed-in user's resume from jsonresume.org ("Connect JSON
 * Resume", OAuth 2.1), validates it, and emits it as flow outputs.
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

// Sections rendered into resumeText, in the order a reader expects them.
var TEXT_SECTIONS = ['work', 'projects', 'education', 'skills', 'certificates', 'awards'];

/**
 * ONE SOURCE ON PURPOSE (operator decision, 2026-10-27): the signed-in user's
 * own jsonresume.org resume, through "Sign in with JSON Resume" (OAuth 2.1,
 * PKCE). No URL, paste or Drive field. Connecting tells the user they need a
 * JSON Resume account, and its dashboard keeps the resume (a GitHub gist it
 * creates for them; GitHub sign-in is required there, measured in upstream's
 * gistOperations.js on 2026-10-27).
 *
 * Proven live 2026-10-27: Studio renders the AuthorizationException card in a
 * step, /usercallback completes the sign-in, onExecute reads the token.
 * Studio does not redraw the card after sign-in, and reopening the step does
 * not help either; a page refresh does (live, 2026-10-27), so the card says so.
 */
var JR_ORIGIN = 'https://jsonresume.org';

function onConfigLoadJsonResume() {
  var service = jsonResumeService();
  if (!service.hasAccess()) {
    CardService.newAuthorizationException()
      .setAuthorizationUrl(service.getAuthorizationUrl())
      .setResourceDisplayName('JSON Resume')
      .setCustomUiCallback('jsonResumeConnectCard')
      .throwException();
  }
  return connectedCard();
}

function connectedCard() {
  var who = PropertiesService.getUserProperties().getProperty('JR_USERNAME');
  var section = CardService.newCardSection()
    .addWidget(CardService.newTextParagraph().setText(
      'Connected to <b>JSON Resume</b>' + (who ? ' as <b>@' + escapeHtml(who) + '</b>' : '') +
      '. This step loads your resume from jsonresume.org each time the flow runs.'))
    .addWidget(CardService.newTextButton()
      .setText('Disconnect')
      .setOnClickAction(CardService.newAction().setFunctionName('disconnectJsonResume')));
  return CardService.newCardBuilder()
    .setHeader(CardService.newCardHeader().setTitle('Load JSON Resume'))
    .addSection(section)
    .build();
}

/** The custom sign-in card a public add-on needs instead of Google's generic one. */
function jsonResumeConnectCard() {
  var url = jsonResumeService().getAuthorizationUrl();
  var section = CardService.newCardSection()
    .addWidget(CardService.newTextParagraph().setText(
      'Connect your <b>JSON Resume</b> account to load your resume. ' +
      'No account yet? Create one at jsonresume.org (sign in with GitHub) and add your resume in its dashboard.'))
    .addWidget(CardService.newTextButton()
      .setText('Connect JSON Resume')
      .setAuthorizationAction(CardService.newAuthorizationAction().setAuthorizationUrl(url)))
    .addWidget(CardService.newTextParagraph().setText(
      // Bold, not a link: Studio strips <b> around and inside a card link, and
      // opens card links in a NEW tab, so a link cannot refresh this page
      // (measured live 2026-10-27).
      'After connecting, <b>refresh</b> this page.'));
  return [CardService.newCardBuilder()
    .setHeader(CardService.newCardHeader().setTitle('Load JSON Resume'))
    .addSection(section)
    .build()];
}

function disconnectJsonResume() {
  jsonResumeService().reset();
  PropertiesService.getUserProperties().deleteProperty('JR_USERNAME');
  return CardService.newActionResponseBuilder()
    .setNavigation(CardService.newNavigation().updateCard(jsonResumeConnectCard()[0]))
    .build();
}

/** OAuth2 for Apps Script (vendored at aae9287, the #513 public-client refresh fix). */
function jsonResumeService() {
  return OAuth2.createService('jsonresume')
    .setAuthorizationBaseUrl(JR_ORIGIN + '/oauth/authorize')
    .setTokenUrl(JR_ORIGIN + '/api/oauth/token')
    .setClientId(jsonResumeClientId())
    .setScope('resume:read')
    .generateCodeVerifier()
    .setCallbackFunction('jsonResumeAuthCallback')
    .setPropertyStore(PropertiesService.getUserProperties())
    .setCache(CacheService.getUserCache())
    .setLock(LockService.getUserLock());
}

function jsonResumeAuthCallback(request) {
  var ok = jsonResumeService().handleCallback(request);
  return HtmlService.createHtmlOutput(ok
    ? 'Connected to JSON Resume. Return to Workspace Studio and refresh the page.'
    : 'Not connected. Return to Workspace Studio and try again.');
}

/**
 * The client id, registered once per deployment through jsonresume.org's
 * self-serve dynamic client registration (public client, no secret; measured
 * 2026-10-27). Kept in Script Properties: an identifier, not a secret.
 */
function jsonResumeClientId() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('JR_CLIENT_ID');
  if (id) return id;
  var response = UrlFetchApp.fetch(JR_ORIGIN + '/api/oauth/register', {
    method: 'post',
    contentType: 'application/json',
    muteHttpExceptions: true,
    payload: JSON.stringify({
      client_name: 'JSON Resume for Workspace Studio',
      redirect_uris: ['https://script.google.com/macros/d/' + ScriptApp.getScriptId() + '/usercallback']
    })
  });
  if (response.getResponseCode() >= 300) {
    throw new Error('jsonresume.org client registration returned HTTP ' + response.getResponseCode());
  }
  id = JSON.parse(response.getContentText()).client_id;
  props.setProperty('JR_CLIENT_ID', id);
  return id;
}

/**
 * Runs when the step executes.
 *
 * MUST return every output declared in appsscript.json, or fail the step with
 * a message the user can act on (failStep).
 */
function onExecuteLoadJsonResume(event) {
  // The envelope only: the resume itself is personal data and never logged.
  var inputs = (event && event.workflow && event.workflow.actionInvocation &&
                event.workflow.actionInvocation.inputs) || {};
  console.log('LoadJsonResume inputs present: ' + JSON.stringify(Object.keys(inputs)));

  var service = jsonResumeService();
  if (!service.hasAccess()) {
    return failStep('Could not load resume: not connected to JSON Resume. Open this step and click "Connect JSON Resume".');
  }

  var raw;
  try {
    var response = UrlFetchApp.fetch(JR_ORIGIN + '/api/oauth/resume', {
      headers: { Authorization: 'Bearer ' + service.getAccessToken(), Accept: 'application/json' },
      muteHttpExceptions: true
    });
    var status = response.getResponseCode();
    if (status === 401) {
      service.reset();
      return failStep('Could not load resume: the JSON Resume connection expired or was revoked. Open this step and connect again.');
    }
    if (status === 404) {
      return failStep('Could not load resume: your JSON Resume account has no resume yet. Create it in the jsonresume.org dashboard.');
    }
    if (status < 200 || status >= 300) {
      return failStep('Could not load resume: jsonresume.org returned HTTP ' + status + '.');
    }
    raw = response.getContentText();
  } catch (err) {
    return failStep('Could not load resume: ' + err.message);
  }

  if (raw.length > MAX_BYTES) {
    return failStep('Could not load resume: the document exceeds the ' +
      Math.round(MAX_BYTES / 1024 / 1024) + ' MB limit.');
  }

  var payload;
  try {
    payload = JSON.parse(raw);
  } catch (err) {
    return failStep('Could not load resume: jsonresume.org did not return JSON.');
  }
  // The endpoint wraps it: { username, url, resume } (measured 2026-10-27).
  var unwrapped = unwrapResumePayload(payload);
  if (unwrapped.username) PropertiesService.getUserProperties().setProperty('JR_USERNAME', unwrapped.username);
  var resume = unwrapped.resume;

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
  // The base resume FAILS on a drifted shape rather than being repaired
  // (operator decision, 2026-10-27): the fix belongs in the source.
  // resumeShapeProblems lives in RenderResume.gs (one global scope).
  var problems = resumeShapeProblems(resume);
  if (problems.length) {
    return failStep('Could not load resume: it does not match the jsonresume.org schema: ' +
      problems.slice(0, 5).join('; ') + (problems.length > 5 ? ' (and ' + (problems.length - 5) + ' more)' : '') + '.');
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

/** { username, resume } from /api/oauth/resume's body; a bare resume is accepted too. */
function unwrapResumePayload(payload) {
  if (payload && typeof payload === 'object' && !Array.isArray(payload) &&
      payload.resume && typeof payload.resume === 'object') {
    return { username: str(payload.username), resume: payload.resume };
  }
  return { username: '', resume: payload };
}
