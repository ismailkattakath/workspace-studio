#!/usr/bin/env bash
# Shard a URL list across N ingest workers.
#
# WHY SHELL AND NOT AGENTS, and not a thread pool inside ingest.py either:
#
#   - Agents: fetching a URL and uploading an item involves no judgement at all.
#     An LLM agent calling urllib is strictly worse than urllib — slower,
#     costlier, and non-deterministic. Agents earn their keep DECIDING WHAT to
#     index; they are pure waste doing the indexing.
#
#   - A thread pool in Python: new failure modes (shared retry state, interleaved
#     output) for a job that is already embarrassingly parallel at the process
#     level. `xargs -P` is the off-the-shelf answer and it has none of those.
#
# SHARDED, NOT PER-URL. `xargs -n1 -P` would pay Python interpreter startup plus
# the trafilatura import for EVERY url — measured at seconds, which dwarfs the
# fetch itself. Each worker instead gets a contiguous slice and pays that once.
#
# SAFE TO PARALLELISE because each worker touches disjoint items: an item's key
# is derived from its URL, an upload is an upsert on that key, and no two shards
# share a URL. Keep `jobs` modest: AI Search rate-limits per account, and
# ingest.py backs off on 429 rather than failing, so more workers mostly means
# more waiting.
#
# Needs $CF_ACCOUNT_ID, and the token from $CLOUDFLARE_AI_SEARCH_TOKEN or the
# Keychain (see ingest.py); --dry-run needs neither.
#
# Usage: ./ingest-parallel.sh [--dry-run] <url-file> [jobs]
set -euo pipefail

dry=""
if [ "${1:-}" = "--dry-run" ]; then
  dry="--dry-run"
  shift
fi

urlfile="${1:?usage: ingest-parallel.sh [--dry-run] <url-file> [jobs]}"
jobs="${2:-4}"

[ -r "$urlfile" ] || {
  echo "no such url file: $urlfile" >&2
  exit 1
}

workdir=$(mktemp -d)
trap 'rm -rf "$workdir"' EXIT

# Strip comments and blanks once, here, so the shards are pure URL lists and a
# worker never has to re-implement the parsing.
grep -vE '^\s*(#|$)' "$urlfile" >"$workdir/all.txt"
total=$(wc -l <"$workdir/all.txt" | tr -d ' ')
[ "$total" -gt 0 ] || {
  echo "no URLs in $urlfile" >&2
  exit 1
}

# Ceiling division, so N shards actually cover N*size >= total.
per=$(((total + jobs - 1) / jobs))
split -l "$per" "$workdir/all.txt" "$workdir/shard."
shards=$(find "$workdir" -name 'shard.*' | wc -l | tr -d ' ')

echo "==> $total URLs -> $shards shards of <=$per, $jobs parallel${dry:+  (DRY RUN)}"

# --delay 0 inside a shard: the politeness gap exists to avoid hammering ONE
# host, and with N workers the effective request rate is already N-fold.
#
# `pipefail` in the child, so a worker's non-zero exit survives the `sed`
# prefixer; xargs then exits 123 when any worker failed, and `set -e` here
# propagates it instead of reporting "done" over a failed shard.
# shellcheck disable=SC2016
# SC2016 ("expressions don't expand in single quotes") is exactly the intent
# here, not an oversight: $1, $2 and $(basename) must expand in the `bash -c`
# CHILD, where xargs has bound them as positional parameters, not in this
# parent shell. The trailing `_` is the child's $0; the args after {} become $1
# (the shard) and $2 (the dry-run flag, or empty).
find "$workdir" -name 'shard.*' -print0 |
  xargs -0 -P "$jobs" -I{} bash -c \
    'set -o pipefail; nix run .#ingest -- --url-file "$1" --delay 0 $2 2>&1 | sed "s|^|[$(basename "$1")] |"' \
    _ {} "$dry"

echo "==> done. Verify with: ./bench.sh <collection>"
