{
  # Ingestion pipeline for the operator's private Cloudflare AI Search instance
  # (`rag`): fetch, extract, upload one item per page. On the fleet's shared repo
  # shape (github:ismailkattakath/repo-kit): devShell, treefmt, `toolchain-complete`
  # and the generated files (LICENSE, .envrc, .editorconfig, devcontainer.json,
  # `nix run .#write-files`) each with a drift check, all come from the kit.
  #
  # WHY A FLAKE AND NOT A requirements.txt: the one dependency below is the
  # whole runtime, and it is already in nixpkgs. Pinning them here means
  # `nix run .#ingest` reproduces the exact extractor on any machine in this
  # fleet, with nothing to install and no virtualenv to drift. Same rail the rest
  # of the fleet uses.
  #
  # It is ALSO what makes `nix flake check` a real gate rather than an evaluation
  # smoke test: `nix flake check` builds in a sandbox with NO NETWORK, so a test
  # command whose dependencies come from `pip install` cannot run there. These
  # come from the nixpkgs pin, i.e. they are already vendored, which is why
  # `project-gate` below genuinely executes this repo's own test suites.
  description = "Fetch and extract web documentation, and upload it to a private Cloudflare AI Search instance";

  inputs = {
    repo-kit.url = "github:ismailkattakath/repo-kit";
    nixpkgs.follows = "repo-kit/nixpkgs";
    flake-parts.follows = "repo-kit/flake-parts";
  };

  outputs =
    inputs@{ flake-parts, repo-kit, ... }:
    flake-parts.lib.mkFlake { inherit inputs; } {
      imports = [ repo-kit.flakeModules.default ];

      repoKit = {
        name = "workspace-studio";
        license = {
          spdx = "MIT";
          year = "2026";
          holder = "Ismail Kattakath";
        };
      };

      perSystem =
        {
          config,
          lib,
          pkgs,
          ...
        }:
        let
          # The pipeline's Python runtime.
          #
          # trafilatura is the EXTRACTOR, chosen over the alternatives on purpose:
          #   - pandoc (already on PATH) converts the WHOLE document, so a devsite
          #     page's left nav, breadcrumb, footer and cookie banner all land in
          #     the corpus as text. Measured on the Workspace Studio index page:
          #     172 KB of HTML, of which the article body is a small fraction.
          #   - a hand-rolled html.parser is exactly the wheel this repo's motto
          #     says not to reinvent, and boilerplate removal is a genuinely hard
          #     problem (trafilatura is a published benchmark leader on it).
          # Everything else is stdlib: the upload is one urllib multipart POST per
          # page. No splitter any more — AI Search chunks and embeds each item
          # server-side — and no database driver.
          python = pkgs.python3.withPackages (ps: [ ps.trafilatura ]);

          ingest = pkgs.writeShellApplication {
            name = "ingest";
            runtimeInputs = [ python ];
            text = ''exec python3 ${./ingest.py} "$@"'';
          };

          # Narrow fileset for the gate. A bare `./.` copies the whole working
          # tree into the store on every edit, so touching `sources/` or
          # `probes/` would rebuild a check that cannot even see them. These
          # paths are exactly what the suite reads.
          gateSrc = lib.fileset.toSource {
            root = ./.;
            fileset = lib.fileset.unions [
              ./ingest.py
              ./test_ingest.py
            ];
          };
        in
        {
          repoKit = {
            # ONE list: the devShell AND `toolchain-complete` both read it.
            devPackages = [
              python # python3 + trafilatura
              pkgs.curl # bench.sh — the AI Search search call
              pkgs.jq # bench.sh — builds the request, reads the result
            ];
            # Binaries this repo's own scripts and CI shell out to. A PACKAGE name
            # is not a BINARY name (`python3.withPackages` ships `python3`) — that
            # map is what `toolchain-complete` guards.
            requiredBins = [
              "python3" # ingest.py, test_ingest.py
              "curl" # bench.sh
              "jq" # bench.sh
            ];
          };

          packages = {
            inherit ingest;
            default = ingest;
          };

          apps = {
            ingest = {
              type = "app";
              program = "${ingest}/bin/ingest";
            };
            default = config.apps.ingest;
          };

          # This repo is Python-first (`ingest.py`, `test_ingest.py`) with two bash
          # drivers (`bench.sh`, `ingest-parallel.sh`), so black + shfmt beside the
          # kit's nixfmt. treefmt globs match at ANY DEPTH.
          treefmt = {
            programs.black.enable = true;
            programs.shfmt.enable = true;
            settings.global.excludes = [
              "*.lock"
              "flake.lock"
              "result"
              "result-*"
              "__pycache__/*"
              "*.pyc"
              ".direnv/*"
            ];
          };

          checks = {
            # Aliasing the package into `checks` is DELIBERATE: `nix flake check`
            # only EVALUATES packages but BUILDS checks. `ingest` is a
            # `writeShellApplication`, which runs shellcheck at BUILD time — so
            # this is a live shell-lint gate, not a no-op.
            inherit (config.packages) ingest default;

            # GOES RED WHEN: the ingest contract suite fails (CLAUDE.md § Commands).
            # It runs clean inside the no-network sandbox because test_ingest.py
            # imports only `ingest` (trafilatura comes from the nixpkgs pin) and
            # stubs urllib and the Keychain call so that nothing can reach the API.
            # NOT run here, on purpose: `./bench.sh`. It queries the live AI Search
            # instance with a scoped token, so it stays the local gate CLAUDE.md
            # § Verifying a change describes.
            project-gate =
              pkgs.runCommandLocal "project-gate" { nativeBuildInputs = config.repoKit.devPackages; }
                ''
                  # Copy into a SUBDIRECTORY and chmod that, not `.`: on Linux the
                  # build cwd also holds Nix's own `builder.json` / `.attr-*` files
                  # (structured attrs), which the sandbox does not let the builder
                  # re-mode (measured 2026-10-02). Python wants to write __pycache__.
                  mkdir gate
                  cp -R ${gateSrc}/. gate/
                  chmod -R u+w gate
                  cd gate
                  python3 test_ingest.py
                  touch "$out"
                '';
          };
        };
    };
}
