# Design: "Render Resume to Doc" — the companion step

**Status: BUILT and RUN LIVE (2026-10-27).** Live-run findings and fixes: README § The
renderer. The code is `RenderResume.gs`; the tests are
`test-renderresume.mjs`. The blocker cleared first: `Load JSON Resume` ran on Google's servers on
2026-09-30 (`onExecute`, 0.91 s, Completed), and its real event payload is pinned in
`test-loadjsonresume.mjs`.

**Measured 2026-10-27**, with only `drive.file` + `script.external_request`:

| Call | Result |
|---|---|
| Drive REST `files.create`, HTML → Google Doc (multipart) | **works** |
| Docs API `documents.batchUpdate` on that Doc | **works** |
| Drive REST `files/{id}/export?mimeType=application/pdf` | **works** |
| Drive REST `files.create` of the PDF bytes | **works** |
| `DocumentApp.create` / `openById` | **fails**: needs `auth/documents` |
| `DriveApp.getFileById` | **fails**: needs `drive.readonly` or `drive` |

That answers open question 2 below: **`drive.file` alone is enough**, so the scope price holds.

**Gotcha found on the way:** the REST calls first returned **403** *"Google Drive API has not
been used in project …"*. The hidden default Cloud project had the API off. Declaring the Drive
v3 and Docs v1 advanced services in `appsscript.json` (`dependencies.enabledAdvancedServices`)
fixed it, and **adds no scope**.

The sections below up to "Verify these" were verified on 2026-09-30 by running the request.

## Two shortcuts that look obvious and are both dead

**The JSON Resume registry cannot render your résumé to PDF.**

```
GET https://registry.jsonresume.org/thomasdavis.pdf
  → HTTP 400, application/json, 3,615 bytes
```

The body leaks a Playwright stack trace: their serverless function has no Chromium binary.
Retried three times with cache-busting; identical every time, so it is not a cold start. The
registry's own error for an unsupported extension lists what it *does* support —
`json, html, yaml, tex, txt, qr, rendercv, agent, template` — and **`pdf` is not in it.**

**More decisive: the registry is username-keyed, not payload-keyed.**

```
POST /api/format  with a real resume.json body
  → 400 {"code":"NON_EXISTENT_GIST","message":"You have no gists named resume.json..."}
```

It resolves a GitHub username → a gist → a theme. There is no way to hand it arbitrary content.
**The tailored résumé exists only as a string inside the flow run** — it is in nobody's gist and
never will be. So a fetch-from-registry step could only ever deliver the *generic* résumé, which
is the one thing the flow exists to improve on.

Useful anyway, as a free by-product: `/<user>.txt` is an upstream-maintained plain-text render,
and `/<user>` with no extension is self-contained HTML — 0 external stylesheets, 0 scripts, 0
images, CSS inline in two `<style>` blocks. That last property matters: `?theme=elegant` pulls
Bootstrap from a CDN plus scripts and Gravatar images and would import as unstyled soup. **If
themes are ever offered, restrict to self-contained ones and verify each by inspection.**

## A Studio step cannot output a file

The `basicType` enum, verbatim from the corpus (identical on the input- and output-variable
pages):

> `STRING`, `INTEGER`, `TIMESTAMP`, `BOOLEAN`, `EMAIL_ADDRESS`

**No `FILE`, no `BLOB`, no `ATTACHMENT`.** `workflowResourceDefinitions` (custom resources) is a
struct of these scalars, not a byte carrier.

Google's own answer is a **file ID as a STRING** — `studio/drive-picker` does exactly this:
*"When the step runs, it returns the file IDs of the selected items as output variables"*. So
this is the platform's pattern, not a workaround.

## The scope bill drives the design

| Path | Scopes forced | The user is consenting to |
|---|---|---|
| `Load JSON Resume` today | `script.external_request` | outbound HTTPS only |
| **Drive REST v3 via `UrlFetchApp`** | + **`drive.file`** | **only files this add-on creates** |
| `Utilities` blob → PDF | none | nothing new — but see below |
| `DocumentApp` build + export | **`documents`** + **`drive`** | **every Doc, and all of Drive** |

