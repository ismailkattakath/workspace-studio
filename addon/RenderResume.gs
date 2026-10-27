/**
 * "Render Resume to Doc" — the companion step to Load JSON Resume.
 *
 * Takes a resume.json STRING (typically Load JSON Resume's `resume` output, or
 * an AI step's tailored rewrite of it), renders it to HTML, and has Google
 * convert that HTML into a Google Doc. Design and measured evidence:
 * RENDERER-DESIGN.md.
 *
 *   resume string -> resumeToHtml() -> Drive files.create (HTML -> Google Doc)
 *                 -> documents.batchUpdate (margins, Normal text style)
 *   outputs: docId, docUrl, pdfUrl, docxUrl (all STRING)
 *
 * THE DOC IS THE ONLY ARTIFACT. pdfUrl and docxUrl are Docs' own export links,
 * built from the id: they download whatever the Doc says NOW, so a hand edit
 * to the Doc is never out of step with a stored copy. A stored PDF was built
 * once and removed (2026-10-27); RENDERER-DESIGN.md says when it comes back.
 *
 * WE OWN THE HTML SERIALISER, AND GOOGLE OWNS THE LAYOUT ENGINE. resumeToHtml()
 * is the only real logic here, and it is pure JavaScript, so
 * test-renderresume.mjs tests it off Google's servers.
 *
 * SCOPES: drive.file + script.external_request, and NOTHING ELSE. Measured
 * 2026-10-27: with only those two, Drive REST create-with-conversion and Docs
 * documents.batchUpdate work (so did files.export, now unused). DocumentApp.create/openById need
 * .../auth/documents, and DriveApp.getFileById needs drive.readonly or drive.
 * So this file never touches DocumentApp or DriveApp, and it never uses the
 * `Drive`/`Docs` advanced-service globals either. Every Google call is REST
 * through UrlFetchApp with ScriptApp.getOAuthToken(), whose token "only
 * includes scopes that the script currently needs".
 *
 * SHARED GLOBAL SCOPE: Apps Script loads every .gs file of a project into ONE
 * global namespace. This file reuses str(), readActionInput(), failStep(),
 * hasAnyKnownSection() and MAX_BYTES from LoadJsonResume.gs, and so does not redefine them. A second
 * definition would silently replace the first, whichever file loads last. The
 * test loads both files into one context, the same way Apps Script does.
 */

var DRIVE_UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files' +
  '?uploadType=multipart&fields=id,webViewLink';
var DOCS_EXPORT_URL = 'https://docs.google.com/document/d/';
var DOCS_API_URL = 'https://docs.googleapis.com/v1/documents/';
var GOOGLE_DOC_MIME = 'application/vnd.google-apps.document';
var PAGE_MARGIN_PT = 36; // 0.5 inch

/**
 * Configuration card: the resume JSON, plus an optional title.
 *
 * Both fields accept variables (setIncludeVariables). The intended use is to
 * drop Load JSON Resume's `resume` chip, or an AI step's tailored JSON, into
 * the first field. Each setFieldName MUST equal a manifest inputs[].id.
 */
function onConfigRenderResume() {
  var variables = function () {
    return CardService.newHostAppDataSource().setWorkflowDataSource(
      CardService.newWorkflowDataSource().setIncludeVariables(true)
    );
  };

  var resumeInput = CardService.newTextInput()
    .setFieldName('resume')
    .setTitle('Resume JSON')
    .setHint('Pick the "resume" output of Load JSON Resume, or any step that emits resume.json text.')
    .setMultiline(true)
    .setHostAppDataSource(variables());

  var titleInput = CardService.newTextInput()
    .setFieldName('title')
    .setTitle('Document title (optional)')
    .setHint('Defaults to "{your name} — Résumé".')
    .setHostAppDataSource(variables());

  var section = CardService.newCardSection()
    .addWidget(
      CardService.newTextParagraph().setText(
        'Renders a <b>jsonresume.org</b> resume into a Google Doc in your Drive, ' +
        'with PDF and DOCX download links. This step can only see the files it creates.'
      )
    )
    .addWidget(resumeInput)
    .addWidget(titleInput);

  return CardService.newCardBuilder()
    .setHeader(CardService.newCardHeader().setTitle('Render Resume to Doc'))
    .addSection(section)
    .build();
}

