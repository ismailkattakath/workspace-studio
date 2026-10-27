/**
 * "Render Resume to Doc" — the companion step to Load JSON Resume.
 *
 * Takes a resume.json STRING (typically Load JSON Resume's `resume` output, or
 * an AI step's tailored rewrite of it), renders it to HTML, and has Google
 * convert that HTML into a Google Doc. It then exports the Doc to PDF and saves
 * the PDF beside it. Design and measured evidence: RENDERER-DESIGN.md.
 *
 *   resume string -> resumeToHtml() -> Drive files.create (HTML -> Google Doc)
 *                 -> files/{id}/export?mimeType=application/pdf -> files.create (PDF)
 *   outputs: docId, docUrl, pdfFileId, pdfUrl (all STRING)
 *
 * WE OWN THE HTML SERIALISER, AND GOOGLE OWNS THE LAYOUT ENGINE. resumeToHtml()
 * is the only real logic here, and it is pure JavaScript, so
 * test-renderresume.mjs tests it off Google's servers.
 *
 * SCOPES: drive.file + script.external_request, and NOTHING ELSE. Measured
 * 2026-10-27: with only those two, Drive REST create-with-conversion, export
 * and the PDF create all work. DocumentApp.create/openById need
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
var DRIVE_FILES_URL = 'https://www.googleapis.com/drive/v3/files/';
var GOOGLE_DOC_MIME = 'application/vnd.google-apps.document';

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
    .setHint('Defaults to "<your name> — Résumé".')
    .setHostAppDataSource(variables());

  var section = CardService.newCardSection()
    .addWidget(
      CardService.newTextParagraph().setText(
        'Renders a <b>jsonresume.org</b> resume into a Google Doc in your Drive, ' +
        'plus a PDF copy. This step can only see the files it creates.'
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
 * - The PDF export or upload fails: the step SUCCEEDS with the Doc, and pdfFileId
 *   and pdfUrl come back EMPTY. The PDF is a by-product of a Doc that already
 *   exists, and failing the run would hide that Doc from later steps. The reason
 *   goes to the Executions log via console.error, not into a string output.
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

  var pdf = { id: '', webViewLink: '' };
  try {
    var pdfBytes = driveExportPdf(token, doc.id);
    pdf = driveCreate(token, { name: title + '.pdf', mimeType: 'application/pdf' },
      'application/pdf', pdfBytes);
  } catch (err) {
    console.error('RenderResume: Doc created, PDF skipped: ' + err.message);
  }

  return renderOutputs(buildRenderOutputs(doc.id, doc.webViewLink, pdf.id, pdf.webViewLink));
}

// ---- Drive REST (Apps Script only; not reachable from the tests) ----------

/**
 * One multipart files.create. With metadata.mimeType set to a Google Docs type
 * and an HTML body, Drive CONVERTS the upload (the import table lists
 * "HTML -> Google Docs"). With application/pdf, it stores the bytes as they are.
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

/** Drive caps exported content at 10 MB; a résumé is nowhere near that. */
function driveExportPdf(token, fileId) {
  var response = UrlFetchApp.fetch(
    DRIVE_FILES_URL + encodeURIComponent(fileId) + '/export?mimeType=application%2Fpdf', {
      method: 'get',
      headers: { Authorization: 'Bearer ' + token },
      muteHttpExceptions: true
    });
  checkResponse(response, 'files.export');
  return response.getContent();
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
function buildRenderOutputs(docId, docUrl, pdfFileId, pdfUrl) {
  return {
    docId: str(docId),
    docUrl: str(docUrl),
    pdfFileId: str(pdfFileId),
    pdfUrl: str(pdfUrl)
  };
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

function dateRange(start, end) {
  var s = str(start).trim();
  var e = str(end).trim();
  if (!s && !e) return '';
  if (!s) return e;
  return s + ' – ' + (e || 'present');
}

function joinNonEmpty(parts, sep) {
  return parts.map(str).map(function (p) { return p.trim(); })
    .filter(function (p) { return p.length > 0; }).join(sep);
}

/**
 * One entry: a headline (bold left part, dates on the right), an optional
 * subline, a summary paragraph, a bullet list, and a keyword line. Every
 * section reduces to this shape. Each section's own mapping lives in
 * RESUME_SECTIONS, because the field names genuinely differ per section.
 */
function renderEntry(e) {
  var html = '';
  var head = '<b>' + e.title + '</b>';
  if (e.dates) head += ' <span style="color:#555555">· ' + escapeHtml(e.dates) + '</span>';
  html += '<h3>' + head + '</h3>';
  if (e.subtitle) html += '<p><i>' + e.subtitle + '</i></p>';
  if (str(e.summary).trim()) html += '<p>' + escapeHtml(e.summary) + '</p>';
  var bullets = arr(e.bullets).map(str).filter(function (b) { return b.trim(); });
  if (bullets.length) {
    html += '<ul>' + bullets.map(function (b) { return '<li>' + escapeHtml(b) + '</li>'; }).join('') + '</ul>';
  }
  var keywords = arr(e.keywords).map(str).filter(function (k) { return k.trim(); });
  if (keywords.length) html += '<p>' + escapeHtml(keywords.join(', ')) + '</p>';
  return html;
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
    return {
      title: joinNonEmpty([linkOrText(p.url, p.name), escapeHtml(p.entity)], ' — '),
      dates: dateRange(p.startDate, p.endDate),
      subtitle: escapeHtml(joinNonEmpty([arr(p.roles).join(', '), p.type], ' · ')),
      summary: p.description || p.summary, bullets: p.highlights, keywords: p.keywords
    };
  } },
  { key: 'education', heading: 'Education', entry: function (ed) {
    return {
      title: joinNonEmpty([escapeHtml(joinNonEmpty([ed.studyType, ed.area], ' ')),
        linkOrText(ed.url, ed.institution)], ' — '),
      dates: dateRange(ed.startDate, ed.endDate),
      subtitle: escapeHtml(ed.score ? 'Score: ' + str(ed.score) : ''),
      summary: '', bullets: ed.courses
    };
  } },
  { key: 'skills', heading: 'Skills', entry: function (s) {
    return { title: escapeHtml(joinNonEmpty([s.name, s.level], ' — ')), keywords: s.keywords };
  } },
  { key: 'certificates', heading: 'Certifications', entry: function (c) {
    return { title: joinNonEmpty([linkOrText(c.url, c.name), escapeHtml(c.issuer)], ' — '), dates: str(c.date) };
  } },
  { key: 'awards', heading: 'Awards', entry: function (a) {
    return { title: escapeHtml(joinNonEmpty([a.title, a.awarder], ' — ')), dates: str(a.date), summary: a.summary };
  } },
  { key: 'publications', heading: 'Publications', entry: function (p) {
    return {
      title: joinNonEmpty([linkOrText(p.url, p.name), escapeHtml(p.publisher)], ' — '),
      dates: str(p.releaseDate), summary: p.summary
    };
  } },
  { key: 'volunteer', heading: 'Volunteering', entry: function (v) {
    return {
      title: joinNonEmpty([escapeHtml(v.position), linkOrText(v.url, v.organization)], ' — '),
      dates: dateRange(v.startDate, v.endDate), summary: v.summary, bullets: v.highlights
    };
  } },
  { key: 'languages', heading: 'Languages', entry: function (l) {
    return { title: escapeHtml(joinNonEmpty([l.language, l.fluency], ' — ')) };
  } },
  { key: 'interests', heading: 'Interests', entry: function (i) {
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

  if (str(b.name).trim()) out.push('<h1>' + escapeHtml(b.name) + '</h1>');
  if (str(b.label).trim()) out.push('<p><b>' + escapeHtml(b.label) + '</b></p>');

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
  if (contact.length) out.push('<p>' + contact.join(' · ') + '</p>');

  if (str(b.summary).trim()) {
    out.push('<h2>Summary</h2>');
    out.push('<p>' + escapeHtml(b.summary) + '</p>');
  }

  RESUME_SECTIONS.forEach(function (section) {
    var items = objs(r[section.key]);
    if (!items.length) return;
    var body = items.map(function (item) {
      var e = section.entry(item);
      return e.title ? renderEntry(e) : '';
    }).join('');
    if (!body) return;
    out.push('<h2>' + section.heading + '</h2>');
    out.push(body);
  });

  return '<!DOCTYPE html><html><head><meta charset="utf-8"><title>' +
    escapeHtml(docTitleFor(r, '')) + '</title></head>' +
    '<body style="font-family:Arial,sans-serif;font-size:10.5pt;line-height:1.3">' +
    out.join('\n') + '</body></html>';
}
