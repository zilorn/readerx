//! 网页登录态的**非 Cookie 部分**：localStorage / sessionStorage / IndexedDB。
//!
//! 为什么需要：一部分站点把登录凭证（JWT、`uid`+`token`）写在 localStorage 里而不是
//! Cookie 里，只抓 Cookie 的书源在这些站点上会「登录了但请求仍未登录」。这里负责三件事：
//!
//! 1. **采集**：登录浮层 / 真实浏览器在用户点「完成」时执行 [`probe_script`]（一条自包含、
//!    ES5 语法的脚本），把页面 origin 下的存储导成 JSON；
//! 2. **解析**：把浏览器回传的 JSON 归一成 [`StorageSnapshot`]（去重、限条数、限长度）；
//! 3. **读取**：`webview.storage()` 交给书源 JS 的扁平视图（见 [`snapshot_view`]）。
//!
//! 采集与「谁来执行脚本」解耦：Android 插件、CDP、webkit2gtk 三个后端各自把探针跑起来，
//! 拿回来的文本都走这里同一套解析。
//!
//! 边界（明确不做）：IndexedDB 只记库 / 版本 / 对象仓清单，**不导出记录内容**——
//! 记录里往往是整表业务数据，体积和隐私都不适合塞进登录态文件。

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

/// 单个 origin 每类存储最多保留的条目数
pub const MAX_ENTRIES_PER_ORIGIN: usize = 500;
/// 单个 origin 最多保留的 IndexedDB 数据库数
pub const MAX_DATABASES_PER_ORIGIN: usize = 50;
/// 单个值 / 键的最大字符数（超出截断并标记）
pub const MAX_VALUE_CHARS: usize = 8192;
/// 一次登录最多保留的 origin 数（登录链路可能跨好几个域）
pub const MAX_ORIGINS: usize = 8;

/// 一条键值（截断时用 `truncated` 标记）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageEntry {
    pub key: String,
    #[serde(default)]
    pub value: String,
    /// 值是否被截断（原值比存下来的长）
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub truncated: bool,
}

/// IndexedDB 元信息（只记结构，不记记录内容）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageDatabase {
    pub name: String,
    #[serde(default)]
    pub version: i64,
    #[serde(default)]
    pub stores: Vec<String>,
}

/// 一个 origin 下的全部存储
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageOrigin {
    /// origin（`https://example.com`，不含路径）
    pub origin: String,
    /// 采集时该 origin 下的页面地址（信息用途）
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub local_storage: Vec<StorageEntry>,
    #[serde(default)]
    pub session_storage: Vec<StorageEntry>,
    #[serde(default)]
    pub indexed_db: Vec<StorageDatabase>,
}

impl StorageOrigin {
    /// 是否没有任何内容
    pub fn is_empty(&self) -> bool {
        self.local_storage.is_empty()
            && self.session_storage.is_empty()
            && self.indexed_db.is_empty()
    }
}

/// 一次登录采集到的全部存储快照
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageSnapshot {
    /// 快照格式版本（当前 1）
    #[serde(default = "default_version")]
    pub version: u32,
    /// 采集时间（Unix 毫秒）
    #[serde(default)]
    pub updated_at: u64,
    #[serde(default)]
    pub origins: Vec<StorageOrigin>,
}

fn default_version() -> u32 {
    1
}

impl Default for StorageSnapshot {
    fn default() -> Self {
        Self {
            version: 1,
            updated_at: 0,
            origins: Vec::new(),
        }
    }
}

impl StorageSnapshot {
    /// 是否没有任何可用内容（空快照不值得写盘）
    pub fn is_empty(&self) -> bool {
        self.origins.iter().all(StorageOrigin::is_empty)
    }

    /// 按 origin 找一组（不存在返回 None）
    pub fn origin(&self, origin: &str) -> Option<&StorageOrigin> {
        let want = normalize_origin(origin);
        if want.is_empty() {
            return None;
        }
        self.origins.iter().find(|item| item.origin == want)
    }

