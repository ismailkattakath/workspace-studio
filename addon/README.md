# Load JSON Resume — a Google Workspace Studio step

Fetches a `resume.json` in the [jsonresume.org](https://jsonresume.org) standard from a URL you
configure, and hands it to the rest of your flow. Point it at your résumé and it works — the
registry, a GitHub or GitLab raw file, or any HTTPS URL serving the schema.

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
[Gmail: create draft]
```

## Configuration

One field, on the step's configuration card:

| Field | Example |
|---|---|
| **Your JSON Resume URL** | `https://registry.jsonresume.org/<username>.json` |
| | `https://raw.githubusercontent.com/<user>/<repo>/main/resume.json` |
| | any HTTPS URL serving the jsonresume.org schema |

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

## Install

1. Create an Apps Script project, set it to the **V8** runtime.
2. Copy `LoadJsonResume.gs` and `appsscript.json` into it.
3. Deploy as a Workspace add-on and add it to a flow.

The only OAuth scope requested is `script.external_request` — needed to fetch your résumé URL,
and nothing else. The step reads no mail, no Drive, no calendar.

## Tests

```bash
nix run nixpkgs#nodejs -- addon/test-loadjsonresume.mjs
```

Apps Script cannot run off Google's servers, so the Workspace Studio integration itself has to
be verified by installing the add-on. Everything that does **not** touch `CardService` or
`UrlFetchApp` is plain JavaScript, and that is where the bugs live — so the URL guard, the
`formInputs` shape and the per-section headline formatting are tested against **real résumés
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

## Deploying it — the honest path

**Platform status:** Workspace Studio custom steps are **generally available** (announced
September 2026). No platform blocker.

**Check this before writing any more code:** custom steps are **OFF by default**. A super-admin
must enable them at *Admin console → Apps → Google Workspace → Workspace Studio: Custom steps
settings*, and there is a separate *Approvals* control. No developer doc mentions this; it is
the likeliest day-one blocker. You also need an eligible edition (Business, Enterprise or
Education — a personal `@gmail.com` needs Workspace Experiments), flows allowed, and Gemini
enabled.

**No Google Cloud project is needed** for a step. That requirement applies to *starters*, which
post to the Workspace Studio API. This add-on requests one scope, `script.external_request`.

**Use the web editor for the first run, not `clasp`.** `clasp` is in nixpkgs as
`nixpkgs#google-clasp` (note: `nixpkgs#clasp` is a different program entirely), but it
**cannot create the test deployment** — *Deploy → Test deployments → Install* is editor-UI only
and has no API. So clasp saves nothing on the critical path and costs a login. Adopt it after
first light, when `clasp push` beats re-pasting.

1. Create an Apps Script project, runtime **V8**.
2. Project Settings → tick *Show `appsscript.json` manifest file in editor*.
3. Paste `appsscript.json` and `LoadJsonResume.gs`.
4. **Deploy → Test deployments → Install → Done.**
5. Refresh Workspace Studio and authorise the add-on.

**First-run flow that gives an unambiguous verdict:** *starter → Load JSON Resume → Notify me in
Chat*, with `name`, `label` and `resumeText` as variable chips in the message.

| What you see | Meaning |
|---|---|
| The real name and headline from your résumé | **works** |
| The `resumeUrl` field never appears, or won't persist | the input is not declared in `inputs[]` |
| Step errors, or outputs are unavailable as chips | the return shape is wrong |
| `…returned HTML, not JSON…` or `HTTP 404` | code is fine — **your URL is wrong** |

**Where to look when it fails:** Apps Script editor → **Executions** first; `onExecute` logs the
entire event object as its first statement, so the real payload is visible on run one. Then the
flow's **Activity** tab for the user-facing error.