/**
 * Runs the step. Returns all four declared outputs on success.
 *
 * Failure policy:
 * - No resume, bad JSON, or the Doc create fails: the step FAILS (failStep).
 *   There is nothing useful to hand on.
 * - A styling call (batchUpdate) fails: the step SUCCEEDS with the Doc as
 *   imported. The reason goes to the Executions log via console.error.
 */
function onExecuteRenderResume(event) {
  // Log the envelope, not the payload: the résumé is personal data, and the
  // Executions log keeps it. The live payload shape is pinned in the tests.
  var invocation = (event && event.workflow && event.workflow.actionInvocation) || {};
  var inputs = invocation.inputs || {};
  console.log('RenderResume inputs present: ' + JSON.stringify(Object.keys(inputs)));

  var parsed = parseResumeInput(readActionInput(inputs, 'resume'));
  if (parsed.error) return failStep('Could not render resume: ' + parsed.error);

  var resume = parsed.resume;
  var title = docTitleFor(resume, readActionInput(inputs, 'title'));
  var token = ScriptApp.getOAuthToken();

  var doc;
  try {
    doc = driveCreate(token, { name: title, mimeType: GOOGLE_DOC_MIME },
      'text/html; charset=UTF-8', utf8Bytes(resumeToHtml(resume)));
  } catch (err) {
    return failStep('Could not create the Google Doc: ' + err.message);
  }

  // Page margins. How the HTML import treats CSS @page is undocumented, so
  // set them explicitly through the
  // Docs API (documents.batchUpdate, measured to work under drive.file on
  // 2026-10-27). Cosmetic, so a failure is logged and the run goes on.
  try {
    docsBatchUpdate(token, doc.id, marginRequests(PAGE_MARGIN_PT));
  } catch (err) {
    console.error('RenderResume: margins not applied: ' + err.message);
  }
  // Normal text's paragraph-level size and spacing (see namedStyleRequests).
  // A separate call, so a rejection here cannot cost the margins above.
  try {
    docsBatchUpdate(token, doc.id, namedStyleRequests());
  } catch (err) {
    console.error('RenderResume: Normal text style not applied: ' + err.message);
  }

  return renderOutputs(buildRenderOutputs(doc.id, doc.webViewLink));
}

// ---- Drive REST (Apps Script only; not reachable from the tests) ----------

/**
 * One multipart files.create. With metadata.mimeType set to a Google Docs type
 * and an HTML body, Drive CONVERTS the upload (the import table lists
 * "HTML -> Google Docs").
 */
function driveCreate(token, metadata, mediaType, mediaBytes) {
  var boundary = 'render-resume-' + Utilities.getUuid();
  var parts = multipartFrame(boundary, metadata, mediaType);
  var body = utf8Bytes(parts.head).concat(mediaBytes, utf8Bytes(parts.tail));
  var response = UrlFetchApp.fetch(DRIVE_UPLOAD_URL, {
    method: 'post',
    contentType: 'multipart/related; boundary=' + boundary,
    payload: body,
    headers: { Authorization: 'Bearer ' + token },
    muteHttpExceptions: true
  });
  var file = JSON.parse(checkResponse(response, 'files.create'));
  return { id: str(file.id), webViewLink: str(file.webViewLink) };
}

/** documents.batchUpdate: Docs REST v1, same token, same no-DocumentApp rule. */
function docsBatchUpdate(token, docId, requests) {
  var response = UrlFetchApp.fetch(DOCS_API_URL + encodeURIComponent(docId) + ':batchUpdate', {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ requests: requests }),
    headers: { Authorization: 'Bearer ' + token },
    muteHttpExceptions: true
  });
  return checkResponse(response, 'documents.batchUpdate');
}

/**
 * Throws with Google's own error message when the call failed.
 *
 * The message matters. The first live run got a 403 "Google Drive API has not
 * been used in project …". The fix was the advanced-service declaration in
 * appsscript.json, and only Google's text said so.
 */
function checkResponse(response, what) {
  var status = response.getResponseCode();
  var text = response.getContentText();
  if (status >= 200 && status < 300) return text;
  var detail = text;
  try { detail = JSON.parse(text).error.message || text; } catch (e) { /* not JSON */ }
  throw new Error(what + ' returned HTTP ' + status + ': ' + str(detail).slice(0, 300));
}

function utf8Bytes(s) {
  return Utilities.newBlob('').setDataFromString(s, 'UTF-8').getBytes();
}