    /// 主 origin：优先精确匹配 `url`，否则取带条目的第一组
    pub fn primary(&self, url: &str) -> Option<&StorageOrigin> {
        origin_of(url)
            .and_then(|origin| self.origin(&origin))
            .or_else(|| self.origins.iter().find(|item| !item.is_empty()))
    }

    /// 归一化：origin 归一（去尾斜杠 / 去空白）、丢掉空 origin、按 origin 排序、截断超量条目
    pub fn normalize(&mut self) {
        self.version = self.version.max(1);
        for origin in &mut self.origins {
            origin.origin = normalize_origin(&origin.origin);
            origin.local_storage.truncate(MAX_ENTRIES_PER_ORIGIN);
            origin.session_storage.truncate(MAX_ENTRIES_PER_ORIGIN);
            origin.indexed_db.truncate(MAX_DATABASES_PER_ORIGIN);
            origin.indexed_db.sort_by(|a, b| a.name.cmp(&b.name));
        }
        self.origins.retain(|origin| !origin.origin.is_empty());
        self.origins.sort_by(|a, b| a.origin.cmp(&b.origin));
        self.origins.dedup_by(|a, b| a.origin == b.origin);
        self.origins.truncate(MAX_ORIGINS);
    }
}

/// 交给书源 JS 的扁平视图：`webview.storage()` 的返回值。
///
/// 单 origin（绝大多数情况）直接给 `localStorage` / `sessionStorage` 两个键值对象；
/// 多 origin（登录链路跨域）时这些对象是各 origin 合并后的结果，另有 `origins` 数组
/// 保留每个 origin 的原始归属，键冲突以主 origin 为准。
pub fn snapshot_view(snapshot: &StorageSnapshot, login_url: &str) -> Value {
    let primary = snapshot.primary(login_url);
    let mut local = Map::new();
    let mut session = Map::new();
    let mut indexed_db: Vec<Value> = Vec::new();
    let mut seen_local: std::collections::HashSet<String> = Default::default();
    let mut seen_session: std::collections::HashSet<String> = Default::default();

    // 主 origin 先写入，其余 origin 只补主 origin 没有的键
    let primary_origin = primary.map(|item| item.origin.clone());
    let ordered = primary.into_iter().chain(
        snapshot
            .origins
            .iter()
            .filter(|item| primary_origin.as_deref() != Some(item.origin.as_str())),
    );

    for origin in ordered {
        for entry in &origin.local_storage {
            if seen_local.insert(entry.key.clone()) {
                local.insert(entry.key.clone(), Value::String(entry.value.clone()));
            }
        }
        for entry in &origin.session_storage {
            if seen_session.insert(entry.key.clone()) {
                session.insert(entry.key.clone(), Value::String(entry.value.clone()));
            }
        }
        for database in &origin.indexed_db {
            indexed_db.push(json!({
                "origin": origin.origin,
                "name": database.name,
                "version": database.version,
                "stores": database.stores,
            }));
        }
    }

    let origin = primary_origin.unwrap_or_default();
    let url = primary
        .map(|item| item.url.clone())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| login_url.trim().to_string());

    let mut view = Map::new();
    view.insert("ok".into(), Value::Bool(true));
    view.insert("url".into(), Value::String(url));
    view.insert("origin".into(), Value::String(origin));
    view.insert("localStorage".into(), Value::Object(local));
    view.insert("sessionStorage".into(), Value::Object(session));
    view.insert("indexedDb".into(), Value::Array(indexed_db));
    view.insert("updatedAt".into(), Value::Number(snapshot.updated_at.into()));
    if snapshot.origins.len() > 1 {
        view.insert(
            "origins".into(),
            Value::Array(
                snapshot
                    .origins
                    .iter()
                    .map(|item| {
                        json!({
                            "origin": item.origin,
                            "url": item.url,
                            "localStorage": entries_to_object(&item.local_storage),
                            "sessionStorage": entries_to_object(&item.session_storage),
                        })
                    })
                    .collect(),
            ),
        );
    }
    Value::Object(view)
}

