#!/usr/bin/env python3
"""Fetch web documentation, extract the article body, and upload each page as
ONE item to the operator's private Cloudflare AI Search instance.

THE CONTRACT THIS FILE OBEYS:

  - one item per page. AI Search chunks and embeds each item itself
    (server-side, one pinned embedding model for ingest AND query), so this
    script never splits text and never builds a vector;
  - the item KEY is derived from the page URL by `item_key()`, byte for byte
    the formula the operator's corpus export used. Re-uploading an existing key
    is an UPSERT (the API returns the same item id), so a re-ingest REPLACES
    the page rather than adding a second copy;
  - the item BODY is `# {title}\\n\\nSource: {url}\\n\\n{text}\\n`, the export's
    format, so a re-ingest produces the same document the export did;
  - metadata is the instance's filterable fields only: corpus, source, url,
    title (each <= 256 chars).

Where it goes: Cloudflare-hosted, PRIVATE (the instance's public endpoint is
off). It is reached only with a scoped API token, from $CLOUDFLARE_AI_SEARCH_TOKEN
or the macOS login Keychain item `cf:cloudflare.com:ai-search`. The account id
comes from $CF_ACCOUNT_ID; it is per-person data and never lives in this repo.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid
from dataclasses import dataclass
from typing import Callable

import trafilatura

API_BASE = "https://api.cloudflare.com/client/v4"
DEFAULT_NAMESPACE = "default"
DEFAULT_INSTANCE = "rag"
DEFAULT_CORPUS = "web"  # the instance's `corpus` value for fetched web pages
KEYCHAIN_SERVICE = "cf:cloudflare.com:ai-search"
TOKEN_ENV = "CLOUDFLARE_AI_SEARCH_TOKEN"
ACCOUNT_ENV = "CF_ACCOUNT_ID"
METADATA_MAX = 256  # the API's per-value limit on filterable metadata
KEY_MAX = 128  # the API's limit on an item key

USER_AGENT = "free-rag-ingest/2.0 (+knowledge base; contact: repo owner)"


class ConfigError(RuntimeError):
    """A missing credential or setting. Raised before any page is fetched."""


@dataclass
class Page:
    url: str
    title: str
    text: str


def fetch(url: str, *, timeout: int = 30, retries: int = 3) -> str | None:
    """GET a URL as text. Returns None rather than raising, so one dead page
    cannot abort a whole run."""
    for attempt in range(1, retries + 1):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.read().decode("utf-8", errors="replace")
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError) as exc:
            if attempt == retries:
                print(
                    f"  ! fetch failed after {retries} tries: {url} ({exc})",
                    file=sys.stderr,
                )
                return None
            time.sleep(2 * attempt)
    return None


def extract(html: str, url: str) -> Page | None:
    """Article body only, as markdown.

    `include_comments=False` and the default boilerplate removal are the whole
    reason trafilatura is here rather than pandoc: a devsite page is mostly
    navigation, and navigation text in a corpus produces confident retrieval of
    menu labels.
    """
    meta = trafilatura.extract_metadata(html)
    title = (getattr(meta, "title", None) or url.rstrip("/").rsplit("/", 1)[-1]).strip()

    text = trafilatura.extract(
        html,
        output_format="markdown",
        include_comments=False,
        include_tables=True,  # devsite documents parameters in tables
        include_links=False,  # link URLs are noise inside an embedding
        favor_precision=True,
    )
    if not text or not text.strip():
        return None
    return Page(url=url, title=title, text=text.strip())


# ── The item key. ─────────────────────────────────────────────────────────────
# VERBATIM from the operator's corpus export (2026-11-19). Do not "tidy" it: a
# key that differs by one byte creates a SECOND item for the same page instead
# of replacing the first, and the old copy then lives on as a stale duplicate.
# test_ingest.py pins a verified example.
def slug(s, n):
    s = re.sub(r"^https?://", "", s)
    s = re.sub(r"[^A-Za-z0-9._/-]+", "-", s).strip("-/")
    s = s.replace("/", "_")
    return s[:n].strip("-_.") or "doc"


def item_key(corpus, ident):  # ident = the page URL
    h = hashlib.sha1(ident.encode()).hexdigest()[:10]
    base = f"{corpus}/"
    room = 128 - len(base) - len(h) - len("-.md")
    return f"{base}{slug(ident, room)}-{h}.md"


def render_body(page: Page) -> str:
    """The export's document format, exactly."""
    return f"# {page.title}\n\nSource: {page.url}\n\n{page.text}\n"


