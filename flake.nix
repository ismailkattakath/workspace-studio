{
  # Ingestion pipeline for the local pgvector knowledge base (`ragdb`).
  #
  # WHY A FLAKE AND NOT A requirements.txt: the three dependencies below are the
  # whole runtime, and all three are already in nixpkgs. Pinning them here means
  # `nix run .#ingest` reproduces the exact extractor on any machine in this
  # fleet, with nothing to install and no virtualenv to drift. Same rail the rest
  # of the fleet uses.
  #
  # It is ALSO what makes `nix flake check` a real gate rather than an evaluation
  # smoke test: `nix flake check` builds in a sandbox with NO NETWORK, so a test
  # command whose dependencies come from `pip install` cannot run there. These
  # come from the nixpkgs pin, i.e. they are already vendored, which is why
  # `project-gate` below genuinely executes this repo's own test suites.
  description = "Fetch, extract, chunk and embed web documentation into the local pgvector store";

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
      # psycopg is the PG driver: it parameterizes, which the rag skill
      # requires ("never string-concatenate user text into SQL").
      pythonFor =
        pkgs:
        pkgs.python3.withPackages (ps: [
          ps.trafilatura
          ps.psycopg
          # The SPLITTER, and the reason this line exists at all: the chunker was
          # hand-rolled first, and it was the one part of this pipeline with a
          # mature off-the-shelf answer sitting in nixpkgs the whole time. The
          # custom version shipped two bugs in a single session — an infinite
          # loop, and a sentence-boundary backtrack that turned 10,934 chars into
          # 158 fragments with a median length of 120 — and then acquired ten
          # property tests to defend a wheel that did not need reinventing.
          #
          # `langchain-text-splitters` is the STANDALONE package, not the
          # LangChain monolith: RecursiveCharacterTextSplitter and friends, no
          # agent framework, no LLM client, no vector-store opinion. It is the
          # most exercised chunker in the RAG ecosystem, and it leaves this
          # pipeline's actual differentiator (in-DB embed(), the shared corpus's
          # collection namespacing) untouched.
          ps.langchain-text-splitters
        ]);

      # ── What the dev shell promises. ──────────────────────────────────────────
      # ONE list: `devShells` AND the `toolchain-complete` check both read it, so
      # they can never disagree about what "the dev shell" contains. Inlining it
      # in `devShells` would make the check assert against a second copy, i.e.
      # against nothing.
      devPackagesFor = pkgs: [
        (pythonFor pkgs) # python3 + the three runtime deps
        pkgs.postgresql # psql — how bench.sh reaches the store
        pkgs.nodejs # node — addon/test-loadjsonresume.mjs
      ];

      # Binaries this repo's own scripts and CI shell out to and that MUST
      # resolve inside the dev shell. Writing them down is the whole of what
      # turns `toolchain-complete` from a tautology into a gate, because a
      # PACKAGE name is not a BINARY name: `pkgs.postgresql` ships `psql`,
      # `pkgs.nodejs` ships `node`, `python3.withPackages` ships `python3`. That
      # map is exactly what a reader editing the list above gets wrong, and
      # nothing else here notices.
      requiredBins = [
        "python3" # ingest.py, test_chunk.py
        "psql" # bench.sh
        "node" # addon/test-loadjsonresume.mjs
      ];

      # ── The project's own test command. ───────────────────────────────────────
      # Both of this repo's contract suites, which are also the two BLOCKING
      # steps in .github/workflows/ci.yml. There is no test runner — each file IS
      # its suite, and each exits non-zero on failure (CLAUDE.md § Commands).
      #
      # Both run clean inside the no-network sandbox because every dependency
      # comes from the nixpkgs pin, so nothing is vendored by hand here:
      #   - test_chunk.py imports only `ingest`, whose three deps are in `py`;
      #   - the .mjs uses node stdlib, and its ONE network section (two live
      #     JSON Resume registry fetches) is already written to `continue` with a
      #     `skip` line when the fetch throws. Sandboxed, those five live-resume
      #     assertions are skipped; the ~25 pure ones — parse, URL guard,
      #     formInputs shape, headline formatting, degenerate inputs — all run.
      #
      # NOT run here, on purpose: `./bench.sh`. It needs Postgres + pgvector + an
      # Ollama model, i.e. three services, so it stays the local gate CLAUDE.md
      # § Verifying a change describes. That is a service dependency, not a
      # vendoring problem — no amount of pinning puts a 768-dim embedder inside
      # the sandbox.
      projectGate = {
        command = ''
          python3 test_chunk.py
          node addon/test-loadjsonresume.mjs
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
          # `probes/` would rebuild a check that cannot even see them. These five
          # paths are exactly what the two suites read.
          gateSrc = lib.fileset.toSource {
            root = ./.;
            fileset = lib.fileset.unions [
              ./ingest.py
              ./test_chunk.py
              ./addon/test-loadjsonresume.mjs
              ./addon/LoadJsonResume.gs
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

          # GOES RED WHEN: either of this repo's contract suites fails. The real
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