/// 快照为空时的返回值（书源侧不必先判 null）
pub fn empty_view() -> Value {
    json!({
        "ok": true,
        "url": "",
        "origin": "",
        "localStorage": {},
        "sessionStorage": {},
        "indexedDb": [],
        "updatedAt": 0,
    })
}

fn entries_to_object(entries: &[StorageEntry]) -> Value {
    let mut map = Map::new();
    for entry in entries {
        map.insert(entry.key.clone(), Value::String(entry.value.clone()));
    }
    Value::Object(map)
}

/// 从 URL 取 origin（`https://example.com:8443`；解析不出来返回 None）
pub fn origin_of(url: &str) -> Option<String> {
    let trimmed = url.trim();
    // 注意 `url::Url::parse` 对空白串会解析成**空 URL**而不是报错，必须显式判空
    if trimmed.is_empty() {
        return None;
    }
    let parsed = url::Url::parse(trimmed).ok()?;
    let host = parsed.host_str()?;
    if host.is_empty() {
        return None;
    }
    Some(match parsed.port() {
        Some(port) => format!("{}://{}:{}", parsed.scheme(), host, port),
        None => format!("{}://{}", parsed.scheme(), host),
    })
}

/// 归一化外部传入的 origin：允许 `https://example.com/` 这类带尾斜杠写法
pub fn normalize_origin(origin: &str) -> String {
    let trimmed = origin.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    origin_of(trimmed).unwrap_or_else(|| trimmed.trim_end_matches('/').to_ascii_lowercase())
}

/// 解析浏览器回传的探针 JSON（[`probe_script`] 的返回值）。
///
/// 接受两种形状：探针整体输出（`{version, origins:[…]}`），或单个 origin 对象；
/// 每类存储既接受 `[{key,value}]` 也接受 `{k:v}` 写法，第三方脚本各写各的都能吃下来。
pub fn parse_probe(raw: &str) -> Result<StorageSnapshot, String> {
    let text = raw.trim();
    if text.is_empty() || text == "null" {
        return Ok(StorageSnapshot::default());
    }
    let value: Value = match serde_json::from_str(text) {
        Ok(value) => value,
        Err(e) => {
            // 只记长度与原因：探针输出里就是登录凭证，内容绝不进日志
            log::warn!("存储快照解析失败 bytes={} reason={e}", text.len());
            return Err(format!("解析存储快照失败: {e}"));
        }
    };
    let mut snapshot = StorageSnapshot::default();

    match value.get("origins").cloned() {
        Some(Value::Array(items)) => {
            for item in &items {
                snapshot.origins.push(origin_from_value(item));
            }
        }
        _ => {
            if value.is_object() && value.get("origin").is_some() {
                snapshot.origins.push(origin_from_value(&value));
            }
        }
    }

    if let Some(version) = value.get("version").and_then(|v| v.as_u64()) {
        snapshot.version = version as u32;
    }
    if let Some(updated) = value.get("updatedAt").and_then(|v| v.as_u64()) {
        snapshot.updated_at = updated;
    }
    snapshot.origins.retain(|origin| !origin.origin.trim().is_empty());
    snapshot.normalize();
    Ok(snapshot)
}

/// 把探针返回的 JS 值解析成快照。
///
/// Android 的 `evaluateJavascript` 会把字符串结果再包一层 JSON 引号并转义，
/// 因此这里允许「双重编码」的输入。
pub fn parse_probe_eval(raw: &str) -> Result<StorageSnapshot, String> {
    let text = raw.trim();
    if text.is_empty() || text == "null" {
        return Ok(StorageSnapshot::default());
    }
    if text.starts_with('"') {
        if let Ok(inner) = serde_json::from_str::<String>(text) {
            return parse_probe(&inner);
        }
    }
    parse_probe(text)
}

