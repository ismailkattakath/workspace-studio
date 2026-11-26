# Why this exists, and why it is built this way

## Why not just Context7

Context7 is an index, not a crawler. Its MCP server exposes only `resolve-library-id` and
`query-docs`, and both search content it has already ingested. It has no web search and no
fetch-an-arbitrary-URL. Google Workspace Studio *is* in Context7, as
`/websites/developers_google_workspace_add-ons_studio`, but its benchmark score there is far
below its siblings'. That coverage is thin, and nothing outside Context7 can fix it.

This pipeline is the escape hatch: fetch the pages yourself, keep only the article body, and
own the index.

## Where the data goes

Cloudflare-hosted and private. The instance's public endpoint is off, and it is reached only
with a scoped Cloudflare API token (AI Search Edit + Run). The instance is not defined here:
[`kattakath/nix-config`](https://github.com/kattakath/nix-config/blob/main/infra/cloudflare/ai-search.nix)
declares it. Content never enters a repo. It arrives
through the items API.

## Design decisions

| Choice | Why, and what lost |
| --- | --- |
| **trafilatura** for extraction | Purpose-built boilerplate removal with markdown output. **pandoc** converts the whole document, so a devsite page's nav, breadcrumb and footer land in the corpus as text, and on these pages the article body is a small part of the HTML. A hand-rolled `html.parser` reinvents a genuinely hard wheel. |
| **One item per page, no local chunking** | AI Search chunks and embeds each item itself, with one pinned embedding model on the ingest and the query side. Chunking here as well would only make AI Search chunk the chunks. |
| **Key derived from the URL** | An upload to an existing key returns the same item id. That makes it an upsert, so a re-run replaces a page instead of adding a duplicate, with no transaction to manage. |
| **stdlib `urllib` multipart** | Two fixed form parts. A `requests` dependency would be bigger than the problem. |
| **Retry 429/5xx, fail fast on other 4xx** | A rate limit or a server error gets better with backoff. A bad token or a rejected item does not. A run exits non-zero and lists every failed URL. |
| **`nix run`, no requirements.txt** | The one dependency is in nixpkgs: nothing to install, no virtualenv to drift. |

## Lessons kept

- **Don't hand-roll the extractor or the chunker.** This repo once hand-rolled a chunker. It
  shipped an infinite loop and a fragment explosion before it was replaced. Chunking is now
  AI Search's job entirely.
- **Tests must never reach the API.** `test_ingest.py` replaces `urllib.request.urlopen` and
  `subprocess.run` with stubs that raise. A test that forgets its fake fails closed instead of
  uploading with a real token.
