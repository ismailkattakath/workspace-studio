#!/usr/bin/env python3
"""Contract tests for `ingest` — the parts a re-ingest depends on.

  - the item KEY must match the corpus export byte for byte, or a re-ingest
    makes a second item instead of replacing the first;
  - the item BODY must match the export's format, so a re-ingest produces the
    same document;
  - the upload must retry 429/5xx and fail fast on other 4xx;
  - credentials resolve env-first, and a missing one fails with a clear error.

NO TEST REACHES THE NETWORK OR THE KEYCHAIN. `urllib.request.urlopen` and
`subprocess.run` are replaced below with stubs that RAISE, so a test that forgot
to inject its fake fails instead of making a live upload with a real token.

Run: nix develop --command python3 test_ingest.py
"""

import email
import email.policy
import json
import subprocess
import sys
import urllib.error
import urllib.request


def _forbidden(*_a, **_k):
    raise AssertionError("a test reached the real network or Keychain")


urllib.request.urlopen = _forbidden  # before `ingest` binds its defaults
subprocess.run = _forbidden

import ingest  # noqa: E402

FAILURES: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    if cond:
        print(f"  ok   {name}")
    else:
        print(f"  FAIL {name} {detail}")
        FAILURES.append(name)


class FakeResp:
    def __init__(self, body: dict):
        self._raw = json.dumps(body).encode()

    def read(self):
        return self._raw

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False


def http_error(code: int, headers: dict | None = None) -> urllib.error.HTTPError:
    import io
    from email.message import Message

    msg = Message()
    for k, v in (headers or {}).items():
        msg[k] = v
    return urllib.error.HTTPError("https://x", code, "err", msg, io.BytesIO(b"{}"))


def scripted_opener(script: list):
    """Each call pops the next entry: an exception to raise, or a dict to
    return as a JSON response. Records each Request it was given."""
    calls: list[urllib.request.Request] = []

    def opener(req, timeout=None):
        calls.append(req)
        step = script.pop(0)
        if isinstance(step, BaseException):
            raise step
        return FakeResp(step)

    return opener, calls