fn origin_from_value(value: &Value) -> StorageOrigin {
    let origin = value
        .get("origin")
        .and_then(|v| v.as_str())
        .map(normalize_origin)
        .unwrap_or_default();
    if origin.is_empty() {
        // 这一项随后会被 `retain` 丢掉：留一条线索，好区分「探针没跑」与「探针跑了但 origin 是空的」
        log::warn!(
            "存储快照条目缺少可用 origin，已丢弃 url={}",
            readerx_log::redact::url(value.get("url").and_then(|v| v.as_str()).unwrap_or(""))
        );
    }
    StorageOrigin {
        origin,
        url: value
            .get("url")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .trim()
            .to_string(),
        local_storage: entries_from_value(value.get("localStorage")),
        session_storage: entries_from_value(value.get("sessionStorage")),
        indexed_db: value
            .get("indexedDb")
            .and_then(|v| v.as_array())
            .map(|items| items.iter().map(database_from_value).collect())
            .unwrap_or_default(),
    }
}

fn entries_from_value(value: Option<&Value>) -> Vec<StorageEntry> {
    let Some(value) = value else {
        return Vec::new();
    };
    let mut entries = Vec::new();
    match value {
        // 探针输出：`[{key, value, truncated?}]`
        Value::Array(items) => {
            for item in items {
                let Some(key) = item.get("key").and_then(|v| v.as_str()) else {
                    continue;
                };
                entries.push(StorageEntry {
                    key: key.to_string(),
                    value: item
                        .get("value")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default()
                        .to_string(),
                    truncated: item
                        .get("truncated")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false),
                });
            }
        }
        // 键值对象写法（脚本 / 书源自定义回传）
        Value::Object(map) => {
            for (key, item) in map {
                let value = match item {
                    Value::String(text) => text.clone(),
                    other => other.to_string(),
                };
                entries.push(StorageEntry {
                    key: key.clone(),
                    value,
                    truncated: false,
                });
            }
        }
        _ => {}
    }
    entries
}

fn database_from_value(value: &Value) -> StorageDatabase {
    StorageDatabase {
        name: value
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
        version: value.get("version").and_then(|v| v.as_i64()).unwrap_or(0),
        stores: value
            .get("stores")
            .and_then(|v| v.as_array())
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| item.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default(),
    }
}

// ---------------------------------------------------------------------------
// 浏览器侧的采集探针
// ---------------------------------------------------------------------------

