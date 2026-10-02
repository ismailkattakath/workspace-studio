#!/usr/bin/env python3
"""Fetch web documentation, extract the article body, chunk it, and store it in
the local pgvector corpus (`ragdb.docs`).

THE CONTRACT THIS FILE OBEYS is the `rag` skill (kattakath/skills), not one
invented here:

  - table `docs` is (id, content, metadata jsonb, embedding vector(768));
  - embeddings are computed IN POSTGRES by `embed(text)`, which calls local
    Ollama (nomic-embed-text). This script never builds a vector itself, so the
    ingest and query sides can never drift onto different models;
  - text is parameterized, never concatenated into SQL;
  - chunks are ~500-1000 characters on paragraph boundaries with a little
    overlap, because embedding quality degrades on long passages;
  - re-ingesting a source DELETES its old rows first, so a changed page does not
    leave stale chunks behind.

Nothing leaves the machine: Postgres and Ollama are both loopback.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass

import psycopg
import trafilatura
from langchain_text_splitters import RecursiveCharacterTextSplitter

# The store is unix-socket only: `pg_hba.conf` has no entry for host
# 127.0.0.1, so a TCP DSN fails with "no pg_hba.conf entry" even though the
# port is open. Connect by socket DIRECTORY (libpq treats a leading "/" host as
# a socket dir), which is also how the fleet's own tooling reaches it.
#
# RESOLVED, NOT HARDCODED. This used to be an absolute "/Users/<name>/..."
# literal, which is a portability bug before it is anything else: the script
# simply does not run on another machine, or under another account, or if the
# store ever moves. Environment first (so a caller can point at a different
# store without editing code), then the XDG data dir, then the conventional
# location under the invoking user's home — none of which name a person.
DEFAULT_SOCKET_DIR = os.environ.get("RAGDB_SOCKET_DIR") or os.path.join(
    os.environ.get("XDG_DATA_HOME") or os.path.expanduser("~/.local/share"),
    "postgres-pgvector",
)
DEFAULT_PORT = int(os.environ.get("RAGDB_PORT", "5433"))
DEFAULT_DB = os.environ.get("RAGDB_DATABASE", "ragdb")

# Chunking. The rag skill's guidance is 500-1000 chars; 900 with 150 overlap
# sits at the top of that band, which keeps a whole procedure step together on
# these pages while still giving the splitter room to find a natural boundary.
CHUNK_CHARS = 900
CHUNK_OVERLAP = 150
MIN_CHUNK_CHARS = 80  # below this a chunk is nav crumbs, not content

USER_AGENT = "workspace-studio-ingest/1.0 (+local knowledge base; contact: repo owner)"


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
    navigation, and navigation text embedded into a corpus produces confident
    retrieval of menu labels.
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


# One splitter instance, reused. The separator order is the point of
# RecursiveCharacterTextSplitter: it tries paragraph breaks first, then single
# newlines, then sentence ends, then spaces, and only falls back to a hard
# character cut when nothing better exists. That is precisely the behaviour the
# hand-rolled version was groping toward — and the reason it had bugs, since
# each fallback level is its own edge case.
#
# `keep_separator` preserves the markdown structure trafilatura emitted, so a
# chunk does not silently lose the newline that separated a heading from its
# body.
def _make_splitter(
    size: int = CHUNK_CHARS, overlap: int = CHUNK_OVERLAP
) -> RecursiveCharacterTextSplitter:
    return RecursiveCharacterTextSplitter(
        chunk_size=size,
        chunk_overlap=overlap,
        separators=["\n\n", "\n", ". ", " ", ""],
        keep_separator=True,
        length_function=len,
    )


_SPLITTER = _make_splitter()


def chunk(
    text: str, splitter: RecursiveCharacterTextSplitter | None = None
) -> list[str]:
    """Split into ~CHUNK_CHARS passages on the most natural boundary available.

    OFF THE SHELF ON PURPOSE. This used to be ~60 lines of hand-rolled window
    walking; see the note on `langchain-text-splitters` in flake.nix for why it
    is not any more.

    The one local policy is what to do with a RUNT — a fragment shorter than
    MIN_CHUNK_CHARS that the splitter isolated, e.g. a short lead-in followed by
    a long unbroken block. Runts are usually navigation crumbs and embed badly,
    so the first version simply DROPPED them.

    That was lossy, and the contract test caught it: a paragraph whose opening
    words split off as a 13-character fragment lost those words from the corpus
    entirely. Dropping content silently is worse than a slightly oversized
    chunk, so a runt is now COALESCED into whichever neighbour has room, and
    only kept standalone when neither does. Nothing is discarded.
    """
    pieces = [c.strip() for c in (splitter or _SPLITTER).split_text(text) if c.strip()]
    out: list[str] = []
    for piece in pieces:
        if len(piece) >= MIN_CHUNK_CHARS:
            out.append(piece)
            continue
        # Runt: prefer merging backwards (keeps reading order natural), then
        # forwards, and only stand alone if neither neighbour can absorb it.
        if out and len(out[-1]) + len(piece) + 1 <= CHUNK_CHARS:
            out[-1] = f"{out[-1]} {piece}"
        else:
            out.append(piece)
    # A runt that landed first with a large follower is still standalone here;
    # merge it forward if that fits, so the common "short lead-in" case is
    # covered in both directions.
    if (
        len(out) > 1
        and len(out[0]) < MIN_CHUNK_CHARS
        and len(out[0]) + len(out[1]) + 1 <= CHUNK_CHARS
    ):
        out[0] = f"{out[0]} {out[1]}"
        del out[1]
    return out


def store(
    conn: psycopg.Connection, page: Page, chunks: list[str], collection: str
) -> int:
    """Replace this source's rows, then insert the new ones.

    DELETE-then-INSERT in ONE transaction is what makes a re-run idempotent
    rather than additive. `embed($1)` runs in Postgres — see the module docstring.
    """
    with conn.cursor() as cur:
        cur.execute("DELETE FROM docs WHERE metadata->>'source' = %s", (page.url,))
        for i, body in enumerate(chunks):
            metadata = {
                "source": page.url,
                "title": page.title,
                "collection": collection,
                "chunk": i,
                "chunks_total": len(chunks),
                "ingested_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            }
            cur.execute(
                "INSERT INTO docs (content, metadata, embedding) VALUES (%s, %s::jsonb, embed(%s))",
                (body, json.dumps(metadata), body),
            )
    return len(chunks)


def main() -> int:
    # Line-buffer stdout. Python block-buffers when stdout is a pipe or file, so
    # a long or stuck run looks like it produced NOTHING rather than showing how
    # far it got — which is exactly how the chunker hang above hid itself.
    sys.stdout.reconfigure(line_buffering=True)

    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("urls", nargs="*", help="URLs to ingest")
    ap.add_argument(
        "--url-file", help="file with one URL per line (# comments ignored)"
    )
    ap.add_argument(
        "--collection", required=True, help="logical corpus name, stored in metadata"
    )
    ap.add_argument("--socket-dir", default=DEFAULT_SOCKET_DIR)
    ap.add_argument("--port", type=int, default=DEFAULT_PORT)
    ap.add_argument("--db", default=DEFAULT_DB)
    ap.add_argument(
        "--delay", type=float, default=1.0, help="seconds between fetches (be polite)"
    )
    ap.add_argument(
        "--dry-run", action="store_true", help="extract and chunk, write nothing"
    )
    # Exposed so a source with an unusual shape can be MEASURED at several
    # settings rather than argued about. The default is the rag skill's
    # 500-1000 band; override it only with a probe comparison to justify it.
    ap.add_argument("--chunk-size", type=int, default=CHUNK_CHARS)
    ap.add_argument("--chunk-overlap", type=int, default=CHUNK_OVERLAP)
    args = ap.parse_args()

    urls = list(args.urls)
    if args.url_file:
        with open(args.url_file, encoding="utf-8") as fh:
            urls += [ln.strip() for ln in fh if ln.strip() and not ln.startswith("#")]
    # de-duplicate, preserving order
    urls = list(dict.fromkeys(urls))
    if not urls:
        ap.error("no URLs given")

    splitter = _make_splitter(args.chunk_size, args.chunk_overlap)

    conn = None
    if not args.dry_run:
        conn = psycopg.connect(host=args.socket_dir, port=args.port, dbname=args.db)

    pages = failed = total_chunks = 0
    for n, url in enumerate(urls, 1):
        print(f"[{n}/{len(urls)}] {url}")
        html = fetch(url)
        if html is None:
            failed += 1
            continue
        page = extract(html, url)
        if page is None:
            print("  ! no article body extracted", file=sys.stderr)
            failed += 1
            continue
        pieces = chunk(page.text, splitter)
        if not pieces:
            print("  ! nothing left after chunking", file=sys.stderr)
            failed += 1
            continue
        print(f"  {page.title}  —  {len(page.text)} chars -> {len(pieces)} chunks")
        if conn is not None:
            store(conn, page, pieces, args.collection)
            conn.commit()
        pages += 1
        total_chunks += len(pieces)
        if n < len(urls):
            time.sleep(args.delay)

    if conn is not None:
        conn.close()

    print(
        f"\npages={pages} failed={failed} chunks={total_chunks} collection={args.collection}"
        + ("  (DRY RUN — nothing written)" if args.dry_run else "")
    )
    return 1 if pages == 0 else 0


if __name__ == "__main__":
    sys.exit(main())
