{
  # Ingestion pipeline for the local pgvector knowledge base (`ragdb`).
  #
  # WHY A FLAKE AND NOT A requirements.txt: the two dependencies below are the
  # whole runtime, and both are already in nixpkgs. Pinning them here means
  # `nix run .#ingest` reproduces the exact extractor on any machine in this
  # fleet, with nothing to install and no virtualenv to drift. Same rail the rest
  # of the fleet uses.
  description = "Fetch, extract, chunk and embed web documentation into the local pgvector store";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    {
      nixpkgs,
      flake-utils,
      ...
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = nixpkgs.legacyPackages.${system};

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
        py = pkgs.python3.withPackages (ps: [
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

        ingest = pkgs.writeShellApplication {
          name = "ingest";
          runtimeInputs = [ py ];
          text = ''exec python3 ${./ingest.py} "$@"'';
        };
      in
      {
        packages.ingest = ingest;
        packages.default = ingest;
        apps.ingest = {
          type = "app";
          program = "${ingest}/bin/ingest";
        };
        apps.default = {
          type = "app";
          program = "${ingest}/bin/ingest";
        };
        devShells.default = pkgs.mkShell {
          packages = [
            py
            pkgs.postgresql
          ];
        };
      }
    );
}