/// 采集存储的 JS 探针模板（ES5 语法，Android WebView / WebKitGTK / Chrome 通用）。
///
/// 由 [`probe_script`] 填好常量后，在**目标页面**里执行：
/// - 同步部分（localStorage / sessionStorage）当场完成；
/// - IndexedDB 只能异步枚举，结果落在 `window.__rxStorageProbeResult`，
///   宿主脚本需要轮询读取（见 `backend_cdp` / `backend_webkit` / Android 插件）。
pub const JS_PROBE: &str = r#"(function () {
  var MAX_ENTRIES = __RX_MAX_ENTRIES__;
  var MAX_VALUE = __RX_MAX_VALUE__;
  var MAX_DBS = __RX_MAX_DBS__;
  var EXTRA = __RX_EXTRA_ORIGINS__;
  var out = { version: 1, origins: [] };
  window.__rxStorageProbeDone = false;
  window.__rxStorageProbeResult = "";
  // 非浏览器环境（单测里用引擎自带的 JS 运行时跑本探针）没有 location
  var here = (typeof location !== "undefined" && location) ? location : { origin: "", href: "" };
  var current = String(here.origin || "");
  var list = [current];
  if (Object.prototype.toString.call(EXTRA) === "[object Array]") {
    for (var i = 0; i < EXTRA.length; i++) {
      var candidate = String(EXTRA[i] || "");
      if (candidate && list.indexOf(candidate) < 0) list.push(candidate);
    }
  }
  function clip(text) {
    var value = text == null ? "" : String(text);
    if (value.length <= MAX_VALUE) return { value: value, truncated: false };
    return { value: value.substring(0, MAX_VALUE), truncated: true };
  }
  function dump(store) {
    var entries = [];
    if (!store) return entries;
    for (var i = 0; i < store.length && entries.length < MAX_ENTRIES; i++) {
      var name = store.key(i);
      if (name == null) continue;
      var raw = null;
      try { raw = store.getItem(name); } catch (err) { raw = null; }
      var clipped = clip(raw);
      entries.push({ key: String(name), value: clipped.value, truncated: clipped.truncated });
    }
    return entries;
  }
  for (var k = 0; k < list.length; k++) {
    var page = {
      origin: list[k],
      url: list[k] === current ? String(here.href || "") : list[k],
      localStorage: [],
      sessionStorage: [],
      indexedDb: []
    };
    if (list[k] === current) {
      try { page.localStorage = dump(window.localStorage); } catch (err) {}
      try { page.sessionStorage = dump(window.sessionStorage); } catch (err) {}
    }
    out.origins.push(page);
  }
  function finish() {
    if (window.__rxStorageProbeDone) return;
    window.__rxStorageProbeResult = JSON.stringify(out);
    window.__rxStorageProbeDone = true;
  }
  try {
    // 只采同步部分时（`__RX_SYNC_ONLY__`，宿主在自己的主世界求值，拿不到异步回写）跳过 IndexedDB
    if (!__RX_SYNC_ONLY__) {
    // `typeof idb.databases === "function"` 在部分运行时里本身就可能抛错（属性访问器），
    // 因此整段包在 try 里，拿不到库清单就按「只有 localStorage / sessionStorage」收尾
    var idb = window.indexedDB;
    if (idb) {
      var find = idb.databases;
      if (typeof find === "function") {
        var pending = find.call(idb);
        if (pending && typeof pending.then === "function") {
          pending.then(function (databases) {
            var page = out.origins[0] || { indexedDb: [] };
            var known = databases || [];
            for (var i = 0; i < known.length && page.indexedDb.length < MAX_DBS; i++) {
              page.indexedDb.push({
                name: String(known[i].name == null ? "" : known[i].name),
                version: Number(known[i].version || 0),
                stores: []
              });
            }
            finish();
          }, function () { finish(); });
          return "pending";
        }
      }
    }
    }
  } catch (err) {}
  finish();
  return "pending";
})()"#;

/// 把探针模板里的占位符换成实际常量与 origin 列表
pub fn probe_script(extra_origins: &[String]) -> String {
    with_probe_constants(extra_origins, false)
}

/// 只采**同步**存储（localStorage / sessionStorage）的探针：跳过 IndexedDB 枚举。
///
/// 给「在宿主自己的主世界求值、拿不到异步回写」的调用方用（桌面端登录窗口）：
/// IndexedDB 枚举是 Promise，主世界的求值结果早就返回了，异步回写只会写进另一个世界，
/// 采到的库清单也会丢。跳过它，把同步部分（登录凭证绝大多数在这里）稳稳拿到。
pub fn probe_script_sync_only(extra_origins: &[String]) -> String {
    with_probe_constants(extra_origins, true)
}

fn with_probe_constants(extra_origins: &[String], sync_only: bool) -> String {
    let extra = serde_json::to_string(extra_origins).unwrap_or_else(|_| "[]".to_string());
    JS_PROBE
        .replace("__RX_MAX_ENTRIES__", &MAX_ENTRIES_PER_ORIGIN.to_string())
        .replace("__RX_MAX_VALUE__", &MAX_VALUE_CHARS.to_string())
        .replace("__RX_MAX_DBS__", &MAX_DATABASES_PER_ORIGIN.to_string())
        .replace("__RX_EXTRA_ORIGINS__", &extra)
        .replace("__RX_SYNC_ONLY__", if sync_only { "true" } else { "false" })
}

