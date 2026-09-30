# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

A web-documentation ingestion pipeline. It fetches pages, keeps only the article body, chunks
it, and writes the chunks into the **shared local pgvector corpus** `ragdb.docs` so they can be
retrieved semantically. Seeded with the Google Workspace Studio developer docs.

The operator's motto (`~/.claude/CLAUDE.md` § Motto) governs work here — **referenced, not
restated**, because a second copy of a rule is exactly what that rule forbids.

## Commands

```bash
# dry run — fetch, extract, chunk, print stats, write NOTHING. Do this first.
nix run .#ingest -- --url-file sources/workspace-studio.txt --collection workspace-studio --dry-run

# real ingest (idempotent: replaces each source's rows, never appends)
nix run .#ingest -- --url-file sources/workspace-studio.txt --collection workspace-studio

# ad-hoc URLs into a different collection
nix run .#ingest -- https://example.com/docs/a https://example.com/docs/b --collection my-notes

# contract tests (there is no test runner — the file IS the suite)
nix develop --command python3 test_chunk.py

# retrieval benchmark — run before AND after any extract/chunk/embed change
./bench.sh workspace-studio

# retarget the store without editing code
RAGDB_SOCKET_DIR=/path/to/dir RAGDB_PORT=5433 RAGDB_DATABASE=ragdb nix run .#ingest -- ...
```

`nix develop` is the shell for anything ad-hoc; `ingest.py` is not runnable under a bare
`python3` (its three dependencies come from the flake).

## Architecture

Six layers, five of them deliberately off-the-shelf:

| Layer | Implementation | Owned here? |
|---|---|---|
| fetch | `urllib` + retry (`fetch()`) | yes — see Gotchas |
| extract | **trafilatura** → markdown, article body only | no |
| chunk | **langchain-text-splitters** `RecursiveCharacterTextSplitter` | no |
| runt policy | coalesce into a neighbour, never drop (`chunk()`) | **yes — the only real local policy** |
| embed | `embed()` **inside Postgres** (Ollama `nomic-embed-text`, 768-dim) | no |
| store | existing `docs` table + HNSW cosine index | no |

**The schema is not this repo's to define.** `ragdb.docs` is `(id, content, metadata jsonb,
embedding vector(768))` and is managed declaratively by nix-config's `modules/features/local-rag/`
capsule. The contract — embed in-DB, parameterize SQL, chunk to 500–1000 chars, delete-by-source
before re-ingest — comes from the **`rag` skill** (kattakath/skills). Read that skill before
changing how rows are written.

`sources/*.txt` is one URL per line, `#` comments allowed. Its header records the command that
derived it, so the list is reproducible rather than hand-maintained.

## Gotchas

- **`ragdb.docs` IS SHARED.** Other collections live in it. **Always pass `--collection`, and
  always filter queries on `metadata->>'collection'`** — without the filter a question retrieves
  semantically-near rows from an unrelated corpus, with a confident-looking similarity score.
- **Connect by unix socket, not TCP.** Postgres listens on `127.0.0.1:5433`, but `pg_hba.conf`
  has no host entry, so a TCP DSN fails `no pg_hba.conf entry` *even though the port is open*.
  `DEFAULT_SOCKET_DIR` resolves from `$RAGDB_SOCKET_DIR` → `$XDG_DATA_HOME` → `~/.local/share`.
- **Never compute an embedding in Python.** `embed()` runs in Postgres so the ingest and query
  sides cannot drift onto different models. A second embedding path silently ruins retrieval.
- **`pg_stat_user_tables.n_live_tup` is an ESTIMATE.** It reported this table as empty when it
  held thousands of rows. Use `SELECT count(*)` before concluding anything about a corpus.
- **Do not hand-roll the chunker again.** It was, and it shipped an infinite loop (the run hung
  printing *nothing* — Python block-buffers stdout to a pipe) plus a backtrack bug that turned
  10,934 chars into 158 fragments with a median length of 120. Replacing it with
  `RecursiveCharacterTextSplitter` was measured at **zero retrieval cost** (mean top-1 cosine
  0.737 → 0.738, and every probe's top hit landed on the same page as before the swap).
- **A runt filter that drops is lossy.** Discarding sub-threshold fragments deleted a paragraph's
  opening words when the splitter isolated them. Runts are coalesced; nothing is discarded.
  `test_chunk.py` asserts this — it found the bug that reading the code did not.
- **`test_chunk.py` is a CONTRACT test, not a test of the library.** It guards this repo's runt
  policy and keeps two real regression inputs pointed at whatever implements the split, because
  a pinned dependency can regress across versions without failing loudly.
- **developers.google.com has no `llms.txt`** (404) and the `.md` suffix returns the same HTML.
  HTML extraction is the only route for that source; re-probe before assuming it for a new one.

## Verifying a change

**Retrieval quality is the only thing that matters here, and it is invisible in a diff.** After
touching extraction, chunking or embedding: re-ingest, then

```bash
./bench.sh workspace-studio
```

and compare against the baseline recorded at the top of `probes/workspace-studio.txt`
(mean top-1 **0.738**). Compare the PAGE each probe lands on too — a score that barely moves
while the page changes is still a regression. A change that moves the numbers is a finding; a
change asserted safe without running this is not evidence.

Known weak probes, already reflected in their scores: #2 (0.678) and #5 (0.619) land on a
related rather than ideal page. They are the first place to look when extending coverage.
