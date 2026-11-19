{
  # Ingestion pipeline for the operator's private Cloudflare AI Search instance
  # (`rag`): fetch, extract, upload one item per page.
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
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

    # The one non-nixpkgs input, and it is here because it DELETES hand-written
    # code rather than adding a framework: `formatter` and the `formatting` check
    # are both its output. Its only dependency is nixpkgs, so the `follows`
    # collapses it to a SINGLE extra lock node.
    treefmt-nix = {
      url = "github:numtide/treefmt-nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    {
      self,
      nixpkgs,
      treefmt-nix,
    }:
    let
      # `x86_64-darwin` is DELIBERATELY ABSENT, and re-adding it kills the WHOLE
      # flake rather than one platform: the fold below is `genAttrs`, so a throw
      # while evaluating any single system aborts the attrset. This pin
      # (nixos-unstable) THROWS on that platform — measured 2026-10-02 against
      # `legacyPackages.x86_64-darwin.hello`; upstream directs x86_64 Macs to the
      # `nixpkgs-26.05-darwin` branch instead.
      #   https://nixos.org/manual/nixpkgs/unstable/release-notes#x86_64-darwin-26.11
      # That is also why `flake-utils.lib.eachDefaultSystem` had to go: its list
      # includes x86_64-darwin, so `nix flake show --all-systems` on this repo
      # failed with that throw and nothing else could be evaluated either.
      systems = [
        "aarch64-darwin"
        "aarch64-linux"
        "x86_64-linux"
      ];
      forAll = f: nixpkgs.lib.genAttrs systems (system: f system nixpkgs.legacyPackages.${system});
      inherit (nixpkgs) lib;

      # ONE treefmt evaluation per system, reused by `formatter` and by the
      # `formatting` check, so `nix fmt` and CI can never run a different tool
      # set. `./treefmt.nix` must exist beside this file.
      treefmtEval = forAll (_: pkgs: treefmt-nix.lib.evalModule pkgs ./treefmt.nix);

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
      pythonFor = pkgs: pkgs.python3.withPackages (ps: [ ps.trafilatura ]);

      # ── What the dev shell promises. ──────────────────────────────────────────
      # ONE list: `devShells` AND the `toolchain-complete` check both read it, so
      # they can never disagree about what "the dev shell" contains. Inlining it
      # in `devShells` would make the check assert against a second copy, i.e.
      # against nothing.
      devPackagesFor = pkgs: [
        (pythonFor pkgs) # python3 + trafilatura
        pkgs.curl # bench.sh — the AI Search search call
        pkgs.jq # bench.sh — builds the request, reads the result
      ];

      # Binaries this repo's own scripts and CI shell out to and that MUST
      # resolve inside the dev shell. Writing them down is the whole of what
      # turns `toolchain-complete` from a tautology into a gate, because a
      # PACKAGE name is not a BINARY name: `pkgs.postgresql` ships `psql`,
      # `pkgs.nodejs` ships `node`, `python3.withPackages` ships `python3`. That
      # map is exactly what a reader editing the list above gets wrong, and
      # nothing else here notices.
      requiredBins = [
        "python3" # ingest.py, test_ingest.py
        "curl" # bench.sh
        "jq" # bench.sh
      ];

      # ── The project's own test command. ───────────────────────────────────────
      # This repo's contract suite, which is also the BLOCKING test step in
      # .github/workflows/ci.yml. There is no test runner — the file IS its
      # suite, and it exits non-zero on failure (CLAUDE.md § Commands).
      #
      # It runs clean inside the no-network sandbox because test_ingest.py
      # imports only `ingest` (trafilatura comes from the nixpkgs pin) and stubs
      # urllib and the Keychain call so that nothing can reach the API.
      # (The Workspace Studio add-on that used to live in `addon/` moved to its
      # own repo, ismailkattakath/jsonresume-connect, with its node suites.)
      #
      # NOT run here, on purpose: `./bench.sh`. It queries the live AI Search
      # instance with a scoped token, so it stays the local gate CLAUDE.md
      # § Verifying a change describes. That is a service dependency, not a
      # vendoring problem.
      projectGate = {
        command = ''
          python3 test_ingest.py
        '';
        packages = pkgs: devPackagesFor pkgs;
      };
    in
    {
      # treefmt's own wrapper, NOT a bare `pkgs.nixfmt-rfc-style`: `nix fmt`
      # hands the formatter the WHOLE tree, so a bare nixfmt dies
      # `unexpected end of input` on the first `README.md`. Config: ./treefmt.nix.
      formatter = forAll (system: _: treefmtEval.${system}.config.build.wrapper);

      packages = forAll (
        _system: pkgs:
        let
          ingest = pkgs.writeShellApplication {
            name = "ingest";
            runtimeInputs = [ (pythonFor pkgs) ];
            text = ''exec python3 ${./ingest.py} "$@"'';
          };
        in
        {
          inherit ingest;
          default = ingest;
        }
      );

      apps = forAll (
        system: _: {
          ingest = {
            type = "app";
            program = "${self.packages.${system}.ingest}/bin/ingest";
          };
          default = self.apps.${system}.ingest;
        }
      );

      devShells = forAll (
        _system: pkgs: {
          default = pkgs.mkShell {
            # The list itself lives in `devPackagesFor` up in the `let`, because
            # the `toolchain-complete` check reads the SAME binding. ADAPT it
            # there, not here — a second list here is what the check exists to
            # make impossible.
            packages = devPackagesFor pkgs;
          };
        }
      );

      # Three named checks, each able to go red for a DIFFERENT reason — plus the
      # packages alias.
      checks = forAll (
        system: pkgs:
        let
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
        # Aliasing `packages` into `checks` is DELIBERATE: `nix flake check` only
        # EVALUATES packages but BUILDS checks, so the alias promotes
        # evaluate→build. `ingest` is a `writeShellApplication`, which runs
        # shellcheck at BUILD time — so this one line is a live shell-lint gate,
        # not a no-op. Prior art: `numtide/blueprint` does it by design, and
        # `NixOS/templates`' haskell-hello ships the identical line.
        self.packages.${system}
        // {
          # OFF THE SHELF, not hand-written: `config.build.check` is
          # treefmt-nix's own `runCommandLocal` that copies the tree,
          # `git init && add && commit`s it, runs `treefmt --no-cache`, then
          # `git diff --exit-code`. Upstream names it `formatting` already, so
          # the attribute name is theirs, not an invention.
          # GOES RED WHEN: a tracked file is not formatted as ./treefmt.nix says
          # it should be.
          formatting = treefmtEval.${system}.config.build.check self;

          # Hand-written, because nothing off the shelf does this: `mkShell`
          # validates nothing, `devshell`'s `commands` asserts option SHAPE only,
          # and `devenv`'s test lands in `packages` not `checks`. So it uses the
          # conventional property-assertion idiom instead: `runCommandLocal` +
          # `nativeBuildInputs`, asserting over a list.
          # GOES RED WHEN: a name in `requiredBins` resolves to no binary in
          # `devPackagesFor` — i.e. the dev shell silently stopped providing
          # something a script here depends on.
          toolchain-complete =
            pkgs.runCommandLocal "toolchain-complete" { nativeBuildInputs = devPackagesFor pkgs; }
              ''
                missing=""
                for bin in ${lib.escapeShellArgs requiredBins}; do
                  command -v "$bin" >/dev/null 2>&1 || missing="$missing $bin"
                done
                if [ -n "$missing" ]; then
                  echo "dev shell is missing:$missing" >&2
                  echo "add the package that SHIPS each one to devPackagesFor — a package name" >&2
                  echo "is not a binary name (postgresql ships psql, nodejs ships node)." >&2
                  exit 1
                fi
                echo "all ${toString (builtins.length requiredBins)} required binaries resolve." > "$out"
              '';

          # GOES RED WHEN: any of this repo's contract suites fails. The real
          # gate — see the `projectGate` binding for what it runs and what it
          # deliberately does not.
          project-gate =
            pkgs.runCommandLocal "project-gate" { nativeBuildInputs = projectGate.packages pkgs; }
              ''
                # The fileset arrives read-only out of the store, and Python wants
                # to write __pycache__ beside its inputs — so copy it and restore
                # write permission rather than running in the store path.
                #
                # Into a SUBDIRECTORY, not the build cwd, and `chmod` that subdir
                # rather than `.`. Measured 2026-10-02: copying into `.` and
                # running `chmod -R u+w .` builds fine on aarch64-darwin but dies
                # on aarch64-linux with
                #   chmod: changing permissions of './builder.json': Operation not permitted
                # because `runCommandLocal` is structured-attrs, so the build cwd
                # also holds Nix's own `builder.json` / `.attr-*` files, which the
                # Linux sandbox does not let the builder re-mode. A check that is
                # green on the dev machine and red on every Linux runner is worse
                # than no check.
                mkdir gate
                cp -R ${gateSrc}/. gate/
                chmod -R u+w gate
                cd gate
                ${projectGate.command}
                touch "$out"
              '';
        }
      );
    };
}