/// 把探针装进**页面**（只定义、不执行）：执行后页面里多出 `window.__rxStorageProbeRun()`，
/// 调用一次即采集一次当前页面的存储（结果落在 `window.__rxStorageProbeResult`）。
///
/// 用在「页面加载前注入、用户点完成时再采集」的宿主上（Android 浮层 / CDP）：
/// 探针在页面每次导航后自动就位，采集时刻却由宿主决定——登录写完 localStorage 之后
/// 采到的才是登录态。注入到所有框架（iframe 登录页的凭证常写在 iframe 自己的 origin 上），
/// 因此暴露在 `window` 上而不是包在闭包里；名字统一带 `__rx` 前缀，不与页面自身变量冲突。
pub fn probe_run_script(extra_origins: &[String]) -> String {
    let body = probe_script(extra_origins);
    format!(
        r#"(function () {{
  if (window.__rxStorageProbeRun) return;
  window.__rxStorageProbeRun = function () {{
{body}
  }};
}})()"#
    )
}

/// 读取探针结果并复位标记（宿主轮询到 `__rxStorageProbeDone` 后调用）
pub const JS_PROBE_READ: &str = r#"(function () {
  if (!window.__rxStorageProbeDone) return "";
  var text = window.__rxStorageProbeResult || "";
  window.__rxStorageProbeDone = false;
  window.__rxStorageProbeResult = "";
  return text;
})()"#;

/// 探针是否完成（供轮询判断，不消费结果）
pub const JS_PROBE_POLL: &str = r#"window.__rxStorageProbeDone ? "done" : "pending""#;

/// 与 [`JS_PROBE_POLL`] 配套的「还没跑完」返回值
pub const JS_PROBE_PENDING: &str = "pending";

/// 探针「还没采完」时 [`JS_PROBE_READ`] 的返回标记（与 `pending` 占位符同义，供后端比对）
pub const JS_PROBE_PENDING_MARK: &str = "";