def main() -> int:
    # 1. The verified key example from the export (2026-11-19).
    url = "https://developers.google.com/workspace/add-ons/studio/versioning"
    check(
        "item_key matches the export's verified example",
        ingest.item_key("web", url)
        == "web/developers.google.com_workspace_add-ons_studio_versioning-2f8ae18f58.md",
        ingest.item_key("web", url),
    )

    # 2. Keys stay within the API's 128-char limit, even for a very long URL.
    long_url = "https://example.com/" + "/".join(["segment"] * 60) + "?q=1&x=y"
    key = ingest.item_key("web", long_url)
    check(
        "a long URL still yields a key <= 128 chars", len(key) <= 128, f"len={len(key)}"
    )
    check("the key is stable for the same URL", key == ingest.item_key("web", long_url))

    # 3. The body format, exactly.
    page = ingest.Page(url=url, title="Versioning", text="Body line.")
    check(
        "render_body matches the export's format",
        ingest.render_body(page) == f"# Versioning\n\nSource: {url}\n\nBody line.\n",
        repr(ingest.render_body(page)),
    )

    # 4. Metadata: only the filterable fields, each <= 256 chars.
    meta = ingest.item_metadata(ingest.Page(url=url, title="T" * 400, text=""), "web")
    check(
        "metadata keys are corpus/source/url/title only",
        set(meta) == {"corpus", "source", "url", "title"},
        str(sorted(meta)),
    )
    check("metadata values are <= 256 chars", all(len(v) <= 256 for v in meta.values()))

    # 5. The multipart body parses as two parts with the right names.
    ctype, data = ingest.build_multipart(
        "web/a_b-0123456789.md", "# T\n\nhé\n", {"corpus": "web"}
    )
    parsed = email.message_from_bytes(
        f"Content-Type: {ctype}\r\n\r\n".encode() + data, policy=email.policy.HTTP
    )
    parts = list(parsed.iter_parts())
    check("multipart has two parts", len(parts) == 2, f"got {len(parts)}")
    if len(parts) == 2:
        check(
            "file part carries the key as its filename",
            parts[0].get_param("name", header="content-disposition") == "file"
            and parts[0].get_filename() == "web/a_b-0123456789.md",
        )
        check(
            "file part is text/markdown with the exact body",
            parts[0].get_content_type() == "text/markdown"
            and parts[0].get_payload(decode=True) == "# T\n\nhé\n".encode(),
        )
        check(
            "metadata part is the JSON string",
            parts[1].get_param("name", header="content-disposition") == "metadata"
            and json.loads(parts[1].get_payload(decode=True)) == {"corpus": "web"},
        )
        check(
            "metadata part is a plain field (no Content-Type)",
            parts[1]["Content-Type"] is None,
            str(parts[1]["Content-Type"]),
        )

    endpoint = ingest.items_url("ACCOUNT", "rag")
    check(
        "items URL is the namespaced instance route",
        endpoint.endswith(
            "/accounts/ACCOUNT/ai-search/namespaces/default/instances/rag/items"
        ),
        endpoint,
    )

    # 6. Upload: success, retry on 429/5xx, fail fast on 4xx.
    sleeps: list[float] = []
    opener, calls = scripted_opener([{"success": True, "result": {"id": "abc"}}])
    ok, detail = ingest.upload(
        "k", "b", {}, url=endpoint, token="T0K", opener=opener, sleep=sleeps.append
    )
    check("upload succeeds on success=true", ok and "abc" in detail, detail)
    check(
        "upload sends POST with a bearer token",
        calls[0].get_method() == "POST"
        and calls[0].get_header("Authorization") == "Bearer T0K",
    )

    opener, calls = scripted_opener(
        [http_error(429, {"Retry-After": "3"}), http_error(503), {"success": True}]
    )
    sleeps.clear()
    ok, detail = ingest.upload(
        "k", "b", {}, url=endpoint, token="T0K", opener=opener, sleep=sleeps.append
    )
    check("429 then 503 then 200 succeeds", ok and len(calls) == 3, detail)
    check("429 honours Retry-After, 5xx backs off", sleeps == [3.0, 4.0], str(sleeps))

    opener, calls = scripted_opener([http_error(403)])
    ok, detail = ingest.upload(
        "k", "b", {}, url=endpoint, token="T0K", opener=opener, sleep=sleeps.append
    )
    check("403 fails without retrying", not ok and len(calls) == 1, detail)
    check("the token never appears in an error detail", "T0K" not in detail)

    opener, calls = scripted_opener([http_error(500)] * 3)
    ok, detail = ingest.upload(
        "k",
        "b",
        {},
        url=endpoint,
        token="T0K",
        retries=3,
        opener=opener,
        sleep=lambda _s: None,
    )
    check("persistent 5xx gives up after `retries`", not ok and len(calls) == 3, detail)

    opener, _ = scripted_opener([{"success": False, "errors": [{"code": 7}]}])
    ok, detail = ingest.upload(
        "k", "b", {}, url=endpoint, token="T0K", opener=opener, sleep=lambda _s: None
    )
    check("success=false is a failure", not ok, detail)

    # 7. Credentials.
    def no_keychain(*_a, **_k):
        raise AssertionError("Keychain consulted although the env var was set")

    check(
        "token: env var wins and the Keychain is not consulted",
        ingest.resolve_token({ingest.TOKEN_ENV: "envtok"}, run=no_keychain) == "envtok",
    )

    def keychain_ok(argv, **_k):
        assert argv[:3] == ["security", "find-generic-password", "-s"], argv
        assert argv[3] == ingest.KEYCHAIN_SERVICE, argv
        return subprocess.CompletedProcess(argv, 0, stdout="kctok\n", stderr="")

    check(
        "token: falls back to the Keychain item",
        ingest.resolve_token({}, run=keychain_ok) == "kctok",
    )

    def keychain_missing(argv, **_k):
        return subprocess.CompletedProcess(argv, 44, stdout="", stderr="not found")

    def no_security(*_a, **_k):
        raise FileNotFoundError("security")

    for name, runner in (("item missing", keychain_missing), ("no CLI", no_security)):
        try:
            ingest.resolve_token({}, run=runner)
            check(f"token: {name} raises ConfigError", False, "no error")
        except ingest.ConfigError:
            check(f"token: {name} raises ConfigError", True)

    try:
        ingest.resolve_account({})
        check("account: missing CF_ACCOUNT_ID raises ConfigError", False)
    except ingest.ConfigError:
        check("account: missing CF_ACCOUNT_ID raises ConfigError", True)
    check(
        "account: read from CF_ACCOUNT_ID",
        ingest.resolve_account({ingest.ACCOUNT_ENV: " acct "}) == "acct",
    )

    # 8. main(): a dry run needs no credentials; a real run checks them BEFORE
    #    the first fetch.
    import os

    fetched: list[str] = []
    real_fetch, real_extract = ingest.fetch, ingest.extract
    ingest.fetch = lambda u, **_k: fetched.append(u) or "<html/>"
    ingest.extract = lambda _h, u: ingest.Page(url=u, title="T", text="x")
    saved = {k: os.environ.pop(k, None) for k in (ingest.TOKEN_ENV, ingest.ACCOUNT_ENV)}
    try:
        rc = ingest.main(["--dry-run", "--delay", "0", url])
        check(
            "dry run needs no token or account",
            rc == 0 and fetched == [url],
            f"rc={rc}",
        )
        fetched.clear()
        rc = ingest.main(["--delay", "0", url])
        check(
            "real run without CF_ACCOUNT_ID exits 2 before fetching",
            rc == 2 and not fetched,
            f"rc={rc} fetched={fetched}",
        )
    finally:
        ingest.fetch, ingest.extract = real_fetch, real_extract
        for k, v in saved.items():
            if v is not None:
                os.environ[k] = v

    print()
    if FAILURES:
        print(f"{len(FAILURES)} FAILED: {', '.join(FAILURES)}")
        return 1
    print("all ingest contract properties hold")
    return 0


if __name__ == "__main__":
    sys.exit(main())