def item_metadata(page: Page, corpus: str = DEFAULT_CORPUS) -> dict[str, str]:
    return {
        "corpus": corpus,
        "source": page.url[:METADATA_MAX],
        "url": page.url[:METADATA_MAX],
        "title": page.title[:METADATA_MAX],
    }


def build_multipart(
    key: str, body: str, metadata: dict[str, str], *, boundary: str | None = None
) -> tuple[str, bytes]:
    """multipart/form-data with a `file` part (filename = the item key) and a
    `metadata` part (a JSON string). Stdlib has no multipart encoder, and this
    is two fixed parts, so a dependency would be bigger than the problem."""
    boundary = boundary or f"----ingest-{uuid.uuid4().hex}"
    safe_key = key.replace("\\", "\\\\").replace('"', '\\"')
    parts = [
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="file"; filename="{safe_key}"\r\n'
        "Content-Type: text/markdown\r\n\r\n".encode(),
        body.encode("utf-8"),
        b"\r\n",
        f"--{boundary}\r\n"
        # A plain form field, no Content-Type: the verified API shape is a
        # `metadata` part holding a JSON STRING; only `file` names a type.
        'Content-Disposition: form-data; name="metadata"\r\n\r\n'.encode(),
        json.dumps(metadata, ensure_ascii=False).encode("utf-8"),
        f"\r\n--{boundary}--\r\n".encode(),
    ]
    return f"multipart/form-data; boundary={boundary}", b"".join(parts)


def items_url(
    account_id: str, instance: str, namespace: str = DEFAULT_NAMESPACE
) -> str:
    return (
        f"{API_BASE}/accounts/{account_id}/ai-search/namespaces/{namespace}"
        f"/instances/{instance}/items"
    )


def _retry_after(exc: urllib.error.HTTPError, fallback: float) -> float:
    try:
        return max(float(exc.headers.get("Retry-After", "")), 0.0)
    except (TypeError, ValueError, AttributeError):
        return fallback


def upload(
    key: str,
    body: str,
    metadata: dict[str, str],
    *,
    url: str,
    token: str,
    retries: int = 5,
    timeout: int = 60,
    opener: Callable = urllib.request.urlopen,
    sleep: Callable[[float], None] = time.sleep,
) -> tuple[bool, str]:
    """Upload ONE item. Returns (ok, detail) and never raises for an API error,
    so one bad page cannot abort a run.

    Retries 429 and 5xx (and network errors) with exponential backoff, honouring
    Retry-After. Any other 4xx fails at once: it will not get better. The token
    is a parameter, never resolved here, and never appears in `detail`.
    """
    content_type, data = build_multipart(key, body, metadata)
    for attempt in range(1, retries + 1):
        backoff = float(2**attempt)
        req = urllib.request.Request(
            url,
            data=data,
            method="POST",
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": content_type,
                "User-Agent": USER_AGENT,
            },
        )
        try:
            with opener(req, timeout=timeout) as resp:
                raw = resp.read().decode("utf-8", errors="replace")
            try:
                doc = json.loads(raw)
            except json.JSONDecodeError:
                return False, f"non-JSON response: {raw[:200]}"
            if doc.get("success") is True:
                item_id = (doc.get("result") or {}).get("id", "?")
                return True, f"item {item_id}"
            return False, f"success=false: {json.dumps(doc.get('errors'))[:300]}"
        except urllib.error.HTTPError as exc:
            retryable = exc.code == 429 or 500 <= exc.code < 600
            try:
                detail = exc.read().decode("utf-8", errors="replace")[:300]
            except Exception:  # noqa: BLE001 - a body we cannot read is just absent
                detail = ""
            if not retryable or attempt == retries:
                return False, f"HTTP {exc.code}: {detail}"
            sleep(_retry_after(exc, backoff) if exc.code == 429 else backoff)
        except (urllib.error.URLError, TimeoutError) as exc:
            if attempt == retries:
                return False, f"network: {exc}"
            sleep(backoff)
    return False, "retries exhausted"