/// 宿主采集存储所需的四段脚本（认证后端只需原样执行，不必知道探针细节，见 `auth::ProbeScript`）：
/// - `init`：页面加载前注入（**所有框架**），把探针装进页面世界；
/// - `run`：用户完成登录后求值，触发一次采集；
/// - `read`：求值读取采集结果（未采完时返回 `pending`）；
/// - `pending`：`read` 的「还没采完」标记。
pub fn probe_script_parts(extra_origins: &[String]) -> (String, String, String, String) {
    (
        probe_run_script(extra_origins),
        "window.__rxStorageProbeRun()".to_string(),
        JS_PROBE_READ.to_string(),
        JS_PROBE_PENDING.to_string(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_probe_output() {
        let raw = r#"{
            "version": 1,
            "origins": [
                {
                    "origin": "https://example.com",
                    "url": "https://example.com/home",
                    "localStorage": [
                        {"key": "token", "value": "abc"},
                        {"key": "long", "value": "xxx", "truncated": true}
                    ],
                    "sessionStorage": [{"key": "sid", "value": "s1"}],
                    "indexedDb": [{"name": "app", "version": 3, "stores": ["kv"]}]
                }
            ]
        }"#;
        let snapshot = parse_probe(raw).unwrap();
        assert_eq!(snapshot.origins.len(), 1);
        let origin = snapshot.origin("https://example.com").unwrap();
        assert_eq!(origin.local_storage.len(), 2);
        assert_eq!(origin.session_storage[0].key, "sid");
        assert!(origin.local_storage[1].truncated);
        assert_eq!(origin.indexed_db[0].stores, vec!["kv".to_string()]);
    }

    #[test]
    fn parses_key_value_object_shape() {
        let raw =
            r#"{"origin":"https://a.test/","localStorage":{"token":"t"},"sessionStorage":{"s":"1"}}"#;
        let snapshot = parse_probe(raw).unwrap();
        let origin = snapshot.origin("https://a.test").unwrap();
        assert_eq!(origin.local_storage[0].value, "t");
        assert_eq!(origin.session_storage[0].key, "s");
    }

    #[test]
    fn parse_probe_eval_handles_double_encoded_string() {
        let inner =
            r#"{"origins":[{"origin":"https://a.test","localStorage":[{"key":"k","value":"v"}]}]}"#;
        let wrapped = serde_json::to_string(inner).unwrap();
        let snapshot = parse_probe_eval(&wrapped).unwrap();
        assert_eq!(
            snapshot.origin("https://a.test").unwrap().local_storage[0].key,
            "k"
        );
    }

    #[test]
    fn empty_probe_is_empty_snapshot() {
        assert!(parse_probe("null").unwrap().is_empty());
        assert!(parse_probe("").unwrap().is_empty());
        assert!(parse_probe_eval("\"\"").unwrap().is_empty());
    }

    #[test]
    fn normalize_drops_blank_origin_and_caps_entries() {
        let entries: Vec<StorageEntry> = (0..MAX_ENTRIES_PER_ORIGIN + 20)
            .map(|i| StorageEntry {
                key: format!("k{i}"),
                value: "v".into(),
                truncated: false,
            })
            .collect();
        let mut snapshot = StorageSnapshot {
            version: 1,
            updated_at: 0,
            origins: vec![
                StorageOrigin {
                    origin: "  ".into(),
                    url: String::new(),
                    local_storage: entries.clone(),
                    session_storage: Vec::new(),
                    indexed_db: Vec::new(),
                },
                StorageOrigin {
                    origin: "https://b.test".into(),
                    url: String::new(),
                    local_storage: entries,
                    session_storage: Vec::new(),
                    indexed_db: Vec::new(),
                },
            ],
        };
        snapshot.normalize();
        // 注意：`normalize_origin("  ")` 会退化成空串，因此空 origin 被丢弃
        assert_eq!(snapshot.origins.len(), 1);
        assert_eq!(
            snapshot.origins[0].local_storage.len(),
            MAX_ENTRIES_PER_ORIGIN
        );
    }

    #[test]
    fn view_merges_origins_with_primary_first() {
        let snapshot = StorageSnapshot {
            version: 1,
            updated_at: 7,
            origins: vec![
                StorageOrigin {
                    origin: "https://api.test".into(),
                    url: "https://api.test/login".into(),
                    local_storage: vec![
                        StorageEntry {
                            key: "shared".into(),
                            value: "from-api".into(),
                            truncated: false,
                        },
                        StorageEntry {
                            key: "only-api".into(),
                            value: "1".into(),
                            truncated: false,
                        },
                    ],
                    session_storage: Vec::new(),
                    indexed_db: Vec::new(),
                },
                StorageOrigin {
                    origin: "https://www.test".into(),
                    url: String::new(),
                    local_storage: vec![StorageEntry {
                        key: "shared".into(),
                        value: "from-www".into(),
                        truncated: false,
                    }],
                    session_storage: vec![StorageEntry {
                        key: "s".into(),
                        value: "2".into(),
                        truncated: false,
                    }],
                    indexed_db: vec![StorageDatabase {
                        name: "db".into(),
                        version: 1,
                        stores: vec!["t".into()],
                    }],
                },
            ],
        };
        let view = snapshot_view(&snapshot, "https://www.test/login");
        assert_eq!(view["origin"], "https://www.test");
        assert_eq!(view["localStorage"]["shared"], "from-www");
        assert_eq!(view["localStorage"]["only-api"], "1");
        assert_eq!(view["sessionStorage"]["s"], "2");
        assert_eq!(view["indexedDb"][0]["name"], "db");
        assert_eq!(view["origins"].as_array().unwrap().len(), 2);
        assert_eq!(view["updatedAt"], 7);
    }

    #[test]
    fn probe_script_substitutes_placeholders() {
        let script = probe_script(&["https://a.test".to_string()]);
        assert!(!script.contains("__RX_"));
        assert!(script.contains(r#"["https://a.test"]"#));
        assert!(script.contains(&MAX_ENTRIES_PER_ORIGIN.to_string()));
    }

    /// 探针本体是 JS：用引擎自己的 Boa 跑一遍，确保语法正确、能产出可解析的 JSON。
    /// Boa 没有 `localStorage` / `indexedDB` / `location`，正好覆盖「存储不可用」的降级分支。
    #[test]
    fn probe_script_runs_in_boa() {
        let mut context = boa_engine::Context::default();
        let script = format!("var window = globalThis;\n{}", probe_script(&[]));
        context
            .eval(boa_engine::Source::from_bytes(script.as_bytes()))
            .expect("探针应在 Boa 中可执行");
        let value = context
            .eval(boa_engine::Source::from_bytes(JS_PROBE_READ.as_bytes()))
            .expect("读取探针结果");
        // `display()` 给出 JS 字符串的 JSON 字面量，正是宿主从浏览器拿到的形状
        let snapshot = parse_probe_eval(&value.display().to_string()).unwrap();
        assert!(snapshot.is_empty());
    }

    /// 「注入时只定义、点完成时再采集」的探针：注入本身只定义 `window.__rxStorageProbeRun`，
    /// 不采集；调用它才采集（桌面端登录窗口靠这个把采集时机推到用户点「完成」之后）。
    ///
    /// 用占位实现替掉 `window.localStorage`：探针在页面里读的就是这个全局，替掉即可验证
    /// 「调用 → 采集 → `JS_PROBE_READ` 取回结果」的完整链路。
    /// 注意：Boa 的 `window.location` 是只读访问器，不能赋值，所以给的是裸 `location` 全局
    /// —— 探针读的正是裸全局。
    #[test]
    fn probe_run_script_defines_callable_probe() {
        let mut context = boa_engine::Context::default();
        let globals = "var window = globalThis;\n\
             var location = { origin: 'https://a.test', href: 'https://a.test/login' };\n\
             window.localStorage = { length: 1, key: function () { return 'token'; }, getItem: function () { return 'jwt-late'; } };\n";
        context
            .eval(boa_engine::Source::from_bytes(globals.as_bytes()))
            .expect("测试用的全局对象应能建立");
        // 注入本身不产生结果，只是把探针装进页面
        assert_eq!(
            context
                .eval(boa_engine::Source::from_bytes(
                    probe_run_script(&[]).as_bytes()
                ))
                .expect("注入脚本应在 Boa 中可执行")
                .display()
                .to_string(),
            "undefined"
        );
        assert_eq!(
            context
                .eval(boa_engine::Source::from_bytes(
                    b"typeof window.__rxStorageProbeRun"
                ))
                .expect("注入后应有探针函数")
                .display()
                .to_string(),
            "\"function\""
        );
        context
            .eval(boa_engine::Source::from_bytes(
                b"window.__rxStorageProbeRun()",
            ))
            .expect("注入后应能调用探针");
        let value = context
            .eval(boa_engine::Source::from_bytes(JS_PROBE_READ.as_bytes()))
            .expect("读取探针结果");
        let snapshot = parse_probe_eval(&value.display().to_string()).unwrap();
        assert_eq!(snapshot.origins.len(), 1);
        assert_eq!(snapshot.origins[0].origin, "https://a.test");
        assert_eq!(snapshot.origins[0].local_storage[0].key, "token");
        assert_eq!(snapshot.origins[0].local_storage[0].value, "jwt-late");
    }

    /// 重复注入（每次导航都会重新注入）必须原样保留已经装好的探针：
    /// 包裹一层计数再注入第二次，函数若被换掉计数就归零。
    ///
    /// 用独立进程上下文跑：Boa 在同一段求值里连续跑两遍「包装函数」的 IIFE 会抛内部类型错误
    /// （引擎限制，与探针无关），因此这里分成两次 eval。
    #[test]
    fn probe_run_script_keeps_existing_probe() {
        let mut context = boa_engine::Context::default();
        context
            .eval(boa_engine::Source::from_bytes(
                b"var window = globalThis; window.__rxStorageProbeRun = function () { window.__rxCalls = (window.__rxCalls || 0) + 1; };",
            ))
            .expect("放置一个占位探针");
        context
            .eval(boa_engine::Source::from_bytes(
                probe_run_script(&[]).as_bytes(),
            ))
            .expect("重复注入应能执行");
        let calls = context
            .eval(boa_engine::Source::from_bytes(
                b"window.__rxStorageProbeRun(); window.__rxCalls",
            ))
            .expect("调用探针");
        assert_eq!(calls.display().to_string(), "1");
    }
}