`DriveApp` has no narrow mode — touching it at all requests all of Drive. `DocumentApp.create`
forces `documents` (every Doc the user owns), and you still need Drive to get bytes out.

The `Utilities.newBlob(html).getAs('application/pdf')` trick costs zero scopes and is still
rejected: a step cannot emit a blob (above), the HTML→PDF conversion is **undocumented** (the
`getAs` reference says PDF is valid "for most blobs" and never mentions HTML input), and its
quota is **unpublished**. It would only work if the step also sent the mail itself — which means
`gmail.send`, duplicating a native step, and pulling the attacker-controlled posting into our
code. Strictly worse than `drive.file`.

`ScriptApp.getOAuthToken()` is what makes the narrow path possible: *"The token returned by this
method only includes scopes that the script currently needs"* — so Drive REST can be called
directly with `drive.file` instead of inheriting `DriveApp`'s all-or-nothing scope.

## The design (as built)

**We own an HTML serialiser. Google owns the layout engine.** That is the split the motto
asks for — and `toPlainText()` already proves the serialiser shape is small and testable.

```
tailored résumé string
      ↓  resumeToHtml()                    ← the only real code we own
      ↓  Drive multipart upload (text/html), mimeType application/vnd.google-apps.document
      ↓  documents.batchUpdate: page margins, Normal text style (best-effort)
outputs: docId · docUrl · pdfUrl · docxUrl   (all STRING, cardinality SINGLE)
         pdfUrl/docxUrl = https://docs.google.com/document/d/{id}/export?format=pdf|docx
```

