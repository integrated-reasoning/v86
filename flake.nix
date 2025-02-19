{
  description = "v86 - x86 virtualization in JavaScript";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    cargo2nix.url = "github:cargo2nix/cargo2nix";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, cargo2nix, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs {
          inherit system;
          overlays = [
            cargo2nix.overlays.default
          ];
        };

        # Create a cargo2nix project
        rustPkgs = pkgs.rustBuilder.makePackageSet {
          rustVersion = "1.75.0";
          packageFun = import ./Cargo.nix;
          packageOverrides = pkgs: pkgs.rustBuilder.overrides.all ++ [
            (pkgs.rustBuilder.rustLib.makeOverride {
              name = "v86";
              overrideAttrs = drv: {
                # Add wasm32 target
                CARGO_BUILD_TARGET = "wasm32-unknown-unknown";
                # Add C dependencies
                nativeBuildInputs = (drv.nativeBuildInputs or []) ++ (with pkgs; [
                  llvmPackages_16.clang-unwrapped
                  llvmPackages_16.libcxx
                  nodejs
                  nodePackages.npm
                  closurecompiler
                  gnumake
                  jre
                  nasm
                  python3
                  which
                ]);
              };
            })
          ];
        };

        # Common code generation function
        generateCodeScript = ''
          # Create gen output directory
          mkdir -p src/rust/gen

          # Generate JIT code
          $NODE gen/generate_jit.js --table jit
          $NODE gen/generate_jit.js --table jit0f

          # Generate interpreter code
          $NODE gen/generate_interpreter.js --table interpreter
          $NODE gen/generate_interpreter.js --table interpreter0f

          # Generate analyzer code
          $NODE gen/generate_analyzer.js --table analyzer
          $NODE gen/generate_analyzer.js --table analyzer0f

          # Ensure all files were generated
          for f in jit.rs jit0f.rs interpreter.rs interpreter0f.rs analyzer.rs analyzer0f.rs; do
            if [ ! -f "src/rust/gen/$f" ]; then
              echo "Error: Failed to generate $f"
              exit 1
            fi
          done
        '';

      in rec {
        packages = {
          v86 = (rustPkgs.workspace.v86 {}).bin;
          default = packages.v86;
        };

        devShells.default = pkgs.mkShell {
          inputsFrom = [ packages.v86 ];
          buildInputs = with pkgs; [
            # Development tools
            rust-analyzer
            rustfmt
            clippy
          ];

          shellHook = ''
            # Setup closure compiler symlink
            mkdir -p closure-compiler
            ln -sf ${pkgs.closurecompiler}/share/java/closure-compiler-v*.jar closure-compiler/compiler.jar

            # Generate code
            ${generateCodeScript}

            echo "v86 development shell"
            echo "Available commands:"
            echo "  make all          - Build all components"
            echo "  make browser      - Build browser version"
            echo "  cargo test        - Run Rust tests"
            echo "  make test         - Run all tests"
          '';
        };
      });
}
