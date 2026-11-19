#!/usr/bin/env bash
# Report the top-1 AI Search hit for each probe query.
#
# curl + jq against the instance's own search route, and nothing else: AI Search
# embeds the query server-side with the same pinned model it embedded the items
# with, so this measures exactly what every other caller of the instance gets.
# Same credentials as ingest.py: $CF_ACCOUNT_ID (required), and the token from
# $CLOUDFLARE_AI_SEARCH_TOKEN or the Keychain item cf:cloudflare.com:ai-search.
#
# SCORES ARE NOT COSINE. `score` is AI Search's 0-1 relevance (hybrid vector +
# keyword), so the pgvector baselines recorded in probes/*.txt before 2026-11-19
# do not carry over. Both collections share corpus=web, so a probe can also land
# on the OTHER collection's page — read the title, not just the number.
#
# Usage: ./bench.sh <collection> [probe-file]   (collection names the probe file)
set -euo pipefail

collection="${1:?usage: bench.sh <collection> [probe-file]}"
probes="${2:-probes/${collection}.txt}"
account="${CF_ACCOUNT_ID:?CF_ACCOUNT_ID is not set (per-person data, never in this repo)}"
instance="${AI_SEARCH_INSTANCE:-rag}"
corpus="${AI_SEARCH_CORPUS:-web}"
url="https://api.cloudflare.com/client/v4/accounts/${account}/ai-search/namespaces/default/instances/${instance}/search"

token="${CLOUDFLARE_AI_SEARCH_TOKEN:-}"
if [ -z "$token" ]; then
  token=$(security find-generic-password -s cf:cloudflare.com:ai-search -w 2>/dev/null) || {
    echo "no CLOUDFLARE_AI_SEARCH_TOKEN and no readable Keychain item cf:cloudflare.com:ai-search" >&2
    exit 2
  }
fi

total=0 n=0
while IFS= read -r q; do
  [ -z "$q" ] && continue
  case "$q" in \#*) continue ;; esac
  body=$(jq -nc --arg q "$q" --arg c "$corpus" \
    '{query: $q, ai_search_options: {retrieval: {max_num_results: 1, filters: {corpus: $c}}}}')
  # The token goes in through a process-substituted header FILE, never argv,
  # so it does not show up in `ps`. printf is a builtin, so no child sees it.
  row=$(curl -sS --fail-with-body -X POST "$url" \
    -H @<(printf 'Authorization: Bearer %s\n' "$token") \
    -H 'Content-Type: application/json' \
    --data-binary "$body" |
    jq -r '.result.chunks[0] // {} | "\((.score // 0) * 1000 | round / 1000)  \(.item.metadata.title // .item.key // "(no hit)")"')
  printf '  %s\n      %s\n' "$row" "$q"
  total=$(awk -v t="$total" -v r="${row%% *}" 'BEGIN{print t+r}')
  n=$((n + 1))
done <"$probes"
[ "$n" -gt 0 ] && awk -v t="$total" -v n="$n" 'BEGIN{printf "\n  mean top-1 = %.3f over %d probes\n", t/n, n}'
