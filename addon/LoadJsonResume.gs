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
 * ONE FIELD ON PURPOSE. The whole promise of this step is "point it at your
 * resume.json and it works", so anything else asked here is friction. The hint
 * names the three sources people actually have.
 */
function onConfigLoadJsonResume(event) {
  var saved = (event && event.commonEventObject && event.commonEventObject.formInputs) || {};
  var current = readStringInput(saved, 'resumeUrl');

  var urlInput = CardService.newTextInput()
    .setFieldName('resumeUrl')
    .setTitle('Your JSON Resume URL')
    .setHint(
      'https://registry.jsonresume.org/<username>.json  ·  ' +
      'https://raw.githubusercontent.com/<user>/<repo>/main/resume.json  ·  ' +
      'or any HTTPS URL serving the jsonresume.org schema'
    );
  if (current) {
    urlInput.setValue(current);
  }

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
  var inputs = (event && event.commonEventObject && event.commonEventObject.formInputs) || {};
  var url = readStringInput(inputs, 'resumeUrl');

  var problem = validateUrl(url);
  if (problem) {
    return outputs('', 'Could not load resume: ' + problem, '', '', '');
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
      return outputs('', 'Could not load resume: the URL returned HTTP ' + status + '.', '', '', '');
    }
    raw = response.getContentText();
  } catch (err) {
    return outputs('', 'Could not load resume: ' + err.message, '', '', '');
  }

  if (raw.length > MAX_BYTES) {
    return outputs('', 'Could not load resume: the document exceeds the ' +
      Math.round(MAX_BYTES / 1024 / 1024) + ' MB limit.', '', '', '');
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
    return outputs('', 'Could not load resume: the document is not valid JSON.' + hint, '', '', '');
  }

  if (!resume || typeof resume !== 'object' || Array.isArray(resume)) {
    return outputs('', 'Could not load resume: the document is not a JSON object.', '', '', '');
  }
  // Shape check, not full schema validation. Every field in JSON Resume is
  // optional, so the only honest assertion is that at least one known section
  // is present — a stricter gate would reject legitimate sparse resumes.
  if (!hasAnyKnownSection(resume)) {
    return outputs('', 'Could not load resume: no jsonresume.org sections found ' +
      '(expected at least one of basics, work, education, skills, projects).', '', '', '');
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

/** Every declared output, every time. See onExecuteLoadJsonResume. */
function outputs(resume, resumeText, name, label, email) {
  return {
    resume: resume,
    resumeText: resumeText,
    name: name,
    label: label,
    email: email
  };
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
 * Reads one text value out of a Workspace Studio formInputs payload.
 *
 * The shape is nested — formInputs[field].stringInputs.value is an ARRAY — and
 * getting it wrong is the classic silent bug here: the field reads as empty and
 * the step reports "no URL is configured" while the user can plainly see one.
 */
function readStringInput(formInputs, field) {
  var entry = formInputs && formInputs[field];
  if (!entry) return '';
  var values = entry.stringInputs && entry.stringInputs.value;
  if (Array.isArray(values) && values.length) return str(values[0]).trim();
  if (typeof entry === 'string') return entry.trim(); // tolerate a flattened payload
  return '';
}

function str(v) {
  return (v === null || v === undefined) ? '' : String(v);
}

function nonEmpty(v) {
  return !!v && String(v).length > 0;
}