def resolve_token(
    env: dict[str, str] | None = None, run: Callable = subprocess.run
) -> str:
    """$CLOUDFLARE_AI_SEARCH_TOKEN, else the macOS login Keychain. The value is
    returned to be USED; nothing here prints or logs it."""
    env = os.environ if env is None else env
    token = (env.get(TOKEN_ENV) or "").strip()
    if token:
        return token
    try:
        proc = run(
            ["security", "find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"],
            capture_output=True,
            text=True,
            check=False,
        )
    except FileNotFoundError:
        raise ConfigError(
            f"no ${TOKEN_ENV} and no macOS `security` CLI to read the Keychain item "
            f"{KEYCHAIN_SERVICE!r} — export ${TOKEN_ENV} on this machine"
        ) from None
    token = (proc.stdout or "").strip()
    if proc.returncode != 0 or not token:
        raise ConfigError(
            f"no ${TOKEN_ENV}, and Keychain item {KEYCHAIN_SERVICE!r} could not be "
            f"read (security exit {proc.returncode})"
        )
    return token


def resolve_account(env: dict[str, str] | None = None) -> str:
    env = os.environ if env is None else env
    account = (env.get(ACCOUNT_ENV) or "").strip()
    if not account:
        raise ConfigError(
            f"${ACCOUNT_ENV} is not set — the Cloudflare account id is per-person "
            "data and is never stored in this repo"
        )
    return account


def main(argv: list[str] | None = None) -> int:
    # Line-buffer stdout: Python block-buffers a pipe, so a long or stuck run
    # would otherwise look like it produced NOTHING.
    sys.stdout.reconfigure(line_buffering=True)

    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("urls", nargs="*", help="URLs to ingest")
    ap.add_argument(
        "--url-file", help="file with one URL per line (# comments ignored)"
    )
    ap.add_argument(
        "--corpus",
        default=DEFAULT_CORPUS,
        help="the item's `corpus` metadata AND key prefix (default: web)",
    )
    ap.add_argument("--instance", default=DEFAULT_INSTANCE)
    ap.add_argument("--namespace", default=DEFAULT_NAMESPACE)
    ap.add_argument(
        "--delay", type=float, default=1.0, help="seconds between fetches (be polite)"
    )
    ap.add_argument(
        "--dry-run",
        action="store_true",
        help="fetch and extract, print each item key and size, upload nothing",
    )
    args = ap.parse_args(argv)

    urls = list(args.urls)
    if args.url_file:
        with open(args.url_file, encoding="utf-8") as fh:
            urls += [ln.strip() for ln in fh if ln.strip() and not ln.startswith("#")]
    urls = list(dict.fromkeys(urls))  # de-duplicate, preserving order
    if not urls:
        ap.error("no URLs given")

    # Credentials are checked ONCE, before the first fetch, so a missing token
    # fails in a second instead of after a whole crawl. A dry run needs neither.
    endpoint = token = None
    if not args.dry_run:
        try:
            endpoint = items_url(resolve_account(), args.instance, args.namespace)
            token = resolve_token()
        except ConfigError as exc:
            print(f"error: {exc}", file=sys.stderr)
            return 2

    pages = 0
    failed: list[str] = []
    for n, url in enumerate(urls, 1):
        print(f"[{n}/{len(urls)}] {url}")
        html = fetch(url)
        page = extract(html, url) if html is not None else None
        if page is None:
            if html is not None:
                print("  ! no article body extracted", file=sys.stderr)
            failed.append(url)
        else:
            key = item_key(args.corpus, page.url)
            body = render_body(page)
            print(f"  {page.title}  —  {len(body.encode())} bytes -> {key}")
            if endpoint is not None:
                ok, detail = upload(
                    key,
                    body,
                    item_metadata(page, args.corpus),
                    url=endpoint,
                    token=token,
                )
                if ok:
                    print(f"  uploaded: {detail}")
                    pages += 1
                else:
                    print(f"  ! upload failed: {detail}", file=sys.stderr)
                    failed.append(url)
            else:
                pages += 1
        if n < len(urls):
            time.sleep(args.delay)

    print(
        f"\npages={pages} failed={len(failed)} corpus={args.corpus} instance={args.instance}"
        + ("  (DRY RUN — nothing uploaded)" if args.dry_run else "")
    )
    for url in failed:
        print(f"  failed: {url}", file=sys.stderr)
    return 1 if failed or pages == 0 else 0


if __name__ == "__main__":
    sys.exit(main())
