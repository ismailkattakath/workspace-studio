# workspace-studio

[![CI status](https://github.com/ismailkattakath/workspace-studio/actions/workflows/ci.yml/badge.svg)](https://github.com/ismailkattakath/workspace-studio/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/ismailkattakath/workspace-studio)](LICENSE)

Ingests web documentation into a private Cloudflare AI Search instance, one item per page, for retrieval from Claude

It is for documentation that is too new for a model's training data and thin or absent in
Context7. The pipeline fetches each page, keeps only the article body, and uploads it as one
item. AI Search chunks and embeds it server-side.

```text
fetch (urllib) -> extract (trafilatura -> markdown) -> one item per page
               -> POST .../ai-search/namespaces/default/instances/rag/items
               -> AI Search chunks + embeds it
```

The repo name is historical: the first collection was the Google Workspace Studio docs.

## Background

- **Why it exists, and why each design choice beat its alternative:**
  [docs/explanation/design.md](docs/explanation/design.md)
- **The item key, body and metadata contract:**
  [docs/reference/item-contract.md](docs/reference/item-contract.md)
- **Add a collection and benchmark retrieval:**
  [docs/how-to/add-a-collection.md](docs/how-to/add-a-collection.md)

## Install

Nothing to install beyond [Nix](https://nixos.org) with flakes. The one dependency,
trafilatura, comes from the flake, so there is no `requirements.txt` and no virtualenv.
`ingest.py` does not run under a bare `python3`.

**Credentials, for a real upload only:**

- **Token:** `$CLOUDFLARE_AI_SEARCH_TOKEN` (AI Search Edit + Run). If it is unset, the macOS
  login Keychain item `cf:cloudflare.com:ai-search` is read instead.
- **Account id:** `$CF_ACCOUNT_ID`. It is per-person data, so it never lives in this repo.

The instance is private: its public endpoint is off.

## Usage

```bash
# dry run: fetch and extract, print each item key and size, upload nothing (no credentials)
nix run .#ingest -- --url-file sources/workspace-studio.txt --dry-run

# real ingest (idempotent: the key comes from the URL, and an upload is an upsert)
CF_ACCOUNT_ID=<account id> nix run .#ingest -- --url-file sources/workspace-studio.txt

# one-off URLs
CF_ACCOUNT_ID=<account id> nix run .#ingest -- https://example.com/docs/page

# parallel ingest (shards a URL list across N workers)
./ingest-parallel.sh [--dry-run] <url-file> [jobs]

# contract tests (no network: urllib and the Keychain call are stubbed)
nix develop --command python3 test_ingest.py
```

`nix run .#ingest -- --help` lists every flag. Each collection is a source list in
[`sources/`](sources) plus a probe file in [`probes/`](probes).

**The instance is shared.** Other corpora live in it too, and every item this pipeline writes
carries `corpus=web`. Filter on it when you query, or a question retrieves whatever else is
close, with a confident-looking score:

```bash
POST https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/ai-search/namespaces/default/instances/rag/search
{"query": "...", "ai_search_options": {"retrieval": {"max_num_results": 8, "filters": {"corpus": "web"}}}}
```

The claude.ai Cloudflare connector queries it too.

The JSON Resume step that once lived in `addon/` is now its own project,
[JSON Resume Connect](https://github.com/ismailkattakath/jsonresume-connect).

## Contributing

Open an issue or a pull request. One required check, `gate`, runs `nix flake check`, which
includes the contract tests. A change to extraction also needs a before-and-after `bench.sh`
run: see [the how-to](docs/how-to/add-a-collection.md#benchmark-retrieval).

## License

[MIT](LICENSE)
