fn main() {
    // Only link CoreFoundation on macOS
    #[cfg(target_os = "macos")]
    {
        println!("cargo:rustc-link-lib=framework=CoreFoundation");
        println!("cargo:rustc-link-search=framework=/System/Library/Frameworks");
    }
}
