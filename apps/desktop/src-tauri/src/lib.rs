//! PC 桌面壳。
//!
//! 壳只做三件事：拉起窗口、提供能力端口的实现、承载原生能力（托盘 / 更新）。
//! **零业务逻辑**（docs/00 §2.2）。M0 阶段只有 http 端口的实现：
//! 让 WebView 里的 `netFetch` 能通过 Rust 侧发请求，从而绕开 CORS。

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .run(tauri::generate_context!())
        .expect("运行 Tauri 应用失败");
}
