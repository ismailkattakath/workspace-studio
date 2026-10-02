# Format config, read from TWO places that must never disagree: `formatter` (what `nix fmt`
# runs) and the `formatting` check (what `nix flake check` fails on) are both built from this
# one module, via a single `treefmt-nix.lib.evalModule` call in flake.nix.
#
# WHY a module instead of `formatter = pkgs.nixfmt-rfc-style`: `nix fmt` hands the formatter the
# WHOLE tree, not just the .nix files. A bare nixfmt dies `unexpected end of input` on the first
# `README.md` it is given. Dispatching per file type is the entire reason treefmt exists.
{
  # Anchors treefmt's file walk at the repo root — a file that always exists at the top.
  projectRootFile = "flake.nix";

  # RFC 166 official style. The attribute is `nixfmt` (the package nixfmt-rfc-style took that
  # name upstream); `nixpkgs-fmt` is archived and must not be reached for.
  programs.nixfmt.enable = true;

  # This repo is Python-first (`ingest.py`, `test_chunk.py`) with two bash drivers
  # (`bench.sh`, `ingest-parallel.sh`). Those are the file types it actually has, so those are
  # the only formatters enabled — each one enabled pulls its tool into the closure of both
  # `nix fmt` and the `formatting` check, so an unused one is pure download.
  programs.black.enable = true;
  programs.shfmt.enable = true;

  # `addon/` is Apps Script: `.gs` files are JavaScript that no formatter here claims, and the
  # one `.mjs`/`.json` pair is not worth pulling prettier in for. Left unmatched, which treefmt
  # simply skips.

  # What no formatter of ours may rewrite. The `formatting` check compares the tree against
  # treefmt's own output, so a formatter that rewrites generated output turns the gate red on a
  # file nobody edits. treefmt globs match at ANY DEPTH.
  settings.global.excludes = [
    "*.lock"
    "flake.lock"
    "result"
    "result-*"
    "__pycache__/*"
    "*.pyc"
    ".direnv/*"
  ];
}