function renderOutputs(plain) {
  var variableDataMap = {};
  Object.keys(plain).forEach(function (key) {
    variableDataMap[key] = AddOnsResponseService.newVariableData().addStringValue(plain[key]);
  });
  var workflowAction = AddOnsResponseService.newReturnOutputVariablesAction()
    .setVariableDataMap(variableDataMap);
  var hostAppAction = AddOnsResponseService.newHostAppAction().setWorkflowAction(workflowAction);
  return AddOnsResponseService.newRenderActionBuilder().setHostAppAction(hostAppAction).build();
}

// ---- Pure half: tested by test-renderresume.mjs ----------------------------

/** Every declared output, every time, as a plain map. */
function buildRenderOutputs(docId, docUrl) {
  return {
    docId: str(docId),
    docUrl: str(docUrl),
    pdfUrl: exportUrl(docId, 'pdf'),
    docxUrl: exportUrl(docId, 'docx')
  };
}

/**
 * Docs' own export link for a format. It downloads the Doc as it is when the
 * link is opened, so it is never stale. Nothing here fetches it: it is a link
 * for a person, so it needs no allowlist entry.
 *
 * A Drive file id is [A-Za-z0-9_-]. Anything else is not a Drive id, and the
 * link is left EMPTY rather than built from it.
 */
function exportUrl(docId, format) {
  var id = str(docId);
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return '';
  return DOCS_EXPORT_URL + id + '/export?format=' + encodeURIComponent(format);
}

/**
 * The text frame around one multipart/related body (RFC 2387; Drive's
 * "multipart upload"). The media bytes go between head and tail.
 */
function multipartFrame(boundary, metadata, mediaType) {
  var head = '--' + boundary + '\r\n' +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    JSON.stringify(metadata) + '\r\n' +
    '--' + boundary + '\r\n' +
    'Content-Type: ' + mediaType + '\r\n\r\n';
  var tail = '\r\n--' + boundary + '--\r\n';
  return { head: head, tail: tail };
}

/**
 * Parses the resume input. Returns {resume} or {error}, and never throws.
 *
 * The input is often an AI step's output, so it is wrapped in a ```json fence
 * more often than not. The fence is stripped rather than rejected.
 */
function parseResumeInput(text) {
  var raw = str(text).trim();
  if (!raw) return { error: 'no resume JSON was given. Open the step and pick the "resume" output of Load JSON Resume.' };
  if (raw.length > MAX_BYTES) return { error: 'the resume exceeds the ' + Math.round(MAX_BYTES / 1024 / 1024) + ' MB limit.' };

  var fenced = /^```[a-zA-Z]*\s*\n([\s\S]*?)\n?```$/.exec(raw);
  if (fenced) raw = fenced[1].trim();

  var resume;
  try {
    resume = JSON.parse(raw);
  } catch (e) {
    return { error: 'the input is not valid JSON.' };
  }
  if (!resume || typeof resume !== 'object' || Array.isArray(resume)) {
    return { error: 'the input is not a JSON object.' };
  }
  if (!hasAnyKnownSection(resume)) {
    return { error: 'no jsonresume.org sections found (expected basics, work, education, skills or projects).' };
  }
  return { resume: resume };
}

function docTitleFor(resume, configured) {
  var t = str(configured).trim();
  if (t) return t.slice(0, 200);
  var name = resume && resume.basics && typeof resume.basics === 'object' ? str(resume.basics.name).trim() : '';
  return name ? name + ' — Résumé' : 'Résumé';
}

/**
 * The HTML escape. EVERY résumé value goes through it, because the résumé is
 * untrusted. It arrives from a URL or from an AI step that read a job posting
 * from an inbox.
 */
