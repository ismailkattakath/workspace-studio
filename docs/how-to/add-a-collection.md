# Add a collection and benchmark retrieval

A collection is a source list, `sources/<name>.txt`, plus a probe file, `probes/<name>.txt`.
Every page still lands as `corpus=web` in AI Search.

## Derive the source list

Write `sources/<name>.txt` with one URL per line. `#` comments are allowed. Derive the list
from the site's own navigation rather than typing it, and record the command in the file's
header so the list can be rebuilt. For example, `sources/workspace-studio.txt` came from the
index page's section nav:

```bash
curl -sL https://developers.google.com/workspace/add-ons/studio \
  | grep -oE 'href="(/workspace/add-ons/studio[^"#?]*)"'
```

Check the source for a machine-readable route first. developers.google.com has no `llms.txt`
(404), and its `.md` suffix returns the same HTML, so HTML extraction is the only route there.
Re-probe for each new source.

## Ingest it

Dry-run first, then upload:

```bash
nix run .#ingest -- --url-file sources/<name>.txt --dry-run
CF_ACCOUNT_ID=<account id> nix run .#ingest -- --url-file sources/<name>.txt
```

## Benchmark retrieval

Retrieval quality is invisible in a diff. `probes/<name>.txt` holds a fixed query set, and
`bench.sh` reports the top AI Search hit for each query against the live instance:

```bash
CF_ACCOUNT_ID=<account id> nix develop --command ./bench.sh <name>
```

Run it before and after any change to extraction. Compare the score **and** the page each probe
lands on. A score that barely moves while the page changes is still a regression.

- **`bench.sh` scores are not the old cosine scores.** AI Search reports its own 0–1 relevance
  (hybrid vector + keyword). The pgvector baselines recorded in `probes/*.txt` before the move
  to AI Search do not carry over. The first run against AI Search sets the new baseline: record
  it at the top of the probe file.
- **Every collection shares `corpus=web`,** so a probe can land on another collection's page.
  Read the title, not just the number.
