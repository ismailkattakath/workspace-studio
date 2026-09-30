#!/usr/bin/env bash
# Shard a URL list across N ingest workers.
#
# WHY SHELL AND NOT AGENTS, and not a thread pool inside ingest.py either:
#
#   - Agents: fetching a URL and writing a row involves no judgement at all. An
#     LLM agent calling urllib is strictly worse than urllib — slower, costlier,
#     and non-deterministic. Agents earn their keep DECIDING WHAT to index; they
#     are pure waste doing the indexing.
#
#   - A thread pool in Python: would mean concurrency inside a process that also
#     holds a database connection and a shared splitter, i.e. new failure modes
#     (connection sharing, partial transactions) for a job that is already
#     embarrassingly parallel at the process level. `xargs -P` is the off-the-shelf
#     answer and it has none of those.
#
# SHARDED, NOT PER-URL. `xargs -n1 -P` would pay Python interpreter startup plus
# trafilatura and langchain imports for EVERY url — measured at seconds, which
# dwarfs the fetch itself. Each worker instead gets a contiguous slice and pays
# that cost once.
#
# SAFE TO PARALLELISE because each worker touches disjoint rows: ingest.py
# deletes and inserts strictly by `metadata->>'source'`, one transaction per
# page, and no two shards share a URL. Postgres handles the concurrent writes;
# there is no cross-page state.
#
# Usage: ./ingest-parallel.sh [--dry-run] <collection> <url-file> [jobs]
set -euo pipefail

dry=""
if [ "${1:-}" = "--dry-run" ]; then
  dry="--dry-run"
  shift
fi

collection="${1:?usage: ingest-parallel.sh [--dry-run] <collection> <url-file> [jobs]}"
urlfile="${2:?usage: ingest-parallel.sh [--dry-run] <collection> <url-file> [jobs]}"
jobs="${3:-4}"

[ -r "$urlfile" ] || { echo "no such url file: $urlfile" >&2; exit 1; }

workdir=$(mktemp -d)
trap 'rm -rf "$workdir"' EXIT

# Strip comments and blanks once, here, so the shards are pure URL lists and a
# worker never has to re-implement the parsing.
grep -vE '^\s*(#|$)' "$urlfile" > "$workdir/all.txt"
total=$(wc -l < "$workdir/all.txt" | tr -d ' ')
[ "$total" -gt 0 ] || { echo "no URLs in $urlfile" >&2; exit 1; }

# Ceiling division, so N shards actually cover N*size >= total.
per=$(( (total + jobs - 1) / jobs ))
split -l "$per" "$workdir/all.txt" "$workdir/shard."
shards=$(find "$workdir" -name 'shard.*' | wc -l | tr -d ' ')

echo "==> $total URLs -> $shards shards of <=$per, $jobs parallel, collection=$collection${dry:+  (DRY RUN)}"

# --delay 0 inside a shard: the politeness gap exists to avoid hammering ONE
# host, and with N workers the effective request rate is already N-fold. Keep
# `jobs` modest (4 is the default) rather than setting a per-worker delay that
# would not actually bound the aggregate rate.
# shellcheck disable=SC2016
# SC2016 ("expressions don't expand in single quotes") is exactly the intent
# here, not an oversight: $1, $2 and $(basename) must expand in the `sh -c`
# CHILD, where xargs has bound them as positional parameters, not in this
# parent shell. Double-quoting would interpolate the parent's (empty) $1 and
# every worker would ingest nothing. The trailing `_` is the child's $0; the
# args after {} become $2 (collection) and $3 (the dry-run flag, or empty).
find "$workdir" -name 'shard.*' -print0 \
  | xargs -0 -P "$jobs" -I{} sh -c \
      'nix run .#ingest -- --url-file "$1" --collection "$2" --delay 0 $3 2>&1 | sed "s|^|[$(basename "$1")] |"' \
      _ {} "$collection" "$dry"

echo "==> done. Verify with: ./bench.sh $collection"
