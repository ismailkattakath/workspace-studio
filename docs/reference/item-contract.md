# Item contract

Every page becomes one AI Search item. `ingest.py` builds it with `item_key()` and
`render_body()`. Both follow the operator's corpus-export format byte for byte.

| Part | Value |
| --- | --- |
| key | `item_key("web", url)`: `web/<slug of the URL>-<sha1[:10]>.md`, at most 128 characters. `test_ingest.py` pins a verified example. |
| body | `# {title}\n\nSource: {url}\n\n{page text}\n` |
| metadata | `{"corpus": "web", "source": url, "url": url, "title": title}`, each value at most 256 characters |

## Filterable fields

The instance can filter only on `corpus`, `source`, `url`, `repo` and `title`. Any other
metadata key is stored but cannot be filtered. `collection` is not a field: it survives only
as the name of a source list in `sources/` and its probe file in `probes/`.

## Never change the key or the body format

A key that differs by one byte creates a second item for the same page. The old copy then
lives on as a stale duplicate and keeps answering queries.
