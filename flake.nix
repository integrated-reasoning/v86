{
  description = "v86 - x86 virtualization in your browser";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    rust-overlay.url = "github:oxalica/rust-overlay";
    cargo2nix = {
      url = "github:cargo2nix/cargo2nix/release-0.11.0";
      inputs.nixpkgs.follows = "nixpkgs";
      inputs.rust-overlay.follows = "rust-overlay";
    };
    crane = {
      url = "github:ipetkov/crane";
      inputs.nixpkgs.follows = "nixpkgs";
      inputs.flake-utils.follows = "flake-utils";
    };
  };

  outputs = { self, nixpkgs, flake-utils, rust-overlay, cargo2nix, crane }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        overlays = [
          (import rust-overlay)
          cargo2nix.overlays.default
        ];

        pkgs = import nixpkgs {
          inherit system overlays;
        };

        # Download pre-built wasi-sdk
        wasi-sdk = pkgs.stdenv.mkDerivation {
          name = "wasi-sdk";
          version = "20";

          src = pkgs.fetchurl {
            url = "https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-20/wasi-sdk-20.0-macos.tar.gz";
            sha256 = "sha256-j+okNPBQYuo22WBHi6hrmhcMxxheB2W/tJ0kuymjlGY=";
          };

          dontBuild = true;

          installPhase = ''
            mkdir -p $out
            cp -r . $out/
          '';
        };

        # Create a cargo2nix project for native build
        rustPkgsNative = pkgs.rustBuilder.makePackageSet {
          rustChannel = "nightly";
          packageFun = import ./Cargo.nix;
          packageOverrides = pkgs: pkgs.rustBuilder.overrides.all ++ [
            (pkgs.rustBuilder.rustLib.makeOverride {
              name = "v86";
              overrideAttrs = drv: {
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
                # Add code generation phase
                preBuildPhases = (drv.preBuildPhases or []) ++ [ "generateCode" ];
                generateCode = ''
                  # Set up environment
                  export NODE=${pkgs.nodejs}/bin/node

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
                buildPhase = let
                  target = "wasm32-unknown-unknown";
                  buildCDeps = ''
                    echo "Building native C dependencies..."
                    
                    # Build softfloat
                    $CC -c -O3 -fPIC \
                      -I${pkgs.darwin.Libsystem}/include \
                      -DSOFTFLOAT_FAST_INT64 \
                      -DINLINE_LEVEL=5 \
                      -DSOFTFLOAT_FAST_DIV32TO16 \
                      -DSOFTFLOAT_FAST_DIV64TO32 \
                      -DSOFTFLOAT_INTRINSIC_INT128 \
                      lib/softfloat/softfloat.c -o softfloat.o
                    
                    # Build zstd
                    $CC -c -O3 -fPIC \
                      -DXXH_NAMESPACE=ZSTD_ \
                      -DZDICTLIB_VISIBILITY= \
                      -DZSTD_LEGACY_SUPPORT=0 \
                      -DZSTD_LIB_DEPRECATED=0 \
                      -DDEBUGLEVEL=0 \
                      lib/zstd/zstddeclib.c -o zstd.o
                    
                    # Create static library
                    ${pkgs.darwin.cctools}/bin/ar rcs libv86deps.a softfloat.o zstd.o
                    cp libv86deps.a build/
                  '';
                in ''
                  # Set up build directory
                  mkdir -p build
                  export LIBCLANG_PATH="${pkgs.llvmPackages.libclang.lib}/lib"
                  
                  # Generate code tables
                  cd gen
                  ${pkgs.nodejs}/bin/node generate_jit.js --all
                  ${pkgs.nodejs}/bin/node generate_interpreter.js --all
                  ${pkgs.nodejs}/bin/node generate_analyzer.js --all
                  cd ..
                  
                  # Build C dependencies
                  export CC="${pkgs.clang}/bin/clang -arch arm64"
                  ${buildCDeps}
                  
                  # Build Rust code
                  cargo build --target ${target} --release
                '';
                # Enable raw_ref_op feature and link our C dependencies
                RUSTFLAGS = "-Z unstable-options --cfg feature=\"raw_ref_op\" -L build -l static=v86deps";
              };
            })
          ];
        };

        rustPlatform = pkgs.makeRustPlatform {
          cargo = pkgs.rust-bin.selectLatestNightlyWith (toolchain: toolchain.minimal.override {
            targets = [ "wasm32-unknown-unknown" ];
          });
          rustc = pkgs.rust-bin.selectLatestNightlyWith (toolchain: toolchain.minimal.override {
            targets = [ "wasm32-unknown-unknown" ];
          });
        };

        craneLib = crane.mkLib pkgs;
        
        v86-native = (rustPkgsNative.workspace.v86 {}).bin;
        
        # Common build settings
        commonBuildSettings = {
          nativeBuildInputs = with pkgs; [
            clang
            nodejs
            pkg-config
            rustPlatform.rust.rustc
            rustPlatform.rust.cargo
            jre
          ];

          buildInputs = with pkgs; [
            darwin.Libsystem
            darwin.cctools
            llvmPackages.libclang
          ];

          preBuildPhases = [ "generateCodePhase" "buildCDepsPhase" ];
          
          generateCodePhase = ''
            echo "=== Generate Code Phase ==="
            echo "Current directory: $(pwd)"
            echo "Directory contents:"
            ls -la
            
            # Generate code tables
            mkdir -p src/rust/gen
            cp -r ${src}/gen .
            cd gen
            ${pkgs.nodejs}/bin/node generate_jit.js --all
            ${pkgs.nodejs}/bin/node generate_interpreter.js --all
            ${pkgs.nodejs}/bin/node generate_analyzer.js --all
            cd ..
          '';

          buildCDepsPhase = ''
            echo "=== Build C Dependencies Phase ==="
            echo "Current directory: $(pwd)"
            echo "Directory contents:"
            ls -la
            
            # Set up build directory
            mkdir -p build
            export LIBCLANG_PATH="${pkgs.llvmPackages.libclang.lib}/lib"
            
            # Build C dependencies
            export CC="${pkgs.clang}/bin/clang -arch arm64"
            ${buildCDeps}
          '';
        };

        # Debug build
        v86-wasm-debug = pkgs.stdenv.mkDerivation (commonBuildSettings // {
          name = "v86-wasm-debug";
          inherit src;
          
          buildPhase = ''
            export CARGO_HOME=$PWD/.cargo-home
            export RUSTFLAGS="-Z unstable-options --cfg feature=\"raw_ref_op\" -L build -l static=v86deps"
            
            echo "=== Build Phase (Debug) ==="
            echo "Current directory: $(pwd)"
            
            # Create build directory
            mkdir -p build
            
            # List source directory
            echo "Source directory contents:"
            ls -la
            
            # Build debug wasm
            echo "Building debug wasm..."
            cargo build --target wasm32-unknown-unknown -vv
            
            # List build directory
            echo "Build directory contents:"
            ls -la build
            echo "wasm32 target directory contents:"
            ls -la build/wasm32-unknown-unknown/debug || true
          '';
          
          installPhase = ''
            echo "=== Install Phase (Debug) ==="
            echo "Current directory: $(pwd)"
            echo "Build directory contents:"
            ls -la build/wasm32-unknown-unknown/debug || true
            
            # Install artifacts
            mkdir -p $out/lib
            cp build/wasm32-unknown-unknown/debug/v86.wasm $out/lib/v86-debug.wasm
          '';
        });
        
        # Release build
        v86-wasm-release = pkgs.stdenv.mkDerivation (commonBuildSettings // {
          name = "v86-wasm-release";
          inherit src;
          
          buildPhase = ''
            export CARGO_HOME=$PWD/.cargo-home
            export RUSTFLAGS="-Z unstable-options --cfg feature=\"raw_ref_op\" -L build -l static=v86deps"
            
            echo "=== Build Phase (Release) ==="
            echo "Current directory: $(pwd)"
            
            # Create build directory
            mkdir -p build
            
            # List source directory
            echo "Source directory contents:"
            ls -la
            
            # Build release wasm
            echo "Building release wasm..."
            cargo build --release --target wasm32-unknown-unknown -vv
            
            # List build directory
            echo "Build directory contents:"
            ls -la build
            echo "wasm32 target directory contents:"
            ls -la build/wasm32-unknown-unknown/release || true
          '';
          
          installPhase = ''
            echo "=== Install Phase (Release) ==="
            echo "Current directory: $(pwd)"
            echo "Build directory contents:"
            ls -la build/wasm32-unknown-unknown/release || true
            
            # Install artifacts
            mkdir -p $out/lib
            cp build/wasm32-unknown-unknown/release/v86.wasm $out/lib/v86.wasm
          '';
        });
        
        # JavaScript build
        v86-js = pkgs.stdenv.mkDerivation (commonBuildSettings // {
          name = "v86-js";
          inherit src;
          
          buildPhase = ''
            export CARGO_HOME=$PWD/.cargo-home
            export RUSTFLAGS="-Z unstable-options --cfg feature=\"raw_ref_op\" -L build -l static=v86deps"
            
            echo "=== Build Phase (JavaScript) ==="
            echo "Current directory: $(pwd)"
            
            # Copy source files
            echo "Copying source files..."
            cp -r ${src}/src src/
            cp -r ${src}/lib lib/
            
            # Create defines.js
            echo "Creating defines.js..."
            cat > src/defines.js << 'EOF'
"use strict";

var DEBUG = false;
var DUMP_GENERATED_WASM = false;
var DUMP_UNCOMPILED_ASSEMBLY = false;
var LOG_TO_FILE = false;
var LOG_ALL_IO = false;
var LOG_LEVEL = 0;

EOF
            
            # List directories to verify
            echo "Source files:"
            ls -R src/
            echo "Lib files:"
            ls -R lib/
            
            # JavaScript Build Configuration
            # ------------------------------
            # The JavaScript build uses Google's Closure Compiler in ADVANCED mode for maximum
            # optimization and dead code elimination. The build process follows these rules:
            #
            # 1. File Order: Files are processed in a specific order to handle dependencies:
            #    - const.js and config.js must come first as they define constants
            #    - Core emulator files (io.js, main.js, etc.) follow
            #    - Browser-specific files come last
            #
            # 2. Constants (@define): All constants are defined in config.js with @define annotations:
            #    - DEBUG: Controls debug mode
            #    - LOG_TO_FILE: Enables file logging
            #    - LOG_ALL_IO: Enables verbose I/O logging
            #    - LOG_LEVEL: Controls logging verbosity
            #    - DUMP_*: Controls various debug dumps
            #    - TRACK_FILENAMES: Enables 9p filename tracking
            #    - DEBUG_SCREEN_LAYERS: Enables screen layer visualization
            #    - TSC_RATE: Sets the timestamp counter rate
            #
            # 3. Type Checking: Strict type checking is enabled with various JSC flags
            #
            # Note: Runtime modification of @define constants is not allowed
            # -------------------------------------------------------------

            # Build libv86.js
            echo "Building libv86.js..."
            java -jar ${pkgs.closurecompiler}/share/java/closure-compiler-v*.jar \
              --js_output_file build/libv86.js \
              --generate_exports \
              --externs src/externs.js \
              --compilation_level ADVANCED \
              --warning_level VERBOSE \
              --jscomp_error accessControls \
              --jscomp_error checkRegExp \
              --jscomp_error checkTypes \
              --jscomp_error checkVars \
              --jscomp_error conformanceViolations \
              --jscomp_error constantProperty \
              --jscomp_error deprecated \
              --jscomp_error deprecatedAnnotations \
              --jscomp_error duplicateMessage \
              --jscomp_error es5Strict \
              --jscomp_error externsValidation \
              --jscomp_error globalThis \
              --jscomp_error invalidCasts \
              --jscomp_error misplacedTypeAnnotation \
              --jscomp_error missingProperties \
              --jscomp_error missingReturn \
              --jscomp_error msgDescriptions \
              --jscomp_error nonStandardJsDocs \
              --jscomp_error suspiciousCode \
              --jscomp_error strictModuleDepCheck \
              --jscomp_error typeInvalidation \
              --jscomp_error undefinedVars \
              --jscomp_error unknownDefines \
              --jscomp_error visibility \
              --use_types_for_optimization \
              --assume_function_wrapper \
              --summary_detail_level 3 \
              --language_in ECMASCRIPT_2020 \
              --language_out ECMASCRIPT_2020 \
              --js src/const.js \
              --js src/config.js \
              --js src/io.js \
              --js src/main.js \
              --js src/lib.js \
              --js src/buffer.js \
              --js src/ide.js \
              --js src/pci.js \
              --js src/floppy.js \
              --js src/memory.js \
              --js src/dma.js \
              --js src/pit.js \
              --js src/vga.js \
              --js src/ps2.js \
              --js src/rtc.js \
              --js src/uart.js \
              --js src/acpi.js \
              --js src/apic.js \
              --js src/ioapic.js \
              --js src/state.js \
              --js src/ne2k.js \
              --js src/sb16.js \
              --js src/virtio.js \
              --js src/virtio_console.js \
              --js src/virtio_net.js \
              --js src/virtio_balloon.js \
              --js src/bus.js \
              --js src/log.js \
              --js src/cpu.js \
              --js src/debug.js \
              --js src/elf.js \
              --js src/kernel.js \
              --js lib/9p.js \
              --js lib/filesystem.js \
              --js lib/jor1k.js \
              --js lib/marshall.js \
              --js src/browser/screen.js \
              --js src/browser/keyboard.js \
              --js src/browser/mouse.js \
              --js src/browser/speaker.js \
              --js src/browser/serial.js \
              --js src/browser/network.js \
              --js src/browser/starter.js \
              --js src/browser/worker_bus.js \
              --js src/browser/dummy_screen.js \
              --js src/browser/inbrowser_network.js \
              --js src/browser/fake_network.js \
              --js src/browser/wisp_network.js \
              --js src/browser/fetch_network.js \
              --js src/browser/print_stats.js \
              --js src/browser/filestorage.js \
              --define "DEBUG=false" \
              --define "DUMP_GENERATED_WASM=false" \
              --define "DUMP_UNCOMPILED_ASSEMBLY=false" \
              --define "LOG_TO_FILE=false" \
              --define "LOG_ALL_IO=false" \
              --define "LOG_LEVEL=0" \
              --define "TRACK_FILENAMES=false" \
              --define "DEBUG_SCREEN_LAYERS=false" \
              --define "TSC_RATE=1000000"
            
            # Build libv86.mjs
            echo "Building libv86.mjs..."
            java -jar ${pkgs.closurecompiler}/share/java/closure-compiler-v*.jar \
              --js_output_file build/libv86.mjs \
              --generate_exports \
              --externs src/externs.js \
              --compilation_level ADVANCED \
              --warning_level VERBOSE \
              --jscomp_error accessControls \
              --jscomp_error checkRegExp \
              --jscomp_error checkTypes \
              --jscomp_error checkVars \
              --jscomp_error conformanceViolations \
              --jscomp_error constantProperty \
              --jscomp_error deprecated \
              --jscomp_error deprecatedAnnotations \
              --jscomp_error duplicateMessage \
              --jscomp_error es5Strict \
              --jscomp_error externsValidation \
              --jscomp_error globalThis \
              --jscomp_error invalidCasts \
              --jscomp_error misplacedTypeAnnotation \
              --jscomp_error missingProperties \
              --jscomp_error missingReturn \
              --jscomp_error msgDescriptions \
              --jscomp_error nonStandardJsDocs \
              --jscomp_error suspiciousCode \
              --jscomp_error strictModuleDepCheck \
              --jscomp_error typeInvalidation \
              --jscomp_error undefinedVars \
              --jscomp_error unknownDefines \
              --jscomp_error visibility \
              --use_types_for_optimization \
              --assume_function_wrapper \
              --summary_detail_level 3 \
              --language_in ECMASCRIPT_2020 \
              --language_out ECMASCRIPT_2020 \
              --js src/const.js \
              --js src/config.js \
              --js src/io.js \
              --js src/main.js \
              --js src/lib.js \
              --js src/buffer.js \
              --js src/ide.js \
              --js src/pci.js \
              --js src/floppy.js \
              --js src/memory.js \
              --js src/dma.js \
              --js src/pit.js \
              --js src/vga.js \
              --js src/ps2.js \
              --js src/rtc.js \
              --js src/uart.js \
              --js src/acpi.js \
              --js src/apic.js \
              --js src/ioapic.js \
              --js src/state.js \
              --js src/ne2k.js \
              --js src/sb16.js \
              --js src/virtio.js \
              --js src/virtio_console.js \
              --js src/virtio_net.js \
              --js src/virtio_balloon.js \
              --js src/bus.js \
              --js src/log.js \
              --js src/cpu.js \
              --js src/debug.js \
              --js src/elf.js \
              --js src/kernel.js \
              --js lib/9p.js \
              --js lib/filesystem.js \
              --js lib/jor1k.js \
              --js lib/marshall.js \
              --js src/browser/screen.js \
              --js src/browser/keyboard.js \
              --js src/browser/mouse.js \
              --js src/browser/speaker.js \
              --js src/browser/serial.js \
              --js src/browser/network.js \
              --js src/browser/starter.js \
              --js src/browser/worker_bus.js \
              --js src/browser/dummy_screen.js \
              --js src/browser/inbrowser_network.js \
              --js src/browser/fake_network.js \
              --js src/browser/wisp_network.js \
              --js src/browser/fetch_network.js \
              --js src/browser/print_stats.js \
              --js src/browser/filestorage.js \
              --define "DEBUG=false" \
              --define "DUMP_GENERATED_WASM=false" \
              --define "DUMP_UNCOMPILED_ASSEMBLY=false" \
              --define "LOG_TO_FILE=false" \
              --define "LOG_ALL_IO=false" \
              --define "LOG_LEVEL=0" \
              --define "TRACK_FILENAMES=false" \
              --define "DEBUG_SCREEN_LAYERS=false" \
              --define "TSC_RATE=1000000"
            
            # Build v86_all.js
            echo "Building v86_all.js..."
            java -jar ${pkgs.closurecompiler}/share/java/closure-compiler-v*.jar \
              --js_output_file build/v86_all.js \
              --generate_exports \
              --externs src/externs.js \
              --compilation_level ADVANCED \
              --warning_level VERBOSE \
              --jscomp_error accessControls \
              --jscomp_error checkRegExp \
              --jscomp_error checkTypes \
              --jscomp_error checkVars \
              --jscomp_error conformanceViolations \
              --jscomp_error constantProperty \
              --jscomp_error deprecated \
              --jscomp_error deprecatedAnnotations \
              --jscomp_error duplicateMessage \
              --jscomp_error es5Strict \
              --jscomp_error externsValidation \
              --jscomp_error globalThis \
              --jscomp_error invalidCasts \
              --jscomp_error misplacedTypeAnnotation \
              --jscomp_error missingProperties \
              --jscomp_error missingReturn \
              --jscomp_error msgDescriptions \
              --jscomp_error nonStandardJsDocs \
              --jscomp_error suspiciousCode \
              --jscomp_error strictModuleDepCheck \
              --jscomp_error typeInvalidation \
              --jscomp_error undefinedVars \
              --jscomp_error unknownDefines \
              --jscomp_error visibility \
              --use_types_for_optimization \
              --assume_function_wrapper \
              --summary_detail_level 3 \
              --language_in ECMASCRIPT_2020 \
              --language_out ECMASCRIPT_2020 \
              --js src/const.js \
              --js src/config.js \
              --js src/io.js \
              --js src/main.js \
              --js src/lib.js \
              --js src/buffer.js \
              --js src/ide.js \
              --js src/pci.js \
              --js src/floppy.js \
              --js src/memory.js \
              --js src/dma.js \
              --js src/pit.js \
              --js src/vga.js \
              --js src/ps2.js \
              --js src/rtc.js \
              --js src/uart.js \
              --js src/acpi.js \
              --js src/apic.js \
              --js src/ioapic.js \
              --js src/state.js \
              --js src/ne2k.js \
              --js src/sb16.js \
              --js src/virtio.js \
              --js src/virtio_console.js \
              --js src/virtio_net.js \
              --js src/virtio_balloon.js \
              --js src/bus.js \
              --js src/log.js \
              --js src/cpu.js \
              --js src/debug.js \
              --js src/elf.js \
              --js src/kernel.js \
              --js lib/9p.js \
              --js lib/filesystem.js \
              --js lib/jor1k.js \
              --js lib/marshall.js \
              --js src/browser/screen.js \
              --js src/browser/keyboard.js \
              --js src/browser/mouse.js \
              --js src/browser/speaker.js \
              --js src/browser/serial.js \
              --js src/browser/network.js \
              --js src/browser/starter.js \
              --js src/browser/worker_bus.js \
              --js src/browser/dummy_screen.js \
              --js src/browser/inbrowser_network.js \
              --js src/browser/fake_network.js \
              --js src/browser/wisp_network.js \
              --js src/browser/fetch_network.js \
              --js src/browser/print_stats.js \
              --js src/browser/filestorage.js \
              --define "DEBUG=false" \
              --define "DUMP_GENERATED_WASM=false" \
              --define "DUMP_UNCOMPILED_ASSEMBLY=false" \
              --define "LOG_TO_FILE=false" \
              --define "LOG_ALL_IO=false" \
              --define "LOG_LEVEL=0" \
              --define "TRACK_FILENAMES=false" \
              --define "DEBUG_SCREEN_LAYERS=false" \
              --define "TSC_RATE=1000000"
            
            # Build WebAssembly module
            echo "Building wasm..."
            cargo build --release --target wasm32-unknown-unknown -vv
            
            # List build directory
            echo "Build directory contents:"
            ls -la build
            echo "wasm32 target directory contents:"
            ls -la build/wasm32-unknown-unknown/release || true
          '';
          
          installPhase = ''
            echo "=== Install Phase (JavaScript) ==="
            echo "Current directory: $(pwd)"
            
            # Install artifacts
            mkdir -p $out/lib
            cp build/libv86.js $out/lib/
            cp build/libv86.mjs $out/lib/
            cp build/v86_all.js $out/lib/
            cp build/wasm32-unknown-unknown/release/v86.wasm $out/lib/
          '';
        });
        
        src = pkgs.lib.cleanSourceWith {
          src = ./.;
          filter = path: type:
            (builtins.match ".*gen/.*" path != null) ||
            (builtins.match ".*lib/.*" path != null) ||
            (builtins.match ".*src/.*" path != null) ||
            (craneLib.filterCargoSources path type);
        };

        buildCDeps = ''
          echo "Building native C dependencies..."
          
          # Build softfloat
          $CC -c -O3 -fPIC \
            -I${pkgs.darwin.Libsystem}/include \
            -DSOFTFLOAT_FAST_INT64 \
            -DINLINE_LEVEL=5 \
            -DSOFTFLOAT_FAST_DIV32TO16 \
            -DSOFTFLOAT_FAST_DIV64TO32 \
            -DSOFTFLOAT_INTRINSIC_INT128 \
            ${src}/lib/softfloat/softfloat.c -o softfloat.o
          
          # Build zstd
          $CC -c -O3 -fPIC \
            -DXXH_NAMESPACE=ZSTD_ \
            -DZDICTLIB_VISIBILITY= \
            -DZSTD_LEGACY_SUPPORT=0 \
            -DZSTD_LIB_DEPRECATED=0 \
            -DDEBUGLEVEL=0 \
            ${src}/lib/zstd/zstddeclib.c -o zstd.o
          
          # Create static library
          ${pkgs.darwin.cctools}/bin/ar rcs libv86deps.a softfloat.o zstd.o
          cp libv86deps.a build/
        '';

      in {
        packages = {
          inherit v86-native;
          v86-wasm-debug = v86-wasm-debug;
          v86-wasm-release = v86-wasm-release;
          v86-js = v86-js;
          default = v86-native;
        };

        devShells.default = pkgs.mkShell {
          inputsFrom = [ v86-native ];
          buildInputs = with pkgs; [
            cargo2nix.packages.${system}.cargo2nix
            rust-bin.selectLatestNightlyWith (toolchain: toolchain.default)
            nodejs
            nodePackages.npm
            closurecompiler
            gnumake
            jre
            nasm
            python3
            which
          ];
        };
      });
}
