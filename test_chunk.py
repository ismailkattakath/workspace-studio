#!/usr/bin/env python3
"""Contract tests for `ingest.chunk`.

`chunk` is now a thin wrapper over langchain-text-splitters'
RecursiveCharacterTextSplitter, so these no longer guard a hand-rolled
implementation. They are kept deliberately, as a CONTRACT the pipeline depends
on rather than tests of someone else's library:

  - the pipeline's own policy (dropping runt chunks) is ours to assert;
  - the splitter is a pinned dependency that can change behaviour across
    versions, and a silent regression here degrades retrieval quality without
    failing anything loudly;
  - the two inputs that broke the previous hand-rolled chunker (a single early
    ". " in a long block, and a fenced code block with no sentence ends) are
    cheap, real regression cases worth keeping pointed at whatever implements
    the split.

Run: nix develop --command python3 test_chunk.py
"""

import sys

from ingest import CHUNK_CHARS, MIN_CHUNK_CHARS, chunk

FAILURES: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    if cond:
        print(f"  ok   {name}")
    else:
        print(f"  FAIL {name} {detail}")
        FAILURES.append(name)


def main() -> int:
    # 1. The exact shape that caused the fragment explosion: a long paragraph
    #    whose ONLY ". " sits early. The old code searched the whole window, hit
    #    that single match, and produced a ~86-char chunk with a 1-char stride.
    evil = "x" * 90 + ". " + "y" * 4000
    cs = chunk(evil)
    check(
        "single early '. ' does not shatter the chunk", len(cs) <= 12, f"got {len(cs)}"
    )
    check(
        "no chunk exceeds CHUNK_CHARS",
        all(len(c) <= CHUNK_CHARS for c in cs),
        f"max={max(map(len, cs))}",
    )
    # Runts are COALESCED, not dropped, so the contract is "no runt survives
    # that had a neighbour with room" — a lone runt is legal, losing text is not.
    check(
        "runts are absorbed where possible",
        sum(1 for c in cs if len(c) < MIN_CHUNK_CHARS) <= 1,
        f"runts={[len(c) for c in cs if len(c) < MIN_CHUNK_CHARS]}",
    )

    # 2. A fenced code block has no ". " at all — the backtrack must not fire
    #    and the loop must still terminate.
    code = (
        "```\n"
        + "\n".join(f"  const v{i} = compute({i});" for i in range(300))
        + "\n```"
    )
    cs = chunk(code)
    check("code block terminates", len(cs) > 0)
    check(
        "code block chunks are full-size",
        (sum(len(c) for c in cs) / len(cs)) > CHUNK_CHARS * 0.5,
        f"avg={sum(len(c) for c in cs) / len(cs):.0f}",
    )

    # 3. Ordinary prose: many sentences, chunks should land near the target.
    prose = "\n\n".join(
        " ".join(f"Sentence number {j} in paragraph {i}." for j in range(40))
        for i in range(6)
    )
    cs = chunk(prose)
    avg = sum(len(c) for c in cs) / len(cs)
    check(
        "prose averages near the target",
        CHUNK_CHARS * 0.4 <= avg <= CHUNK_CHARS,
        f"avg={avg:.0f}",
    )

    # 4. Coverage: every paragraph's opening words must survive somewhere, i.e.
    #    chunking drops no content.
    marked = "\n\n".join(f"UNIQUEMARKER{i} " + ("z" * 1500) for i in range(5))
    cs = chunk(marked)
    missing = [i for i in range(5) if not any(f"UNIQUEMARKER{i}" in c for c in cs)]
    check("no paragraph is dropped", not missing, f"missing={missing}")

    # 5. Degenerate inputs must not hang or raise.
    for name, text in (("empty", ""), ("whitespace", "   \n\n  "), ("tiny", "hi")):
        try:
            chunk(text)
            check(f"degenerate input: {name}", True)
        except Exception as exc:  # noqa: BLE001 - the point is that nothing escapes
            check(f"degenerate input: {name}", False, str(exc))

    print()
    if FAILURES:
        print(f"{len(FAILURES)} FAILED: {', '.join(FAILURES)}")
        return 1
    print("all chunker properties hold")
    return 0


if __name__ == "__main__":
    sys.exit(main())
