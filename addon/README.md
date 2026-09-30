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

- **`formInputs` is nested.** The value is at `formInputs[field].stringInputs.value`, and it is
  an **array**. Read it wrong and the field silently reads as empty while the user can plainly
  see the value they typed in the card. That is the single likeliest bug in any Studio step, so
  it has its own tests.
- **`onExecuteFunction` must return every declared output**, or Workspace Studio errors the
  step. Every failure path here still returns the full set, with the reason in `resumeText` —
  an error the user can read beats an exception that tells them nothing.
- **Shape check, not schema validation.** Every field in JSON Resume is optional, so the only
  honest assertion is that at least one known section exists. A stricter gate would reject
  legitimate sparse résumés.
- **HTTPS only, no credentials in the URL.** A configuration field is user-supplied; plain
  `http` would send the request in the clear, and a `user:pass@host` URL would put a secret into
  a stored step configuration.
- **HTML instead of JSON gets a specific error.** The commonest mistake is pasting a GitHub
  *page* URL rather than the raw one, so that case is named rather than surfaced as a parser
  error.
