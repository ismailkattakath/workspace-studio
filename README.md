# workspace-studio

Ingestion pipeline that puts web documentation into the **local pgvector corpus** (`ragdb.docs`)
so it can be retrieved semantically — for material too new to be in a model's training data, and
too thin or absent in Context7.

Collections:

| Collection | Sources | Chunks | Probe mean |
|---|---|---|---|
| `workspace-studio` | 17 pages | 314 | 0.741 |
| `nix-darwin` | 1 page (the whole option manual) | 511 | 0.667 |

## Also here: a Workspace Studio step

[`addon/`](addon/) holds **Load JSON Resume** — a Google Workspace Studio custom step that
fetches a `resume.json` in the [jsonresume.org](https://jsonresume.org) standard from a URL the
user configures and hands it to the rest of their flow. It deliberately does **not** tailor the
résumé: flows already have a native "ask Gemini" step, so this one stays deterministic, needs no
API key, and never reads the job posting. See [`addon/README.md`](addon/README.md).

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
fetch (urllib)  ->  extract (trafilatura -> markdown)  ->  chunk (~900 chars, overlap)
                ->  embed IN POSTGRES via embed()      ->  ragdb.docs
```

Nothing leaves the machine. Postgres and Ollama are both loopback.

## Usage

```bash
# dry run: extract and chunk, write nothing
nix run .#ingest -- --url-file sources/workspace-studio.txt \
  --collection workspace-studio --dry-run

# real ingest (idempotent — re-running replaces that source's rows)
nix run .#ingest -- --url-file sources/workspace-studio.txt \
  --collection workspace-studio

# one-off URLs
nix run .#ingest -- https://example.com/docs/page --collection my-notes

# point at a different store (defaults: $XDG_DATA_HOME or ~/.local/share,
# /postgres-pgvector, port 5433, database ragdb)
RAGDB_SOCKET_DIR=/path/to/socketdir RAGDB_PORT=5433 RAGDB_DATABASE=ragdb \
  nix run .#ingest -- --url-file sources/workspace-studio.txt --collection workspace-studio

# contract tests
nix develop --command python3 test_chunk.py

# retrieval benchmark — the only check that sees a quality regression
./bench.sh workspace-studio
./bench.sh nix-darwin

# parallel ingest (shards a URL list across N workers)
./ingest-parallel.sh <collection> <url-file> [jobs]
```

Query it with the `rag` skill, or directly:

```sql
SELECT content, metadata, 1 - (embedding <=> embed($1)) AS similarity
FROM docs
WHERE metadata->>'collection' = 'workspace-studio'
ORDER BY embedding <=> embed($1)
LIMIT 8;
```

## The store is SHARED — always set `--collection`

`ragdb.docs` is not this project's private table. It is a shared corpus, and at the time of
writing it already held several thousand rows from unrelated collections. Every row this
pipeline writes carries `metadata.collection`, and every query above filters on it. Without that
filter, a Workspace Studio question retrieves whatever else happens to be semantically close —
from a completely different corpus, with a confident-looking similarity score.

Pre-existing rows have no `collection` key at all, so they are easy to tell apart — and this
pipeline never touches them: re-ingest deletes only by exact `metadata->>'source'`.

## Design decisions

| Choice | Why, and what lost |
|---|---|
| **trafilatura** for extraction | Purpose-built boilerplate removal, markdown output. **pandoc** (already on PATH) converts the whole document, so a devsite page's nav, breadcrumb and footer land in the corpus as text — on these pages the article body is a small fraction of 172 KB of HTML. A hand-rolled `html.parser` reinvents a genuinely hard wheel. |
| **Embed in Postgres** via `embed()` | The `rag` skill's contract. One fixed model (`nomic-embed-text`, 768-dim) on both the ingest and query side, so they can never drift apart. Computing vectors in Python would introduce a second path. |
| **`langchain-text-splitters` for chunking** | The chunker was hand-rolled first — and it was the one layer with a mature off-the-shelf answer sitting in nixpkgs the whole time. `RecursiveCharacterTextSplitter` is the standalone package (no agent framework, no LLM client, no vector-store opinion). **Measured: the swap is free** — mean top-1 similarity 0.737 → 0.738 across the 6 probes in `probes/workspace-studio.txt`, each landing on the same page as before, while deleting ~60 lines that had shipped two bugs. Re-run with `./bench.sh workspace-studio`. |
| **~900 chars, 150 overlap** | Top of the skill's 500–1000 band: keeps a whole procedure step together while leaving the splitter room to find a natural boundary. Measured result: median chunk 821 chars. |
| **Chunk size stays at the skill's 500–1000 band** | Tested, not assumed. On the nix-darwin option manual, larger chunks measurably improve a proxy — option names separated from their `Type:` line drop from 21.7% at 900 chars to 15.2% at 1500 and 12.6% at 2000 — but retrieval did **not** move: 1500/250 scored a mean of 0.667, identical to 900/150. The proxy does not predict quality, so precedent wins. `--chunk-size`/`--chunk-overlap` exist so the next source can be measured rather than argued about. |
| **Separator tuning REJECTED** | Adding an option-entry boundary separator made things *worse* — orphans 21.7% → 27.0%, because more split points meant smaller chunks and more mid-option breaks. Recorded so it is not retried. |
| **DELETE-then-INSERT per source, one transaction** | Makes re-running idempotent instead of additive. Stale chunks from a changed page are the quiet way a corpus rots. |
| **`nix run`, no requirements.txt** | Both dependencies are in nixpkgs. Nothing to install, no virtualenv to drift, reproducible across the fleet. |

## Source discovery

`sources/workspace-studio.txt` was derived from the section nav of the index page, not hand-typed:

```bash
curl -sL https://developers.google.com/workspace/add-ons/studio \
  | grep -oE 'href="(/workspace/add-ons/studio[^"#?]*)"'
```

There is **no `llms.txt`** on developers.google.com (404), and the `.md` suffix returns the same
HTML, so HTML extraction is the only route. Re-run that command to pick up new pages.

## Gotchas

- **Connect by unix socket, not TCP.** Postgres listens on `127.0.0.1:5433`, but `pg_hba.conf`
  has no host entry, so a TCP DSN fails with `no pg_hba.conf entry` even though the port is open.
  The socket directory is `~/.local/share/postgres-pgvector`.
- **`pg_stat_user_tables.n_live_tup` is an estimate, and it lied.** It reported `docs` as empty
  when the table in fact held several thousand rows, which nearly produced a confident and wrong
  "the corpus is empty". Count with `SELECT count(*)` before concluding anything about a corpus.
- **Don't hand-roll the chunker** — this repo did, and paid for it. The custom splitter shipped
  an infinite loop (the run hung with *no output*, because Python block-buffers stdout to a
  pipe) and a sentence-boundary backtrack that turned 10,934 chars into 158 fragments with a
  median length of 120. It was then replaced by `RecursiveCharacterTextSplitter` at **zero
  measured retrieval cost**. `test_chunk.py` survives as a CONTRACT test over whatever
  implements the split.
- **A runt filter that drops is lossy.** Discarding sub-threshold fragments silently deleted a
  paragraph's opening words when the splitter isolated them — caught by the contract test, not
  by reading the code. Runts are coalesced into a neighbour now; nothing is discarded.