function escapeHtml(v) {
  return str(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * An href is safe only when it starts with https:// or http://. Escaping alone
 * is not enough: a javascript: URL passes straight through an HTML escape.
 * Returns '' for anything else, and the caller then renders plain text.
 */
function safeWebUrl(v) {
  var u = str(v).trim();
  if (!/^https?:\/\/[^\s"'<>]+$/i.test(u)) return '';
  if (u.indexOf('@') !== -1 && u.indexOf('@') < (u.indexOf('/', 8) === -1 ? u.length : u.indexOf('/', 8))) return '';
  return u;
}

function safeEmail(v) {
  var e = str(v).trim();
  return /^[^\s@<>"'()\\,;:]+@[^\s@<>"'()\\,;:]+\.[^\s@<>"'()\\,;:]+$/.test(e) ? e : '';
}

/** A link when the URL is safe, plain escaped text when it is not. */
function linkOrText(url, text) {
  var safe = safeWebUrl(url);
  var label = escapeHtml(text || url);
  return safe ? '<a href="' + escapeHtml(safe) + '">' + label + '</a>' : label;
}

function arr(v) {
  return Array.isArray(v) ? v.filter(function (x) { return x !== null && x !== undefined && x !== ''; }) : [];
}

function objs(v) {
  return arr(v).filter(function (x) { return typeof x === 'object' && !Array.isArray(x); });
}

var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * ISO 8601 (the schema's date format) to the form résumé themes print:
 * "2024" stays "2024", "2024-08" and "2024-08-01" become "Aug 2024". The day
 * is dropped, as themes do. Anything else ("Summer 2019", a bad month) comes
 * back as it was, trimmed: a wrong guess is worse than the raw string.
 */
function formatDate(v) {
  var s = str(v).trim();
  var m = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(s);
  if (!m) return s;
  if (!m[2]) return m[1];
  var month = parseInt(m[2], 10);
  if (month < 1 || month > 12) return s;
  if (m[3]) {
    var day = parseInt(m[3], 10);
    if (day < 1 || day > 31) return s;
  }
  return MONTHS[month - 1] + ' ' + m[1];
}

function dateRange(start, end) {
  var s = formatDate(start);
  var e = formatDate(end);
  if (!s && !e) return '';
  if (!s) return e;
  return s + ' – ' + (e || 'Present');
}

function joinNonEmpty(parts, sep) {
  return parts.map(str).map(function (p) { return p.trim(); })
    .filter(function (p) { return p.length > 0; }).join(sep);
}

/**
 * Inline styles, ON EVERY ELEMENT. The live run (2026-10-27) came out at 6
 * pages: the import maps h1/h2/h3 to the Doc's named Heading styles (H1 at
 * Arial 24) and did not carry the body's font-size down to them. An inline
 * style on the element itself is the one place the import reads per
 * paragraph. (batchUpdate's updateNamedStyle could restyle Heading 1-3
 * instead. Inline styles were chosen because they live in the HTML this file
 * tests offline, and cost no extra API call or failure mode. If a re-run
 * shows the import dropping them, updateNamedStyle is the fallback.)
 *
 * WHOLE POINTS ONLY. The second live run (2026-10-27) asked for an h3 at
 * 10.5pt and the Doc came back with 10pt text runs: the import appears to
 * round half-points down. So every size here is an integer.
 *
 * Spacing (second live run: 4 pages, last one half full; target 2-3): line
 * height 1.0 instead of 1.15, and tighter block margins. Untested live.
 */
var FONT = 'font-family:Arial,sans-serif;line-height:1.0;';
var STYLES = {
  h1: FONT + 'font-size:18pt;font-weight:bold;margin:0 0 2pt 0',
  label: FONT + 'font-size:11pt;font-weight:bold;margin:0 0 2pt 0',
  h2: FONT + 'font-size:12pt;font-weight:bold;margin:8pt 0 2pt 0',
  h3: FONT + 'font-size:11pt;font-weight:bold;margin:4pt 0 0 0',
  meta: FONT + 'font-size:9pt;color:#555555;margin:0 0 1pt 0',
  p: FONT + 'font-size:10pt;margin:0 0 2pt 0',
  ul: 'margin:0 0 2pt 0',
  li: FONT + 'font-size:10pt;margin:0'
};

/**
 * Named-style requests for the Doc's Normal text. The second live run showed
 * each paragraph keeping Normal text's 11pt / 1.15 at PARAGRAPH level (only
 * the text runs were 10pt), which likely adds line height per paragraph.
 * Setting Normal text to 10pt, single spacing, no paragraph gaps fixes that
 * at the source. Sent as its own best-effort batchUpdate.
 *
 * THE FIELDS MASK MUST START WITH namedStyleType. The Docs API reference for
 * UpdateNamedStyleRequest: "At least `namedStyleType` must be specified." Live
 * run 3 (2026-10-27) sent a mask without it and got HTTP 400 "Named style type
 * is required", which this step logged and swallowed, so Normal stayed 11pt.
 * The mask lists LEAF paths only: per the same reference, naming a parent
 * ("textStyle") resets all of its nested fields not given here.
 * https://developers.google.com/workspace/docs/api/reference/rest/v1/documents/request#UpdateNamedStyleRequest
 */
function namedStyleRequests() {
  return [{
    updateNamedStyle: {
      namedStyle: {
        namedStyleType: 'NORMAL_TEXT',
        textStyle: { fontSize: { magnitude: 10, unit: 'PT' } },
        paragraphStyle: {
          lineSpacing: 100,
          spaceAbove: { magnitude: 0, unit: 'PT' },
          spaceBelow: { magnitude: 0, unit: 'PT' }
        }
      },
      fields: 'namedStyleType,textStyle.fontSize,paragraphStyle.lineSpacing,' +
        'paragraphStyle.spaceAbove,paragraphStyle.spaceBelow'
    }
  }];
}

/** One element with its inline style. `inner` is already-escaped HTML. */
function el(tag, styleKey, inner) {
  return '<' + tag + ' style="' + STYLES[styleKey] + '">' + inner + '</' + tag + '>';
}

/** The Docs API requests that set all four page margins, in points. */
function marginRequests(pt) {
  var m = { magnitude: pt, unit: 'PT' };
  return [{
    updateDocumentStyle: {
      documentStyle: { marginTop: m, marginBottom: m, marginLeft: m, marginRight: m },
      fields: 'marginTop,marginBottom,marginLeft,marginRight'
    }
  }];
}

/**
 * One entry: the title as an h3, then ONE small grey line with the dates and
 * any subline ("Aug 2024 – Mar 2026 · Toronto"), then summary, bullets and
 * keywords.
 *
 * Dates are NOT in the h3. Inside it, a long title pushed "– 2026-03-01" onto
 * a line of its own (live run, 2026-10-27). A right-aligned tab stop would
 * need a Docs API range edit after import, and a two-cell table imports with
 * borders and confuses ATS parsers. A separate line is the one layout the
 * HTML import is certain to keep.
 */
function renderEntry(e) {
  var html = el('h3', 'h3', e.title);
  var meta = [e.dates ? escapeHtml(e.dates) : '', e.subtitle || ''].filter(function (x) { return x; });
  if (meta.length) html += el('p', 'meta', meta.join(' · '));
  if (str(e.summary).trim()) html += el('p', 'p', escapeHtml(e.summary));
  var bullets = arr(e.bullets).map(str).filter(function (b) { return b.trim(); });
  if (bullets.length) {
    html += el('ul', 'ul', bullets.map(function (b) { return el('li', 'li', escapeHtml(b)); }).join(''));
  }
  var keywords = arr(e.keywords).map(str).filter(function (k) { return k.trim(); });
  if (keywords.length) html += el('p', 'p', escapeHtml(keywords.join(', ')));
  return html;
}

/**
 * A compact entry: ONE paragraph, "Title: keyword, keyword". Used for skills,
 * languages and interests, which carry no dates or bullets. As an h3 plus a
 * keyword paragraph, the live résumé's skills section spent two lines and a
 * heading gap on every group.
 */
function renderCompactEntry(e) {
  var keywords = arr(e.keywords).map(str).filter(function (k) { return k.trim(); });
  return el('p', 'p', '<b>' + e.title + '</b>' + (keywords.length ? ': ' + escapeHtml(keywords.join(', ')) : ''));
}

/**
 * Section order, heading and field mapping, per resume-schema v1
 * (https://github.com/jsonresume/resume-schema). `title` and `subtitle` return
 * HTML, which is why every value they use goes through escapeHtml/linkOrText.
 */
var RESUME_SECTIONS = [
  { key: 'work', heading: 'Experience', entry: function (w) {
    return {
      title: joinNonEmpty([escapeHtml(w.position), linkOrText(w.url, w.name || w.company)], ' — '),
      dates: dateRange(w.startDate, w.endDate),
      subtitle: escapeHtml(joinNonEmpty([w.location, w.description], ' · ')),
      summary: w.summary, bullets: w.highlights
    };
  } },
  { key: 'projects', heading: 'Projects', entry: function (p) {
    // p.type is a free-form category ("application", "volunteering"). Printed
    // raw it read as an enum, so it is left out.
    return {
      title: joinNonEmpty([linkOrText(p.url, p.name), escapeHtml(p.entity)], ' — '),
      dates: dateRange(p.startDate, p.endDate),
      subtitle: escapeHtml(arr(p.roles).map(str).join(', ')),
      summary: p.description || p.summary, bullets: p.highlights, keywords: p.keywords
    };
  } },
  { key: 'education', heading: 'Education', entry: function (ed) {
    return {
      title: joinNonEmpty([escapeHtml(joinNonEmpty([ed.studyType, ed.area], ', ')),
        linkOrText(ed.url, ed.institution)], ' — '),
      dates: dateRange(ed.startDate, ed.endDate),
      subtitle: escapeHtml(ed.score ? 'Score: ' + str(ed.score) : ''),
      summary: '', bullets: ed.courses
    };
  } },
  { key: 'skills', heading: 'Skills', compact: true, entry: function (s) {
    return { title: escapeHtml(joinNonEmpty([s.name, s.level], ' — ')), keywords: s.keywords };
  } },
  { key: 'certificates', heading: 'Certifications', entry: function (c) {
    return { title: joinNonEmpty([linkOrText(c.url, c.name), escapeHtml(c.issuer)], ' — '), dates: formatDate(c.date) };
  } },
  { key: 'awards', heading: 'Awards', entry: function (a) {
    return { title: escapeHtml(joinNonEmpty([a.title, a.awarder], ' — ')), dates: formatDate(a.date), summary: a.summary };
  } },
  { key: 'publications', heading: 'Publications', entry: function (p) {
    return {
      title: joinNonEmpty([linkOrText(p.url, p.name), escapeHtml(p.publisher)], ' — '),
      dates: formatDate(p.releaseDate), summary: p.summary
    };
  } },
  { key: 'volunteer', heading: 'Volunteering', entry: function (v) {
    return {
      title: joinNonEmpty([escapeHtml(v.position), linkOrText(v.url, v.organization)], ' — '),
      dates: dateRange(v.startDate, v.endDate), summary: v.summary, bullets: v.highlights
    };
  } },
  { key: 'languages', heading: 'Languages', compact: true, entry: function (l) {
    return { title: escapeHtml(joinNonEmpty([l.language, l.fluency], ' — ')) };
  } },
  { key: 'interests', heading: 'Interests', compact: true, entry: function (i) {
    return { title: escapeHtml(i.name), keywords: i.keywords };
  } },
  { key: 'references', heading: 'References', entry: function (r) {
    return { title: escapeHtml(r.name), summary: r.reference };
  } }
];

/**
 * resume.json -> one self-contained HTML document: single column, inline
 * styles only, no scripts and no external resources. basics.image is left out
 * ON PURPOSE. An external image URL in an untrusted document is a tracking
 * beacon, and a résumé photo is a regional convention, not a default.
 *
 * Absent, empty or wrongly-typed sections are skipped, never rendered as an
 * empty heading. Every schema field is optional.
 */
function resumeToHtml(resume) {
  var r = (resume && typeof resume === 'object') ? resume : {};
  var b = (r.basics && typeof r.basics === 'object' && !Array.isArray(r.basics)) ? r.basics : {};
  var out = [];

  if (str(b.name).trim()) out.push(el('h1', 'h1', escapeHtml(b.name)));
  if (str(b.label).trim()) out.push(el('p', 'label', escapeHtml(b.label)));

  var loc = (b.location && typeof b.location === 'object') ? b.location : {};
  var email = safeEmail(b.email);
  var contact = [
    email ? '<a href="mailto:' + escapeHtml(email) + '">' + escapeHtml(email) + '</a>' : escapeHtml(b.email),
    escapeHtml(b.phone),
    str(b.url).trim() ? linkOrText(b.url, b.url) : '',
    escapeHtml(joinNonEmpty([loc.city, loc.region, loc.countryCode], ', '))
  ];
  objs(b.profiles).forEach(function (p) {
    var label = joinNonEmpty([p.network, p.username], ': ');
    contact.push(str(p.url).trim() ? linkOrText(p.url, label || p.url) : escapeHtml(label));
  });
  contact = contact.filter(function (c) { return c; });
  if (contact.length) out.push(el('p', 'meta', contact.join(' · ')));

  if (str(b.summary).trim()) {
    out.push(el('h2', 'h2', 'Summary'));
    out.push(el('p', 'p', escapeHtml(b.summary)));
  }

  RESUME_SECTIONS.forEach(function (section) {
    var items = objs(r[section.key]);
    if (!items.length) return;
    var body = items.map(function (item) {
      var e = section.entry(item);
      if (!e.title) return '';
      return section.compact ? renderCompactEntry(e) : renderEntry(e);
    }).join('');
    if (!body) return;
    out.push(el('h2', 'h2', section.heading));
    out.push(body);
  });

  return '<!DOCTYPE html><html><head><meta charset="utf-8"><title>' +
    escapeHtml(docTitleFor(r, '')) + '</title></head>' +
    '<body style="' + FONT + 'font-size:10pt">' +
    out.join('\n') + '</body></html>';
}
