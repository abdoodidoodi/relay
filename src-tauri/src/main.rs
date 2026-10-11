#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod relay;
fn main() {
    // Provider hooks must never initialize a GUI or trigger single-instance focus.
    if relay::hooks::run_cli_mode() {
        return;
    }
    relay::run();
}
