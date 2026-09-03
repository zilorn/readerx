/**
 * 统一 HTTP 通道：
 * - Tauri 环境走 tauri-plugin-http（Rust 原生请求，绕过 WebView CORS / 明文限制）；
 * - 纯浏览器开发环境回退到原生 fetch。
 */
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { isTauri } from "@tauri-apps/api/core";

export async function httpFetch(
  input: string,
  init?: RequestInit,
): Promise<Response> {
  if (isTauri()) return tauriFetch(input, init);
  return fetch(input, init);
}
