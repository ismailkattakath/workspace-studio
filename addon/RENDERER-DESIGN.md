# Design: "Render Resume to Doc" — the companion step

**Status: designed, not built.** The blocker is now CLEARED — `Load JSON Resume` ran on Google's
servers on 2026-09-30 (`onExecute`, 0.91 s, Completed) and its real event payload is pinned in
`test-loadjsonresume.mjs`. The platform contract is no longer a guess, so this design can be
built against something observed instead of inferred.

Two of its four open questions are still open and still only answerable by installing:
whether `drive.file` alone authorises both the create and the `/export`, and whether Gmail's
native send step can attach a Drive file or only interpolate a URL.

Everything below was verified on 2026-09-30 by running the request, not by reading about it.

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

## The design

**We own a Markdown serialiser. Google owns the layout engine.** That is the split the motto
asks for — and `toPlainText()` already proves the serialiser shape is small and testable.

```
tailored résumé string
      ↓  toMarkdown()                      ← the only code we own
      ↓  Drive multipart upload, mimeType application/vnd.google-apps.document
      ↓  GET /drive/v3/files/{id}/export?mimeType=application/pdf
outputs: docId · docUrl · pdfFileId · pdfUrl   (all STRING, cardinality SINGLE)
```

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

1. **Markdown→Doc fidelity** — headings, bullets, bold. If weak, swap the upload's
   `text/markdown` for self-contained `text/html`; the pipeline is otherwise identical.
2. **Does `drive.file` alone authorise both the create AND the `/export`** of the file we just
   created? If export is refused, the fallback adds `drive.readonly` — **re-price the whole
   recommendation if so**, because that is a real scope increase.
3. **Can Gmail's native "Send a message" step attach a Drive file**, or only interpolate
   `pdfUrl` into the body? The indexed corpus is the developer docs only and contains no
   catalogue of native steps. Plan for a link; treat attachment as a bonus.
4. **Drive conversion quota** — Google publishes no conversion row on its quotas page.
