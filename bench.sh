#!/usr/bin/env bash
# Report top-1 retrieval for each probe query in a collection.
#
# Deliberately psql and nothing else: the query IS the benchmark, embed() runs
# in Postgres, and a Python harness here would add a second way to reach the
# store for no gain. Reads the same env knobs as ingest.py.
set -euo pipefail

collection="${1:?usage: bench.sh <collection> [probe-file]}"
probes="${2:-probes/${collection}.txt}"
sock="${RAGDB_SOCKET_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/postgres-pgvector}"
port="${RAGDB_PORT:-5433}"
db="${RAGDB_DATABASE:-ragdb}"

total=0 n=0
while IFS= read -r q; do
  [ -z "$q" ] && continue
  case "$q" in \#*) continue ;; esac
  row=$(psql -h "$sock" -p "$port" -d "$db" -tAc \
    "SELECT round((1-(embedding <=> embed(\$q\$${q}\$q\$)))::numeric,3)||'  '||(metadata->>'title')
     FROM docs WHERE metadata->>'collection' = '${collection}'
     ORDER BY embedding <=> embed(\$q\$${q}\$q\$) LIMIT 1;")
  printf '  %s\n      %s\n' "$row" "$q"
  total=$(awk -v t="$total" -v r="${row%% *}" 'BEGIN{print t+r}')
  n=$((n + 1))
done < "$probes"
[ "$n" -gt 0 ] && awk -v t="$total" -v n="$n" 'BEGIN{printf "\n  mean top-1 = %.3f over %d probes\n", t/n, n}'
