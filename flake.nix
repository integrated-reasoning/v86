{
  description = "v86 - x86 virtualization in your browser";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    rust-overlay = {
      url = "github:oxalica/rust-overlay";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    cargo2nix = {
      url = "github:cargo2nix/cargo2nix";
      inputs = {
        nixpkgs.follows = "nixpkgs";
        rust-overlay.follows = "rust-overlay";
      };
    };
    crane = {
      url = "github:ipetkov/crane";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { self, nixpkgs, flake-utils, rust-overlay, cargo2nix, crane }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs {
          inherit system;
          overlays = [ rust-overlay.overlays.default ];
        };

        alpineIso = pkgs.fetchurl {
          url = "https://dl-cdn.alpinelinux.org/alpine/v3.19/releases/x86_64/alpine-standard-3.19.1-x86_64.iso";
          hash = "sha256-Y+YvWlLP5zpssTfsuxEbfUg1aGKh3+UNj92XfXJ9oZI=";
        };

        perf-test-script = pkgs.writeScriptBin "run-perf-tests" ''
          #!${pkgs.bash}/bin/bash
          
          # Create working directory
          WORK_DIR=$(mktemp -d)
          cd "$WORK_DIR"
          
          # Create a disk image for Alpine
          ${pkgs.qemu}/bin/qemu-img create -f qcow2 alpine.qcow2 8G
          
          # Mount the ISO
          mkdir -p iso mnt
          cp ${alpineIso} ./alpine.iso
          ${pkgs.util-linux}/bin/mount -o loop alpine.iso mnt
          
          # First boot to install Alpine
          ${pkgs.qemu}/bin/qemu-system-x86_64 \
            -accel tcg \
            -cpu max \
            -m 2G \
            -smp 2 \
            -drive file=alpine.qcow2,if=virtio \
            -cdrom alpine.iso \
            -device virtio-net-pci,netdev=net0 \
            -netdev user,id=net0,hostfwd=tcp::2222-:22 \
            -nographic \
            -boot d \
            -kernel mnt/boot/vmlinuz-lts \
            -initrd mnt/boot/initramfs-lts \
            -append "console=ttyS0 modules=loop,squashfs,sd-mod,usb-storage quiet" \
            -no-reboot
          
          # Unmount ISO
          ${pkgs.util-linux}/bin/umount mnt
          
          # Second boot to run tests
          ${pkgs.qemu}/bin/qemu-system-x86_64 \
            -accel tcg \
            -cpu max \
            -m 2G \
            -smp 2 \
            -drive file=alpine.qcow2,if=virtio \
            -device virtio-net-pci,netdev=net0 \
            -netdev user,id=net0,hostfwd=tcp::2222-:22 \
            -nographic \
            -boot c \
            -no-reboot
          
          # Cleanup
          rm -rf "$WORK_DIR"
        '';
      in {
        packages = {
          default = perf-test-script;
        };

        apps = {
          default = flake-utils.lib.mkApp {
            drv = perf-test-script;
          };
        };

        devShell = pkgs.mkShell {
          buildInputs = with pkgs; [
            qemu
            p7zip
          ];
        };
      }
    );
}
