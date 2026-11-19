# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

A web-documentation ingestion pipeline. It fetches pages, keeps only the article body, and
uploads each page as ONE item to the operator's **private Cloudflare AI Search instance** `rag`
(namespace `default`), which chunks and embeds it server-side. Seeded with the Google Workspace
Studio developer docs and the nix-darwin option manual.

The operator's motto (`~/.claude/CLAUDE.md` § Motto) governs work here — **referenced, not
restated**, because a second copy of a rule is exactly what that rule forbids.

## Commands

```bash
# dry run — fetch, extract, print each item key and size, upload NOTHING. Do this first.
# Needs no credentials.
nix run .#ingest -- --url-file sources/workspace-studio.txt --dry-run

# real ingest (idempotent: the key comes from the URL and an upload is an upsert)
CF_ACCOUNT_ID=<account id> nix run .#ingest -- --url-file sources/workspace-studio.txt

# ad-hoc URLs, another instance
CF_ACCOUNT_ID=<account id> nix run .#ingest -- https://example.com/docs/a --instance rag

# contract tests (there is no test runner — the file IS the suite; no network)
nix develop --command python3 test_ingest.py

# retrieval benchmark against the live instance — run before AND after an extract change
CF_ACCOUNT_ID=<account id> nix develop --command ./bench.sh workspace-studio
```

`nix develop` is the shell for anything ad-hoc; `ingest.py` is not runnable under a bare
`python3` (trafilatura comes from the flake).

## Architecture

| Layer | Implementation | Owned here? |
|---|---|---|
| fetch | `urllib` + retry (`fetch()`) | yes |
| extract | **trafilatura** → markdown, article body only | no |
| item | `item_key()` + `render_body()` — the corpus export's key and body format | **yes — must match the export byte for byte** |
| upload | stdlib multipart POST to `.../instances/rag/items`, retry 429/5xx (`upload()`) | yes |
| chunk + embed + index | **AI Search**, server-side (pinned embedding model, hybrid index) | no |

**The instance is not this repo's to define.** It is declared in nix-config's
`infra/cloudflare/ai-search.nix` (stack `cf-ai-search`): managed upload storage, five
filterable metadata fields (`corpus`, `source`, `url`, `repo`, `title`), public endpoint off.
Content never enters a repo; it arrives through the items API.

**Credentials.** Token: `$CLOUDFLARE_AI_SEARCH_TOKEN`, else the macOS login Keychain item
`cf:cloudflare.com:ai-search` (read to USE it — never print or log it). Account id:
`$CF_ACCOUNT_ID`, required for a real run; it is per-person data and is never hardcoded.

`sources/*.txt` is one URL per line, `#` comments allowed. Its header records the command that
derived it, so the list is reproducible rather than hand-maintained.

## Gotchas

- **Never change `item_key()` or `render_body()`.** They are the export's formula verbatim. A
  key that differs by one byte makes a re-ingest ADD a second item for the page instead of
  replacing it, and the stale copy keeps answering queries. `test_ingest.py` pins a verified
  example.
- **The instance IS SHARED.** Other corpora (`ircc`, `repo`, `misc`, ...) live in it. Every item
  here is `corpus=web`, and queries should filter on `corpus`. `collection` is not a filterable
  field; it survives only as the name of a source list and its probe file.
- **Metadata is the filterable fields only**, each ≤256 chars. Any other key is not filterable.
- **Never chunk or embed here.** AI Search does both with one pinned model on the ingest and
  query side; a second path would only re-chunk the chunks. The old hand-rolled chunker shipped
  an infinite loop and a fragment explosion before it was replaced — the lesson stands.
- **Tests must never reach the API.** `test_ingest.py` replaces `urllib.request.urlopen` and
  `subprocess.run` with stubs that raise, so a test that forgets its fake fails closed instead
  of uploading with a real token.
- **developers.google.com has no `llms.txt`** (404) and the `.md` suffix returns the same HTML.
  HTML extraction is the only route for that source; re-probe before assuming it for a new one.

## Verifying a change

**Retrieval quality is the only thing that matters here, and it is invisible in a diff.** After
touching extraction: re-ingest, then

```bash
CF_ACCOUNT_ID=<account id> nix develop --command ./bench.sh workspace-studio
```

and compare the score AND the page each probe lands on with the previous run. A score that
barely moves while the page changes is still a regression.

**The baselines in `probes/*.txt` are pgvector cosine scores from before 2026-11-19** and do not
carry over: AI Search reports its own 0–1 relevance. The first `bench.sh` run against the
instance sets the new baseline; record it at the top of each probe file.
