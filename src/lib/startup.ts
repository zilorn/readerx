/**
 * 页面启动后的本地数据迁移。
 *
 * 旧书库 / 稳定 ID 迁移可能扫描并改写大量文件；放在 Rust `setup` 里会占住主线程，
 * Android 覆盖安装后的首次启动可能因此无法完成 WebView 装配与首帧。这里在页面
 * 启动后通过 command 触发，调用方必须等它完成再读取书库、分组、规则等依赖迁移的
 * 数据（`index.tsx` 的启动顺序保证这一点）。
 */
import { invoke, isTauri } from "@tauri-apps/api/core";

export async function migrateStartupData(): Promise<void> {
  if (!isTauri()) return;
  await invoke("readerx_startup_migrate");
}