**The Doc is the single artifact (2026-10-27, operator's decision).** The first build also
exported a PDF and stored it beside the Doc. That was removed:

- **One source of truth.** A stored PDF goes stale the moment the Doc is edited.
- **The Doc can be hand-tuned** without touching the JSON, and every export reflects the edit.
- **Docs' own export** covers PDF, DOCX and more, always current. The links are built from the
  id, not fetched, so they need no API call, no allowlist entry and no failure handling.
- **Less code:** the export call, the PDF upload and the best-effort PDF policy are gone.

**Deferred, not rejected: a "Save a PDF copy" option.** Bring it back when a real need appears
for an attachment or a frozen snapshot (e.g. "the version I sent on this date"). The path is
measured: **`drive.file` alone covers `files.export`** of a Doc the add-on created, and the
`files.create` of the PDF bytes (2026-10-27). The removed code is in commit `4329954`
(`driveExportPdf`).

**Changed from the first draft of this design:**

| Was | Now | Why |
|---|---|---|
| `toMarkdown()`, uploaded as `text/markdown` | `resumeToHtml()`, uploaded as `text/html` | HTML was this doc's own fallback (question 1). It is the measured path, and HTML can carry links, bold and lists without depending on Markdown dialect support |
| PDF always, failure undefined | **no stored PDF**: `pdfUrl` and `docxUrl` are Docs export links | see "The Doc is the single artifact" above. (Between 7e8548e and 4329954 the PDF was stored, best-effort.) |
| no allowlist | `urlFetchWhitelist` added | a **versioned** deployment requires it. It cannot say "any host", and a declared list is enforced, so it also narrows Load JSON Resume to the listed résumé hosts |
| (unspecified) | `documents.batchUpdate` sets **page margins** only (0.6 in), best-effort | the first live render ran 6 pages. heading and body sizes are inline styles on each element. `updateNamedStyle` exists and is the fallback, but inline styles are testable offline and add no API call |
| (unspecified) | the résumé is treated as **untrusted**: every value escaped, `href` only for `http(s)` without credentials, `basics.image` dropped | the input often comes from an AI step that read an inbox |

Manifest adds exactly one scope:

```json
"oauthScopes": [
  "https://www.googleapis.com/auth/script.external_request",
  "https://www.googleapis.com/auth/drive.file"
]
```

Drive's import format table confirms the conversion is official: *"Microsoft Word, OpenDocument
Text, HTML, RTF, plain text, Markdown → Google Docs"*. The export endpoint is documented with a
**10 MB** cap on exported content.

Errors use `newReturnElementErrorAction().setErrorLog(...)`, matching the pattern
`LoadJsonResume.gs` already adopted.

## Live run 3 (2026-10-27, on 770ea6f)

| Measured | Result |
|---|---|
| Length | **4 pages**, page 4 holding only 2 lines (run 1: 6 pages) |
| H3 11pt, line-height 1.0, 0.6 in margins, date line 9pt | **confirmed live** |
| Normal text at paragraph level | **still 11pt**: the `updateNamedStyle` call failed (below) |
| `pdfUrl` / `docxUrl` export links | **download directly**: PDF 133 KB, DOCX 16 KB |

**Bug: the Normal-text `batchUpdate` returned HTTP 400** *"Invalid requests[0].updateNamedStyle:
Named style type is required."* The `fields` mask lacked `namedStyleType`. The
[UpdateNamedStyleRequest reference](https://developers.google.com/workspace/docs/api/reference/rest/v1/documents/request#UpdateNamedStyleRequest)
says *"At least `namedStyleType` must be specified."* Fixed: the mask now starts with
`namedStyleType`, and lists leaf paths only, because naming a parent (`textStyle`) resets its
nested fields. Tests assert both; dropping either fails them. The page count with Normal at
10pt is **not yet measured**.

### Trade-off: best-effort styling is invisible to a Studio user

Both styling calls (margins, Normal text) catch their failure, log it with `console.error`, and
let the step succeed. That is why this 400 showed up **only in Apps Script Executions**, never
in Studio's Activity tab, the only place a non-developer looks.

| | Best-effort (now) | Fail the step |
|---|---|---|
| A styling call fails | Doc delivered, a bit longer or looser | **no Doc output**; the flow stops |
| Who notices | a developer reading Executions | the user, in Activity |
| Fits | cosmetic calls on a Doc that already exists | calls the result cannot do without |

**Kept best-effort for now:** the Doc is usable without either call, and hiding a good Doc to
report a cosmetic miss is the worse failure. **The cost is real:** this bug ran silently for a
whole live run. Options if it recurs: a STRING output such as `warnings` (a chip a later step
can show), or `failStep` for styling once the request shapes are proven live. Not changed in
this commit.

## Prior art: essentially none

Searched GitHub for `jsonresume google-apps-script`, `json-resume apps-script`,
`resume.json google docs`, `jsonresume workspace add-on`, `resume DocumentApp`,
`jsonresume theme google docs` — **zero repositories**.

Exactly one relevant file exists (`DavidEngland/resume` → `google.gs`): **no licence**,
container-bound rather than an add-on, one hardcoded username, and uses `basics.website` — a
**pre-v1 schema field**, renamed `url` years ago. Not reusable; worth a glance only for
`DocumentApp` heading/table mechanics, which this design does not use.

Every maintained renderer (`jsonresume-docx`, `jsonresume-to-docx`, `resume-cli`, `resumed`)
targets Node and cannot run in Apps Script — no npm, no filesystem.

## Verify these on first install — none are knowable from here

1. ~~HTML→Doc fidelity~~ **ANSWERED 2026-10-27:** headings, real lists, live links and
   escaping all survive the import. Length did not (6 pages); fixed with inline styles, and
   still to be confirmed by a re-run.
2. ~~Does `drive.file` alone authorise both the create AND the `/export`?~~ **ANSWERED
   2026-10-27: yes.** Create, export and the PDF create all work with `drive.file` alone.
   The step no longer exports (the Doc is the single artifact); the fact is kept for a
   future "Save a PDF copy" option.
5. **Is a declared `urlFetchWhitelist` enforced on a TEST deployment?** The reference says
   only that the field is optional there. Assume yes: the résumé URL's host must be listed.
3. **Can Gmail's native "Send a message" step attach a Drive file**, or only interpolate
   `pdfUrl` into the body? (If it can attach, that is the "real attachment need" that would
   bring back a stored PDF.) The indexed corpus is the developer docs only and contains no
   catalogue of native steps. Plan for a link; treat attachment as a bonus.
4. **Drive conversion quota** — Google publishes no conversion row on its quotas page.
