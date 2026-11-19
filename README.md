# workspace-studio

Ingestion pipeline that puts web documentation into the operator's **private Cloudflare AI Search
instance** (`rag`, namespace `default`) so it can be retrieved semantically from every Claude
surface — for material too new to be in a model's training data, and too thin or absent in
Context7.

Collections (a collection is a source list plus a probe file here; in AI Search every page is
`corpus=web`):

| Collection | Sources (one AI Search item per page) |
|---|---|
| `workspace-studio` | 17 pages |
| `nix-darwin` | 1 page (the whole option manual) |

## Moved: the Workspace Studio step

The JSON Resume step that used to live in `addon/` is now its own project,
[JSON Resume Connect](https://github.com/ismailkattakath/jsonresume-connect).

## Why this exists

Context7 is an index, not a crawler. Its MCP server exposes exactly two tools
(`resolve-library-id`, `query-docs`), both scoped to content it has already ingested — there is
no web search and no fetch-arbitrary-URL. Workspace Studio *is* in Context7, as
`/websites/developers_google_workspace_add-ons_studio`, but with a **benchmark score of 16.6**
against 83.98 for the sibling Chat API and 91.27 for Next.js. Thin coverage, and nothing you can
do about it from the outside.

This pipeline is the escape hatch: fetch the pages yourself, keep only the article body, and own
the index.

## Pipeline

```
fetch (urllib)  ->  extract (trafilatura -> markdown)  ->  one item per page
                ->  POST .../ai-search/namespaces/default/instances/rag/items
                ->  AI Search chunks + embeds it server-side
```

**Where the data goes:** Cloudflare-hosted, private. The instance's public endpoint is off; it is
reached only with a scoped Cloudflare API token (AI Search Edit + Run). The token comes from
`$CLOUDFLARE_AI_SEARCH_TOKEN`, else the macOS login Keychain item `cf:cloudflare.com:ai-search`.
The account id comes from `$CF_ACCOUNT_ID` — per-person data, never stored in this repo.

## Usage

```bash
# dry run: fetch and extract, print each item key and size, upload nothing (no credentials needed)
nix run .#ingest -- --url-file sources/workspace-studio.txt --dry-run

# real ingest (idempotent — the key is derived from the URL, and an upload is an upsert)
CF_ACCOUNT_ID=<account id> nix run .#ingest -- --url-file sources/workspace-studio.txt

# one-off URLs
CF_ACCOUNT_ID=<account id> nix run .#ingest -- https://example.com/docs/page

# contract tests (no network: urllib and the Keychain call are stubbed)
nix develop --command python3 test_ingest.py

# retrieval benchmark — the only check that sees a quality regression (live API)
CF_ACCOUNT_ID=<account id> nix develop --command ./bench.sh workspace-studio
CF_ACCOUNT_ID=<account id> nix develop --command ./bench.sh nix-darwin

# parallel ingest (shards a URL list across N workers)
./ingest-parallel.sh [--dry-run] <url-file> [jobs]
```

Query it through the claude.ai Cloudflare connector, or directly:

```bash
POST https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/ai-search/namespaces/default/instances/rag/search
{"query": "...", "ai_search_options": {"retrieval": {"max_num_results": 8, "filters": {"corpus": "web"}}}}
```

## The instance is SHARED — filter on `corpus`

`rag` is not this project's private index: it holds the operator's other corpora too (`ircc`,
`repo`, `misc`, ...). Every item this pipeline writes carries `corpus=web`, and a query should
filter on it. Without that filter, a Workspace Studio question retrieves whatever else happens to
be semantically close, with a confident-looking score.

## Item contract

| Part | Value |
|---|---|
| key | `item_key("web", url)` — `web/<slug of the URL>-<sha1[:10]>.md`, ≤128 chars, byte for byte the corpus export's formula. Pinned by a test. |
| body | `# {title}\n\nSource: {url}\n\n{page text}\n` — the export's format |
| metadata | `{"corpus": "web", "source": url, "url": url, "title": title}`, each ≤256 chars; the instance's only filterable fields are `corpus`, `source`, `url`, `repo`, `title` |

## Design decisions

| Choice | Why, and what lost |
|---|---|
| **trafilatura** for extraction | Purpose-built boilerplate removal, markdown output. **pandoc** (already on PATH) converts the whole document, so a devsite page's nav, breadcrumb and footer land in the corpus as text — on these pages the article body is a small fraction of 172 KB of HTML. A hand-rolled `html.parser` reinvents a genuinely hard wheel. |
| **One item per page, no local chunking** | AI Search chunks and embeds each item itself, with one pinned embedding model on both the ingest and query side. Chunking here as well would only make AI Search chunk the chunks. The old `langchain-text-splitters` layer and its contract test went with it. |
| **Key derived from the URL** | An upload to an existing key returns the same item id: it is an upsert, so re-running replaces a page instead of adding a duplicate. That is what the old DELETE-then-INSERT achieved, with no transaction to manage. |
| **stdlib `urllib` multipart** | Two fixed form parts. A `requests` dependency would be bigger than the problem. |
| **Retry 429/5xx, fail fast on other 4xx** | A rate limit or server error gets better with backoff; a bad token or a rejected item does not. A run exits non-zero and lists every failed URL. |
| **`nix run`, no requirements.txt** | The one dependency is in nixpkgs. Nothing to install, no virtualenv to drift, reproducible across the fleet. |

## Source discovery

`sources/workspace-studio.txt` was derived from the section nav of the index page, not hand-typed:

```bash
curl -sL https://developers.google.com/workspace/add-ons/studio \
  | grep -oE 'href="(/workspace/add-ons/studio[^"#?]*)"'
```

There is **no `llms.txt`** on developers.google.com (404), and the `.md` suffix returns the same
HTML, so HTML extraction is the only route. Re-run that command to pick up new pages.

## Gotchas

- **Never change `item_key`.** A key that differs by one byte creates a second item for the same
  page, and the old copy lives on as a stale duplicate. `test_ingest.py` pins a verified example.
- **`bench.sh` scores are not the old cosine scores.** AI Search reports its own 0–1 relevance
  (hybrid vector + keyword), so the pgvector baselines recorded in `probes/*.txt` before
  2026-11-19 do not carry over. Both collections share `corpus=web`, so a probe can land on the
  other collection's page: read the title, not just the number.
- **Don't hand-roll the extractor or the chunker.** This repo once hand-rolled a chunker, and it
  shipped an infinite loop and a fragment explosion before being replaced. Chunking is now
  AI Search's job entirely.
