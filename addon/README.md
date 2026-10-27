# JSON Resume steps for Google Workspace Studio

Two custom steps in one add-on:

| Step | Does | File |
|---|---|---|
| **Load JSON Resume** | loads your résumé from your JSON Resume account (**Connect JSON Resume**), validates it, and emits it as outputs | `LoadJsonResume.gs` |
| **Render Resume to Doc** | renders a `resume.json` string into a Google Doc, with PDF and DOCX download links | `RenderResume.gs` |

## Load JSON Resume

Loads **your own** résumé from your [jsonresume.org](https://jsonresume.org) account through
**Connect JSON Resume** ("Sign in with JSON Resume", OAuth 2.1), and hands it to the rest of
your flow. **That is the only source**, on purpose (2026-10-27): no URL, paste or Drive field.
Connecting tells a new user they need a JSON Resume account, and its dashboard keeps the résumé
for them.

**The résumé must match the [jsonresume.org schema](https://github.com/jsonresume/resume-schema).**
An invalid shape **fails the step** with the first problems listed. It is never repaired: this is
the base résumé, so the fix belongs at the source.

## What it does, and what it deliberately doesn't

**It does not tailor your résumé.** Workspace Studio flows already have a native *"ask Gemini"*
step, so the tailoring belongs there. That split is the whole design:

- **no API key** for you to obtain, store or pay for
- **composes** with whatever AI step you prefer
- **deterministic**, so it can actually be tested
- and — the important one — **this step never reads the job posting**. A posting arriving from
  an inbox is attacker-controlled text. Here it is simply never touched; the AI step does the
  matching.

## The flow

```
[starter: posting arrives]
        ↓
[Load JSON Resume]  ← this step
        ↓
[ask Gemini: tailor this résumé to this posting]
        ↓
[Render Resume to Doc]  ← optional: the tailored résumé as a Google Doc
        ↓
[Gmail: create draft]   ← put docUrl / pdfUrl / docxUrl in the body
```

## Configuration: Connect JSON Resume

The step has **no fields**. Its card shows one button:

| Card state | Shows |
|---|---|
| Not connected | **Connect JSON Resume**, plus "After connecting, refresh this page" |
| Connected | "Connected to JSON Resume as @username", plus **Disconnect** |

1. **No account yet?** Create one at jsonresume.org. **Sign in with GitHub:** the dashboard stores
   your résumé as a GitHub gist it creates for you, using your GitHub sign-in (upstream
   `gistOperations.js`, read 2026-10-27). An email-and-password account cannot create one.
2. Click **Connect JSON Resume** and approve **"Read your resume"** on jsonresume.org.
3. **Refresh the Studio page** (the card's **refresh** link opens this flow fresh in a new tab).
   Studio does not redraw a step card after a sign-in in another tab, and reopening the step
   does not help, measured 2026-10-27. Clicking Connect again also shows it connected.

**Known upstream bug:** signing in to jsonresume.org **with GitHub** during Connect lands on
`/dashboard` instead of the approval screen
([jsonresume/jsonresume.org#636](https://github.com/jsonresume/jsonresume.org/issues/636)).
Click **Connect JSON Resume** again.

**How the connection works:**

| Piece | Value | Evidence |
|---|---|---|
| Library | [OAuth2 for Apps Script](https://github.com/googleworkspace/apps-script-oauth2), vendored as `OAuth2.gs` at `aae9287` (Apache-2.0) | that commit fixes token refresh for clients without a secret (#513) |
| Client | registered once per deployment through jsonresume.org's self-serve dynamic client registration (`/api/oauth/register`): a public client, **no secret** | measured 2026-10-27 |
| Security | PKCE S256 (required by jsonresume.org) | measured |
| Redirect | `https://script.google.com/macros/d/{scriptId}/usercallback` | measured: accepted |
| Scope | `resume:read` | |
| Tokens | access 1 h, refresh 90 days, kept in the user's own `UserProperties` | measured |
| Fetch | `GET https://jsonresume.org/api/oauth/resume` → `{ username, url, resume }` | measured: 200 |

## Outputs

| Output | Type | Use |
|---|---|---|
| `resume` | STRING | the raw `resume.json`, for any step that wants structure |
| `resumeText` | STRING | flattened plain text — **this is what you feed the AI step** |
| `name` | STRING | `basics.name`, for addressing replies |
| `label` | STRING | `basics.label` — the headline |
| `email` | STRING | `basics.email` |

`resumeText` renders `basics` then `work`, `projects`, `education`, `skills`, `certificates`,
`awards`, each entry as a headline plus summary plus highlights. Measured on a real registry
résumé: 10,605 characters over 123 lines.

## Render Resume to Doc

Takes a résumé as JSON text, usually Load JSON Resume's `resume` output or an AI step's tailored
rewrite of it. It renders the résumé to a single-column HTML document. Google converts that into
a **Google Doc** in your Drive. **The Doc is the only file the step creates.**

PDF and DOCX come from Docs' own export links, built from the Doc's id. A link downloads the Doc
**as it is when you open it**, so a hand edit to the Doc is never out of step with a stored copy.
The step fetches nothing to build them.

| Input | Required | Notes |
|---|---|---|
| `resume` | yes | JSON text in the jsonresume.org standard. A ```` ```json ```` fence from an AI step is stripped |
| `title` | no | defaults to `<basics.name> — Résumé` |

| Output | Type | Use |
|---|---|---|
| `docId` | STRING | Drive file ID of the Doc |
| `docUrl` | STRING | link to the Doc, for a Gmail or Chat step |
| `pdfUrl` | STRING | `https://docs.google.com/document/d/{id}/export?format=pdf` |
| `docxUrl` | STRING | `https://docs.google.com/document/d/{id}/export?format=docx` |

The export links open for anyone who can open the Doc, i.e. the owner by default. Share the Doc
to share them.

A Studio step cannot output a file: output types are scalars only. So the step returns file IDs
and links, which is the same pattern Google's own Drive picker uses.

**Failure policy:**

- No résumé, bad JSON, or a failed Doc create → the step **fails**, with the reason in Activity.
- A failed styling call (`documents.batchUpdate`) → the step **succeeds** with the Doc as
  imported. The reason goes to the Executions log.

**Sections rendered**, in order, each skipped when absent or empty: basics (name, label,
contact, profiles, summary), work, projects, education, skills, certificates, awards,
publications, volunteer, languages, interests, references.

**The résumé is untrusted input.** It may come from an AI step that read a job posting from an
inbox. So every value is HTML-escaped. A link becomes an `href` only for `http(s)://` URLs
without credentials, so `javascript:` and `data:` URLs render as plain text. `basics.image` is
left out on purpose: an external image URL is a tracking beacon.

## Scopes

| Scope | Needed by | Grants |
|---|---|---|
| `script.external_request` | both steps | outbound HTTPS (jsonresume.org sign-in and fetch; Drive/Docs REST) |
| `drive.file` | Render Resume to Doc | **only the files this add-on creates** |

Neither step reads your mail or calendar. The renderer cannot see any Drive file it did not
create itself.

**Measured 2026-10-27, with only those two scopes:**

| Call | Result |
|---|---|
| Drive REST `files.create`, HTML → Google Doc (multipart upload) | **works** |
| Docs API `documents.batchUpdate` on that Doc | **works** (the step sets page margins with it) |
| Drive REST `files/{id}/export?mimeType=application/pdf` | **works** (no longer called; see below) |
| Drive REST `files.create` of the PDF bytes | **works** (no longer called) |
| `DocumentApp.create` / `openById` | **fails**: needs `auth/documents` |
| `DriveApp.getFileById` | **fails**: needs `drive.readonly` or `drive` |

So `RenderResume.gs` uses **no `DocumentApp` and no `DriveApp`**. It calls REST through
`UrlFetchApp` with `ScriptApp.getOAuthToken()`. The tests assert that.

## Install

1. Create an Apps Script project, set it to the **V8** runtime.
2. Copy `LoadJsonResume.gs`, `RenderResume.gs`, `OAuth2.gs` and `appsscript.json` into it.
3. Deploy as a Workspace add-on and add the steps to a flow.

`RenderResume.gs` reuses `str()`, `readActionInput()`, `failStep()`, `hasAnyKnownSection()` and
`MAX_BYTES` from `LoadJsonResume.gs`, and Load uses `resumeShapeProblems()` and `escapeHtml()`
from `RenderResume.gs`. Apps Script loads every `.gs` file into **one global
scope**, so both files must be in the project, and neither may redefine the other's functions.

## Tests

```bash
nix run nixpkgs#nodejs -- addon/test-loadjsonresume.mjs
nix run nixpkgs#nodejs -- addon/test-renderresume.mjs
```

`test-renderresume.mjs` loads both `.gs` files into one context, the way Apps Script does. It
checks HTML escaping against a hostile résumé, the `href` guard, section order and absence, and
the manifest contract: declared outputs, callbacks, card-field bindings, the two-scope bill and
the URL allowlist. All of it runs inside `nix flake check`; only the live-registry renders skip
offline.

Apps Script cannot run off Google's servers, so the Workspace Studio integration itself has to
be verified by installing the add-on. Everything that does **not** touch `CardService` or
`UrlFetchApp` is plain JavaScript, and that is where the bugs live — so the sign-in response
unwrapping, the `formInputs` shape and the per-section headline formatting are tested against **real résumés
fetched from the live registry**, not fixtures written to match the code.

## Notes from building it

These were **wrong in the first version** and are corrected here. The first draft of this file
presented the wrong shape as a hard-won lesson, which is worse than saying nothing — it would
have stopped the next person re-checking.

- **A Studio step does NOT read `commonEventObject.formInputs`.** That shape is real and correct
  for a Gmail or Chat card callback, and it is the wrong object here. A step execution delivers
  its configured values at `event.workflow.actionInvocation.inputs[id].stringValues[0]` — typed
  arrays keyed by the manifest's declared `dataType`. At execute time `commonEventObject` holds
  only `timeZone`, `userLocale`, `hostApp` and `platform`; there is no `formInputs` key at all.
  Google's calculator reads `…inputs["value1"].integerValues[0]`.
- **A configuration field must be declared in the manifest's `inputs[]`.** There is no
  "config-only field". The card's `setFieldName('x')` binds to `inputs[].id === 'x'`, and that
  binding *is* the delivery channel — Google's own sample carries the comment
  `//"FieldName" must match an "id" in the manifest file's inputs[] array.` With `"inputs": []`
  the widget is an orphan and the typed value has nowhere to arrive.
- **`onConfigFunction` takes no event parameter and does not prefill.** Every Studio example
  declares it bare. No Studio page uses `setValue` to restore a saved field — Studio re-renders
  saved values itself through the binding above.
- **`onExecuteFunction` must return a `RenderAction`, not a plain object.** Wrap the outputs in
  `AddOnsResponseService.newReturnOutputVariablesAction().setVariableDataMap(...)`. Returning a
  bare `{id: value}` map errors the step.
- **Fail with `newReturnElementErrorAction().setErrorLog(...)`.** Writing the reason into a
  string output and returning success is wrong twice: the flow continues as though it has a
  résumé, and the Activity tab — the only place a non-developer looks — shows nothing but the
  step's name.
- **`setHostAppDataSource(...setIncludeVariables(true))` on the TextInput**, or the user cannot
  pipe a variable from an earlier step into the field.
- **Shape check, not schema validation.** Every JSON Resume field is optional, so the only
  honest assertion is that one known section exists. A stricter gate rejects sparse résumés.
- **HTTPS only, no credentials in the URL**, and name the HTML-instead-of-JSON case explicitly —
  pasting a GitHub *page* URL rather than the raw one is the commonest mistake.

### Why the tests did not catch any of this

They asserted the same wrong shape the code used. Green, self-consistent, and proving nothing
about the platform. **A test that agrees with the code about the wrong thing is worse than no
test.** They now assert the `actionInvocation` payload and carry two regression guards: the old
`formInputs` shape must be *rejected*, and an integer input must not masquerade as a string.

## The renderer: built, and run live

[`RENDERER-DESIGN.md`](RENDERER-DESIGN.md) is the design for **Render Resume to Doc**, which is
now **built** (`RenderResume.gs`). It waited until Load JSON Resume had run for real, and that
happened on 2026-09-30. The design also records two dead ends, verified by running them: the
JSON Resume registry's `.pdf` endpoint is broken in production, and the registry is
username-keyed, so it can never render a *tailored* résumé.

**Ran live on 2026-10-27:** the flow reported *Run Completed* and produced a Doc plus a PDF.
The structure was faithful: H1/H2/H3 headings, real lists, live links, correct escaping. Eight
findings came back and are fixed:

| # | Finding | Fix | Test |
|---|---|---|---|
| 1 | **6 pages** (last nearly empty) for a 19 KB résumé | inline `font-size` + `margin` on **every** h1/h2/h3/p/li (h1 18pt, h2 12pt, h3 11pt, body 10pt); 0.6 in page margins via `documents.batchUpdate` (best-effort); skills, languages and interests as one line each | every block carries a size; h1 ≤ 20pt; h1 > h2 > h3; margin request shape |
| 2 | Dates inside the h3 wrapped, orphaning `– 2026-03-01` | dates moved to **one small grey line under the h3**, with location/roles: `Aug 2024 – Mar 2026 · Toronto` | no h3 contains a year; the meta line follows the h3 |
| 3 | Raw ISO dates, lowercase `present` | `formatDate()`: `YYYY` stays, `YYYY-MM` / `YYYY-MM-DD` → `Aug 2024`; anything else untouched; `Present` | 12 input cases, ranges |
| 4 | `Bachelor of Technology (BTech) Computer Science…` | studyType and area joined with `, ` | |
| 5 | Project subline ended `· application` (raw `type`) | `type` dropped; roles kept | |
| 6 | `<username>`, `<user>`, `<repo>`, `<basics.name>` vanished from card hints | `{username}`-style placeholders | both cards are built through a CardService stub; no hint or title contains `<` |
| 7 | Load hint still promised "any HTTPS URL" | hint lists the allowlisted hosts | hint hosts == allowlisted résumé hosts |
| 8 | Variable chips read "Step 2: The raw resume.json document, as a JSON string." | short descriptions: `Resume (JSON)`, `Doc URL`, `PDF URL`, … | output descriptions ≤ 24 chars, no sentence |

**Second live run (2026-10-27):** all eight fixes held, and the PDF went from 6 pages to 4 (the
last half full). Two follow-ups, **not yet run live**:

| Finding | Fix | Test |
|---|---|---|
| An h3 asked for 10.5pt imported as 10pt: the import appears to round half-points down | whole-point sizes only (h3 11pt, meta 9pt) | every `font-size` is an integer |
| Still 4 pages; the target is 2–3. Line height stayed 1.15, and each paragraph kept Normal text's 11pt at paragraph level | `line-height:1.0` and tighter block margins; a second best-effort `documents.batchUpdate` sets the Normal text named style to 10pt, single spacing, no paragraph gaps | single line spacing on every block; the named-style request shape |

**Why #1 is fixed with inline styles, not the Docs API alone:** the import maps h1–h3 to the
Doc's named Heading styles (H1 at Arial 24) and did not carry the body's font-size down to them.
An inline style on each element pins the size per paragraph. `documents.batchUpdate` also has an
`updateNamedStyle` request that could restyle Heading 1–3 instead. Inline won because it lives in
the HTML, which the tests check offline, and it adds no API call or failure mode.
`updateNamedStyle` is the fallback if a re-run shows the import dropping inline sizes. The page
count is still a **hypothesis until the next live run**. If the margins also look wide there,
check whether the import set a per-section `sectionStyle` margin that overrides the document
margin.

**Why #2 uses a separate line, not a right-aligned tab:** a tab stop needs a Docs API range edit
after import, and a two-cell table imports with borders and confuses ATS parsers. A paragraph is
the one layout the HTML import is certain to keep.

**Also found:** `registry.jsonresume.org/{user}.json` now answers **301 → `jsonresume.org/@{user}.json`**
(measured 2026-10-27). `UrlFetchApp` follows redirects, so `https://jsonresume.org/` joined the
allowlist.

**Next:** a re-run on the operator's word, to confirm the page count (target 2–3).

## Deploying it — the honest path

**Platform status:** Workspace Studio custom steps are in **limited preview** — Google's admin
page says "This feature is in limited preview." ([Allow or block custom steps][custom-steps-admin],
last updated 2026-10-22). Workspace Studio itself launched in September 2026; the custom-step
surface did not reach general availability with it, so availability can vary by domain.

[custom-steps-admin]: https://knowledge.workspace.google.com/admin/studio/allow-or-block-ws-custom-steps?hl=en

**Check this before writing any more code:** custom steps are **OFF by default**. A super-admin
must enable them at *Admin console → Apps → Google Workspace → Workspace Studio: Custom steps
settings*, and there is a separate *Approvals* control. No developer doc mentions this; it is
the likeliest day-one blocker. You also need an eligible edition (Business, Enterprise or
Education — a personal `@gmail.com` needs Workspace Experiments), flows allowed, and Gemini
enabled.

**No Google Cloud project is needed** for a step. That requirement applies to *starters*, which
post to the Workspace Studio API. This add-on requests two scopes (§ Scopes).

**The Drive and Docs advanced services must stay declared** in `appsscript.json`
(`dependencies.enabledAdvancedServices`). Without them, REST calls return **403** *"Google Drive
API has not been used in project …"*, because the hidden default Cloud project has the API off.
Declaring the service turns it on and **adds no scope**. The code never calls the `Drive` or
`Docs` globals; the declaration exists only to enable the APIs.

**URL allowlist (`urlFetchWhitelist`):** optional for a **test** deployment, **required** for a
**versioned** one. Entries must be `https://` with a full domain and a path, with at most one
leading `*` for subdomains. **There is no "any host" entry.** Once declared, the list is
enforced: *"script projects can't access URLs that have not been added to the allowlist"*. The
page does not exempt test deployments. **But the 2026-10-27 live run contradicts a strict
reading:** under a test deployment with the list declared, Load JSON Resume fetched
`registry.jsonresume.org/{user}.json`, which 301s to `jsonresume.org`, then not on the list.
So either a test deployment does not enforce the list, or redirect targets are not checked.
Which one is unmeasured. A **versioned** deployment is where the list certainly applies.

**Since Load became Connect-only (2026-10-27), the list is three entries:** `jsonresume.org`
(sign-in, token and résumé) and Google's own `www.googleapis.com` and `docs.googleapis.com`.

**Use the web editor for the first run, not `clasp`.** `clasp` is in nixpkgs as
`nixpkgs#google-clasp` (note: `nixpkgs#clasp` is a different program entirely), but it
**cannot create the test deployment** — *Deploy → Test deployments → Install* is editor-UI only
and has no API. So clasp saves nothing on the critical path and costs a login. Adopt it after
first light, when `clasp push` beats re-pasting.

1. Create an Apps Script project, runtime **V8**.
2. Project Settings → tick *Show `appsscript.json` manifest file in editor*.
3. Paste `appsscript.json`, `LoadJsonResume.gs`, `RenderResume.gs` and `OAuth2.gs`.
4. **Deploy → Test deployments → Install → Done.**
5. Refresh Workspace Studio and authorise the add-on.

**First-run flow that gives an unambiguous verdict:** *starter → Load JSON Resume → Notify me in
Chat*, with `name`, `label` and `resumeText` as variable chips in the message.

| What you see | Meaning |
|---|---|
| The real name and headline from your résumé | **works** |
| "not connected to JSON Resume" | open the step, click **Connect JSON Resume**, refresh the page |
| "connection expired or was revoked" | connect again |
| "your JSON Resume account has no resume yet" | create it in the jsonresume.org dashboard |
| "does not match the jsonresume.org schema: …" | fix the listed fields in your résumé |
| Step errors, or outputs are unavailable as chips | the return shape is wrong |

**Where to look when it fails:** the flow's **Activity** tab first, for the user-facing error.
Then Apps Script editor → **Executions**; `onExecute` logs which inputs arrived (never the
résumé itself, which is personal data).

## Verified running — 2026-09-30

This is no longer a design that should work. It ran, on Google's servers, in a real flow.

| | |
|---|---|
| `onConfigLoadJsonResume` | 0.711 s · **Completed** |
| `onExecuteLoadJsonResume` | 0.91 s · **Completed** |
| Flow | `Start manually` → `Load JSON Resume` → **Run Completed** |

**The payload that settles it**, logged by `onExecute`'s first statement:

```json
{
  "clientPlatform": "web",
  "commonEventObject": { "platform": "WEB", "hostApp": "WORKFLOW" },
  "workflow": {
    "triggerEventSource": "TRIGGER_EVENT_SOURCE_AUTOMATED",
    "actionInvocation": {
      "triggerId": "…",
      "inputs": { "resumeUrl": { "stringValues": ["https://…/resume.json"] } }
    },
    "executionMetadata": {}
  },
  "hostApp": "flows"
}
```

`commonEventObject` holds **`platform` and `hostApp`, nothing else** — there is no `formInputs`
to fall back on, so the original implementation would have read `undefined` and reported
"no URL is configured" against a field the user could plainly see filled in.

**Two fields no documentation mentions:** `triggerId` on the `actionInvocation`, and `hostApp`
appearing **twice with different values** — `"WORKFLOW"` inside `commonEventObject`, `"flows"`
at the top level.

This exact payload is pinned in `test-loadjsonresume.mjs` as `LIVE_EVENT`. If it stops parsing,
the platform changed.

### Also learned in the deploy

- **"Allow unpublished (test) custom steps"** is a *second* sub-gate nested under the Admin
  console's Custom-steps toggle. A Test deployment is unpublished by definition, so without it
  the step installs and is then refused at run time. It auto-checks when the parent is set to
  ON — but unchecking it later would break every test step with no obvious cause.
- **Save before deploying.** Apps Script reads the manifest *server-side* to decide the
  deployment type. With unsaved changes, `Deploy → Test deployments` offers no **Install** and
  says only *"update the manifest file with Add-on details"*.
- **The JSON Resume registry can be wrong about your own résumé.** It returned
  `RESUME_NOT_VALID_JSON` for a gist that parses cleanly and renders fine through this step. A
  gist raw URL is the more reliable source, and is exactly the "any HTTPS URL" case this step
  exists to serve.
