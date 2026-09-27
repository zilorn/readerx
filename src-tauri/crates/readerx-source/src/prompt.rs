//! 书源「用户输入表单」的宿主抽象。
//!
//! 书源 JS 通过 `input.prompt({...})` 让用户填一组值（站点口令、访问码、翻页参数…）：
//! 引擎在工作线程上**阻塞等待**，宿主弹出表单，用户提交 / 取消后调用继续。
//!
//! 与 [`crate::auth`] 是同一套「可插拔后端」结构，核心 crate 不依赖任何 GUI：
//! - App（Tauri）注册的是界面弹层（见 `src-tauri/src/source_prompt.rs`）；
//! - 独立二进制注册的是终端交互读取（见 [`crate::cli::prompt`]）；
//! - 都没注册（浏览器预览 / 未接线的宿主）时返回 `ok:false`，规则照常降级。
//!
//! 两件事只在这里做，保证 App 与 CLI 行为一致：
//! 1. **选项解析与值校验**：JS 传来的表单描述要过白名单与上限，界面回传的值要按字段规范化；
//! 2. **本次运行内的记忆 + 单飞**：同一书源、同一张表单只问一次（用户填过的值在进程内记住），
//!    并发调用（多章并行拉正文）同时命中同一张表单时只弹一次，其余调用直接复用结果。

use serde::{Deserialize, Serialize};
use serde_json::{Map, Number, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;

/// 单张表单最多几个字段
pub const MAX_FIELDS: usize = 12;
/// 表单标题 / 说明的最大字符数（超出截断）
const MAX_TITLE_CHARS: usize = 80;
const MAX_MESSAGE_CHARS: usize = 400;
/// 字段 key 的最大字符数
const MAX_KEY_CHARS: usize = 40;
/// 字段显示名的最大字符数（超出截断）
const MAX_LABEL_CHARS: usize = 60;
/// 字段占位提示的最大字符数（超出截断）
const MAX_PLACEHOLDER_CHARS: usize = 120;
/// 单个值默认的最大字符数
pub const DEFAULT_MAX_LENGTH: usize = 512;
/// 单个值允许声明的最大字符数上限
pub const MAX_LENGTH_LIMIT: usize = 4096;

/// 字段类型：界面据此选输入控件（文本 / 密码 / 数字）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PromptFieldKind {
    Text,
    Password,
    Number,
}

impl PromptFieldKind {
    /// 解析书源写的 `type`（缺省 = 文本；容忍几个常见别名）
    pub fn parse(text: &str) -> Result<Self, String> {
        match text.trim().to_ascii_lowercase().as_str() {
            "" | "text" | "string" => Ok(Self::Text),
            "password" | "secret" | "pwd" => Ok(Self::Password),
            "number" | "int" | "integer" | "float" | "num" => Ok(Self::Number),
            other => Err(format!(
                "不支持的字段类型「{other}」（可用 text / password / number）"
            )),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Text => "text",
            Self::Password => "password",
            Self::Number => "number",
        }
    }
}

/// 表单里的一个字段（字段名与前端 / 事件载荷一一对应）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptField {
    /// 书源代码里取值的 key（`out.values[key]`）
    pub key: String,
    /// 显示名（缺省用 key）
    pub label: String,
    /// 输入控件类型
    #[serde(rename = "type")]
    pub kind: PromptFieldKind,
    /// 占位提示
    #[serde(default)]
    pub placeholder: String,
    /// 预填值
    #[serde(default)]
    pub default_value: String,
    /// 是否必填（留空时界面不允许提交）
    #[serde(default)]
    pub required: bool,
    /// 值上限（字符数）
    pub max_length: usize,
    /// 数字字段的最小值（其它类型忽略）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min: Option<f64>,
    /// 数字字段的最大值（其它类型忽略）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max: Option<f64>,
}

/// 一次表单请求（宿主把它交给后端展示）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptRequest {
    /// 发起表单的书源（界面用来显示来源；同源并发调用靠它区分记忆）
    pub source_id: String,
    /// 表单标题（书源自定；留空由界面用默认文案）
    #[serde(default)]
    pub title: String,
    /// 补充说明（可空）
    #[serde(default)]
    pub message: String,
    /// 字段列表（至少一个）
    pub fields: Vec<PromptField>,
    /// `true` = 跳过本次运行已记住的值，重新询问用户
    #[serde(default)]
    pub fresh: bool,
}

impl PromptRequest {
    /// 本次运行内的记忆键：**同一书源 + 同一标题 + 同一组字段** 视为同一张表单。
    ///
    /// 标题参与其中是有意的：同一个源里两张字段同名但用途不同的表单（如两个站点的口令）
    /// 不该互相顶掉；反过来，把书名 / 关键词拼进标题会让每次调用都变成新表单、每次都弹窗。
    pub fn signature(&self) -> String {
        let fields: Vec<String> = self
            .fields
            .iter()
            .map(|field| format!("{}:{}", field.key, field.kind.as_str()))
            .collect();
        format!(
            "{}|{}|{}",
            self.source_id,
            self.title.trim(),
            fields.join(",")
        )
    }

    /// 字段数 / key 等是否合法（界面展示前先过一遍，避免后端收到畸形请求）
    pub fn is_sane(&self) -> bool {
        !self.fields.is_empty() && self.fields.len() <= MAX_FIELDS
    }

    /// 把界面回传的原始值规范化成给书源的结果。
    ///
    /// - 只认请求里声明过的 key（多余的一律丢弃，避免界面 / 书源对不上时把脏数据交给规则）；
    /// - 文本 / 密码按原样返回（必填判定忽略首尾空白，值本身不裁剪）；
    /// - 数字字段解析成 JSON 数字，留空且非必填时返回 `""`；
    /// - 超出 `maxLength` 的值截断（界面已按 `maxlength` 限制，这里是兜底）。
    pub fn normalize_values(&self, raw: &Map<String, Value>) -> Result<Map<String, Value>, String> {
        let mut out = Map::new();
        for field in &self.fields {
            let value = raw.get(&field.key).cloned().unwrap_or(Value::Null);
            match field.kind {
                PromptFieldKind::Number => {
                    let text = scalar_text(&value);
                    if text.trim().is_empty() {
                        if field.required {
                            return Err(format!("「{}」为必填项", field.label));
                        }
                        out.insert(field.key.clone(), Value::String(String::new()));
                        continue;
                    }
                    let number: f64 = text.trim().parse().map_err(|_| {
                        format!("「{}」需要填数字（收到「{}」）", field.label, text.trim())
                    })?;
                    if !number.is_finite() {
                        return Err(format!("「{}」需要填数字", field.label));
                    }
                    if let Some(min) = field.min {
                        if number < min {
                            return Err(format!("「{}」不能小于 {min}", field.label));
                        }
                    }
                    if let Some(max) = field.max {
                        if number > max {
                            return Err(format!("「{}」不能大于 {max}", field.label));
                        }
                    }
                    // 整数值按整数序列化（`3` 而不是 `3.0`）：书源里 JSON.stringify 出来的
                    // 请求体不至于因为多一个小数点被站点拒掉
                    let value = if number.fract() == 0.0 && number.abs() <= 9_007_199_254_740_992.0 {
                        Value::Number((number as i64).into())
                    } else {
                        Value::Number(
                            Number::from_f64(number)
                                .ok_or_else(|| format!("「{}」的数字超出可表示范围", field.label))?,
                        )
                    };
                    out.insert(field.key.clone(), value);
                }
                PromptFieldKind::Text | PromptFieldKind::Password => {
                    let text = truncate_chars(&scalar_text(&value), field.max_length);
                    if field.required && text.trim().is_empty() {
                        return Err(format!("「{}」为必填项", field.label));
                    }
                    out.insert(field.key.clone(), Value::String(text));
                }
            }
        }
        Ok(out)
    }
}

/// 一次表单的结果（`ok:false` = 用户取消 / 环境不支持 / 超时，都不抛错）
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptOutcome {
    pub ok: bool,
    /// 字段 key → 值（文本 / 密码是字符串，数字是 JSON 数字）
    #[serde(default)]
    pub values: Map<String, Value>,
    /// 失败 / 取消原因（成功时为空）
    #[serde(default)]
    pub message: String,
}

impl PromptOutcome {
    pub fn success(values: Map<String, Value>) -> Self {
        Self {
            ok: true,
            values,
            message: String::new(),
        }
    }

    /// 用户点了取消（或直接关掉了表单）
    pub fn cancelled() -> Self {
        Self {
            ok: false,
            values: Map::new(),
            message: "已取消输入".to_string(),
        }
    }

    /// 环境不支持 / 超时 / 其它失败原因
    pub fn failure(message: impl Into<String>) -> Self {
        Self {
            ok: false,
            values: Map::new(),
            message: message.into(),
        }
    }
}

/// 表单后端：由宿主（App / CLI）实现并注册。
///
/// 实现必须是 `Send + Sync`：引擎在工作线程上调用它，而界面属于主线程。
/// 实现内部负责等待用户（含超时兜底），**不返回 `Err` 表示取消**——取消用 `ok:false`；
/// `Err` 只保留给「后端自身不可用」。
pub trait PromptProvider: Send + Sync {
    /// 当前环境是否能弹表单（无终端 / 界面未就绪时为 false）
    fn supported(&self) -> bool;

    /// 阻塞式展示一次表单并等待用户提交 / 取消
    fn prompt(&self, request: &PromptRequest) -> Result<PromptOutcome, String>;
}

static PROVIDER: OnceLock<Mutex<Option<Arc<dyn PromptProvider>>>> = OnceLock::new();
/// 本次运行内记住的表单值：记忆键 → 值
static CACHE: OnceLock<Mutex<HashMap<String, Map<String, Value>>>> = OnceLock::new();
/// 记忆键 → 串行闸门（同一张表单同时只允许一次真实询问）
static GATES: OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();

fn provider_slot() -> &'static Mutex<Option<Arc<dyn PromptProvider>>> {
    PROVIDER.get_or_init(Default::default)
}

fn cache_slot() -> &'static Mutex<HashMap<String, Map<String, Value>>> {
    CACHE.get_or_init(Default::default)
}

fn gate_slot() -> &'static Mutex<HashMap<String, Arc<Mutex<()>>>> {
    GATES.get_or_init(Default::default)
}

/// 注册表单后端（进程内一次；重复注册覆盖旧的，测试里也靠它换假后端）。
pub fn install_provider(provider: Arc<dyn PromptProvider>) {
    *provider_slot().lock().unwrap_or_else(|e| e.into_inner()) = Some(provider);
}

/// 当前表单后端（未注册返回 None）。
pub fn provider() -> Option<Arc<dyn PromptProvider>> {
    provider_slot()
        .lock()
        .ok()
        .and_then(|guard| guard.clone())
}

/// 当前环境是否能弹表单（宿主已注册后端且它说支持）。
pub fn is_supported() -> bool {
    provider().map(|p| p.supported()).unwrap_or(false)
}

/// 解析书源 JS 传来的选项（`input.prompt(opts)` 的 opts）。
///
/// 出错时返回可读原因，由调用方抛成 JS 异常：这是书源代码写错了，不该静默降级。
pub fn parse_request(source_id: &str, opts: &str) -> Result<PromptRequest, String> {
    let raw = opts.trim();
    let parsed: Value = if raw.is_empty() || raw == "null" {
        Value::Null
    } else {
        serde_json::from_str(raw).map_err(|_| "prompt 参数不是合法 JSON（内部编码错误）".to_string())?
    };
    let object = parsed
        .as_object()
        .ok_or_else(|| "prompt 需要一个选项对象：{ title, message, fields: [...] }".to_string())?;

    let title = truncate_chars(
        object.get("title").map(scalar_text).unwrap_or_default().trim(),
        MAX_TITLE_CHARS,
    );
    let message = truncate_chars(
        object
            .get("message")
            .map(scalar_text)
            .unwrap_or_default()
            .trim(),
        MAX_MESSAGE_CHARS,
    );
    let fresh = object
        .get("fresh")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let fields_raw = object
        .get("fields")
        .and_then(Value::as_array)
        .ok_or_else(|| "prompt 需要 fields 数组（至少一个字段）".to_string())?;
    if fields_raw.is_empty() {
        return Err("prompt 的 fields 不能为空".to_string());
    }
    if fields_raw.len() > MAX_FIELDS {
        return Err(format!(
            "prompt 的字段过多（{} 个，最多 {MAX_FIELDS} 个）",
            fields_raw.len()
        ));
    }

    let mut fields: Vec<PromptField> = Vec::with_capacity(fields_raw.len());
    for (index, item) in fields_raw.iter().enumerate() {
        let field = parse_field(item, index + 1)?;
        if fields.iter().any(|existing| existing.key == field.key) {
            return Err(format!("prompt 的字段 key「{}」重复", field.key));
        }
        fields.push(field);
    }

    Ok(PromptRequest {
        source_id: source_id.to_string(),
        title,
        message,
        fields,
        fresh,
    })
}

fn parse_field(item: &Value, position: usize) -> Result<PromptField, String> {
    let object = item
        .as_object()
        .ok_or_else(|| format!("prompt 的第 {position} 个字段不是对象"))?;
    let key = object
        .get("key")
        .map(scalar_text)
        .unwrap_or_default()
        .trim()
        .to_string();
    if key.is_empty() {
        return Err(format!("prompt 的第 {position} 个字段缺少 key"));
    }
    if key.chars().count() > MAX_KEY_CHARS
        || !key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.')
    {
        return Err(format!(
            "prompt 的字段 key「{key}」非法（只用字母、数字、_ - . ，最多 {MAX_KEY_CHARS} 字符）"
        ));
    }
    let label = {
        let raw = object.get("label").map(scalar_text).unwrap_or_default();
        let text = truncate_chars(raw.trim(), MAX_LABEL_CHARS);
        if text.is_empty() {
            key.clone()
        } else {
            text
        }
    };
    let kind = PromptFieldKind::parse(&object.get("type").map(scalar_text).unwrap_or_default())?;
    let placeholder = truncate_chars(
        object
            .get("placeholder")
            .map(scalar_text)
            .unwrap_or_default()
            .trim(),
        MAX_PLACEHOLDER_CHARS,
    );
    // `defaultValue` 是文档口径；`default` / `value` 是常见手滑，一起认
    let default_value = ["defaultValue", "default", "value"]
        .iter()
        .find_map(|name| object.get(*name).map(scalar_text))
        .unwrap_or_default();
    let required = object
        .get("required")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let max_length = object
        .get("maxLength")
        .and_then(Value::as_f64)
        .filter(|value| *value >= 1.0)
        .map(|value| (value as usize).min(MAX_LENGTH_LIMIT))
        .unwrap_or(DEFAULT_MAX_LENGTH);
    let min = number_option(object.get("min"))?;
    let max = number_option(object.get("max"))?;
    if let (Some(min), Some(max)) = (min, max) {
        if min > max {
            return Err(format!("prompt 的字段「{key}」min 大于 max"));
        }
    }

    Ok(PromptField {
        key,
        label,
        kind,
        placeholder,
        default_value: truncate_chars(&default_value, max_length),
        required,
        max_length,
        min,
        max,
    })
}

/// 表单的取值：命中记忆直接返回（不弹窗），否则交给后端并记住结果。
///
/// 同一张表单（同书源 + 同标题 + 同字段）在本次运行内**只问一次**：
/// - 并发调用同时到达时，后到的会等在闸门上，等第一个问完直接用同一份值（多章并行拉正文常见）；
/// - `fresh: true` 跳过记忆与复用，重新询问用户，并把新值写回记忆。
pub fn ask(request: &PromptRequest) -> Result<PromptOutcome, String> {
    ask_with(provider(), request)
}

/// [`ask`] 的实现：后端作为参数传入，便于测试覆盖「没有后端 / 后端说不支持」两条分支。
fn ask_with(
    provider: Option<Arc<dyn PromptProvider>>,
    request: &PromptRequest,
) -> Result<PromptOutcome, String> {
    if !request.is_sane() {
        return Err("prompt 请求的字段不合法".to_string());
    }
    let signature = request.signature();
    if !request.fresh {
        if let Some(values) = cached(&signature) {
            log::debug!(
                "用户输入表单复用本次运行记住的值 source={} fields={}",
                request.source_id,
                request.fields.len()
            );
            return Ok(PromptOutcome::success(values));
        }
    }
    let Some(provider) = provider else {
        return Ok(PromptOutcome::failure(
            "当前环境不支持用户输入表单（没有界面 / 终端可用）",
        ));
    };
    if !provider.supported() {
        return Ok(PromptOutcome::failure(
            "当前环境不支持用户输入表单（没有界面 / 终端可用）",
        ));
    }

    // 单飞：同一张表单串行询问，后来者在这里等第一个的结果
    let gate = gate_for(&signature);
    let _guard = gate.lock().unwrap_or_else(|e| e.into_inner());
    if !request.fresh {
        if let Some(values) = cached(&signature) {
            return Ok(PromptOutcome::success(values));
        }
    }

    let started = Instant::now();
    // 只记字段数与耗时：用户填的内容（口令之类）绝不进日志
    log::info!(
        "用户输入表单开始 source={} fields={} fresh={}",
        request.source_id,
        request.fields.len(),
        request.fresh
    );
    let outcome = provider.prompt(request);
    match outcome {
        Ok(mut outcome) => {
            if outcome.ok {
                match request.normalize_values(&outcome.values) {
                    Ok(values) => {
                        outcome.values = values;
                        cache_put(&signature, outcome.values.clone());
                    }
                    Err(reason) => {
                        // 界面已做同样的校验，走到这里说明后端回传的值与字段对不上
                        log::warn!(
                            "用户输入表单的值不合法 source={} reason={reason}",
                            request.source_id
                        );
                        outcome = PromptOutcome::failure(format!("输入的值不合法：{reason}"));
                    }
                }
            }
            log::info!(
                "用户输入表单结束 source={} ok={} ms={} reason={}",
                request.source_id,
                outcome.ok,
                started.elapsed().as_millis(),
                if outcome.message.trim().is_empty() {
                    "（无）"
                } else {
                    outcome.message.trim()
                }
            );
            Ok(outcome)
        }
        Err(err) => {
            log::error!(
                "用户输入表单后端异常 source={} ms={} reason={}",
                request.source_id,
                started.elapsed().as_millis(),
                err
            );
            Err(err)
        }
    }
}

/// 忘掉某个书源记住的全部表单值（清除登录态 / 删除书源时调用）。
pub fn forget(source_id: &str) {
    let prefix = format!("{source_id}|");
    let mut cache = cache_slot().lock().unwrap_or_else(|e| e.into_inner());
    let before = cache.len();
    cache.retain(|signature, _| !signature.starts_with(&prefix));
    if cache.len() != before {
        log::debug!(
            "已清除该书源记住的表单值 source={source_id} 条数={}",
            before - cache.len()
        );
    }
}

fn cached(signature: &str) -> Option<Map<String, Value>> {
    cache_slot()
        .lock()
        .ok()
        .and_then(|cache| cache.get(signature).cloned())
}

fn cache_put(signature: &str, values: Map<String, Value>) {
    if let Ok(mut cache) = cache_slot().lock() {
        cache.insert(signature.to_string(), values);
    }
}

fn gate_for(signature: &str) -> Arc<Mutex<()>> {
    let mut gates = gate_slot().lock().unwrap_or_else(|e| e.into_inner());
    gates
        .entry(signature.to_string())
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone()
}

/// 值 → 文本：字符串原样，数字 / 布尔转文本，其它（对象 / 数组 / null）当空。
///
/// 书源里 `placeholder: title` 之类的写法很常见，这里保持宽容；真正的类型约束靠字段声明。
fn scalar_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Number(number) => number.to_string(),
        Value::Bool(flag) => flag.to_string(),
        _ => String::new(),
    }
}

fn number_option(value: Option<&Value>) -> Result<Option<f64>, String> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(number)) => Ok(number.as_f64()),
        Some(Value::String(text)) if text.trim().is_empty() => Ok(None),
        Some(Value::String(text)) => text
            .trim()
            .parse::<f64>()
            .map(Some)
            .map_err(|_| format!("prompt 的字段阈值「{text}」不是数字")),
        Some(_) => Err("prompt 的字段阈值必须是数字".to_string()),
    }
}

fn truncate_chars(text: &str, max: usize) -> String {
    if max == 0 || text.chars().count() <= max {
        return text.to_string();
    }
    text.chars().take(max).collect()
}

// ---------------------------------------------------------------------------
// 测试用的假后端（prompt / engine 两处的测试共用同一份，避免相互覆盖全局后端）
// ---------------------------------------------------------------------------

#[cfg(test)]
pub(crate) mod fake {
    use super::*;

    /// 假后端：按字段生成值（预填值优先，否则 `<key>-value`），并统计调用次数。
    ///
    /// 预填值写 `__cancel__` 的字段表示「用户取消了这张表单」——引擎侧的测试靠它覆盖
    /// `ok:false` 分支，不必真的去驱动界面。
    ///
    /// 全局后端只有一个，测试并行跑：所以行为必须**由请求决定**，计数按书源分开，
    /// 断言只看自己那个书源。
    #[derive(Default)]
    pub struct FakeProvider {
        calls: Mutex<HashMap<String, usize>>,
    }

    impl FakeProvider {
        /// 安装（幂等：重复安装同一个实例，不重置计数）
        pub fn install() -> Arc<Self> {
            static INSTANCE: OnceLock<Arc<FakeProvider>> = OnceLock::new();
            let provider = INSTANCE
                .get_or_init(|| Arc::new(FakeProvider::default()))
                .clone();
            install_provider(provider.clone());
            provider
        }

        /// 某个书源被真正询问过几次
        pub fn calls(&self, source_id: &str) -> usize {
            self.calls
                .lock()
                .ok()
                .and_then(|calls| calls.get(source_id).copied())
                .unwrap_or(0)
        }
    }

    impl PromptProvider for FakeProvider {
        fn supported(&self) -> bool {
            true
        }

        fn prompt(&self, request: &PromptRequest) -> Result<PromptOutcome, String> {
            if let Ok(mut calls) = self.calls.lock() {
                *calls.entry(request.source_id.clone()).or_insert(0) += 1;
            }
            if request
                .fields
                .iter()
                .any(|field| field.default_value == "__cancel__")
            {
                return Ok(PromptOutcome::cancelled());
            }
            let mut values = Map::new();
            for field in &request.fields {
                let value = if field.default_value.is_empty() {
                    format!("{}-value", field.key)
                } else {
                    field.default_value.clone()
                };
                values.insert(field.key.clone(), Value::String(value));
            }
            Ok(PromptOutcome::success(values))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn values(pairs: &[(&str, Value)]) -> Map<String, Value> {
        pairs
            .iter()
            .map(|(key, value)| (key.to_string(), value.clone()))
            .collect()
    }

    #[test]
    fn parse_request_fills_defaults_and_limits() {
        let opts = r#"{
            "title": "  站点口令  ",
            "message": "需要口令才能搜索",
            "fresh": true,
            "fields": [
                { "key": "pwd", "label": "  ", "type": "password", "required": true },
                { "key": "rps", "type": "number", "min": 1, "max": 8, "defaultValue": 3, "maxLength": 99999 }
            ]
        }"#;
        let request = parse_request("src-1", opts).expect("合法选项应能解析");
        assert_eq!(request.title, "站点口令");
        assert!(request.fresh);
        assert_eq!(request.fields.len(), 2);
        // label 留空回落到 key；类型缺省是文本；超上限的 maxLength 收敛到硬上限
        assert_eq!(request.fields[0].label, "pwd");
        assert_eq!(request.fields[0].kind, PromptFieldKind::Password);
        assert!(request.fields[0].required);
        assert_eq!(request.fields[1].kind, PromptFieldKind::Number);
        assert_eq!(request.fields[1].default_value, "3");
        assert_eq!(request.fields[1].max_length, MAX_LENGTH_LIMIT);
        assert_eq!(request.fields[1].min, Some(1.0));
    }

    #[test]
    fn parse_request_rejects_bad_shapes() {
        // 没有 fields / 空数组 / 非对象
        assert!(parse_request("src-1", "null").is_err());
        assert!(parse_request("src-1", r#"{"fields":[]}"#).is_err());
        assert!(parse_request("src-1", r#"{"fields":[{}]}"#).is_err());
        // 非法 key（空格）/ 重复 key / 未知类型 / min > max
        assert!(parse_request("src-1", r#"{"fields":[{"key":"a b"}]}"#).is_err());
        assert!(parse_request("src-1", r#"{"fields":[{"key":"a"},{"key":"a"}]}"#).is_err());
        assert!(parse_request("src-1", r#"{"fields":[{"key":"a","type":"file"}]}"#).is_err());
        assert!(
            parse_request("src-1", r#"{"fields":[{"key":"a","type":"number","min":9,"max":1}]}"#)
                .is_err()
        );
        // 字段过多
        let many: Vec<String> = (0..MAX_FIELDS + 1)
            .map(|index| format!(r#"{{"key":"k{index}"}}"#))
            .collect();
        let opts = format!(r#"{{"fields":[{}]}}"#, many.join(","));
        assert!(parse_request("src-1", &opts).is_err());
    }

    #[test]
    fn normalize_values_checks_required_numbers_and_unknown_keys() {
        let request = parse_request(
            "src-1",
            r#"{"fields":[
                {"key":"pwd","label":"口令","type":"password","required":true,"maxLength":4},
                {"key":"rps","label":"并发","type":"number","min":1,"max":8},
                {"key":"note","label":"备注"}
            ]}"#,
        )
        .unwrap();

        // 正常路径：密码截断、数字转成 JSON 数字、未填的文本字段是空串
        let out = request
            .normalize_values(&values(&[
                ("pwd", Value::String("123456".into())),
                ("rps", Value::String("3".into())),
            ]))
            .expect("应通过校验");
        assert_eq!(out["pwd"], Value::String("1234".into()));
        assert_eq!(out["rps"], Value::Number(3.into()));
        assert_eq!(out["note"], Value::String(String::new()));

        // 必填留空 / 数字非法 / 数字越界都要给出可读原因
        let missing = request
            .normalize_values(&values(&[("pwd", Value::String("  ".into()))]))
            .unwrap_err();
        assert!(missing.contains("必填"), "{missing}");
        let bad = request
            .normalize_values(&values(&[
                ("pwd", Value::String("x".into())),
                ("rps", Value::String("abc".into())),
            ]))
            .unwrap_err();
        assert!(bad.contains("需要填数字"), "{bad}");
        let range = request
            .normalize_values(&values(&[
                ("pwd", Value::String("x".into())),
                ("rps", Value::String("99".into())),
            ]))
            .unwrap_err();
        assert!(range.contains("不能大于"), "{range}");

        // 请求里没声明的 key 一律丢弃（界面 / 书源对不上时不把脏数据交给规则）
        let extra = request
            .normalize_values(&values(&[
                ("pwd", Value::String("ok".into())),
                ("evil", Value::String("x".into())),
            ]))
            .unwrap();
        assert!(!extra.contains_key("evil"));
    }

    /// 记忆与单飞：同一张表单只问一次；`fresh` 重新问；值按字段类型规范化。
    #[test]
    fn ask_remembers_values_and_honours_fresh() {
        let provider = fake::FakeProvider::install();
        let source_id = format!("prompt-cache-{}", std::process::id());
        let opts = r#"{"title":"站点口令","fields":[
            {"key":"pwd","type":"password","defaultValue":"s3cret"},
            {"key":"rps","type":"number","defaultValue":"2"}
        ]}"#;
        let fresh_opts = opts.replace("\"title\":\"站点口令\"", "\"fresh\":true,\"title\":\"站点口令\"");

        let before = provider.calls(&source_id);
        let request = parse_request(&source_id, opts).unwrap();
        let first = ask(&request).expect("第一次应成功");
        assert!(first.ok, "{}", first.message);
        assert_eq!(first.values["pwd"], Value::String("s3cret".into()));
        assert_eq!(first.values["rps"], Value::Number(2.into()));
        assert_eq!(provider.calls(&source_id), before + 1);

        // 第二次（新请求对象，等价选项）：命中记忆，不再问用户
        let again = ask(&parse_request(&source_id, opts).unwrap()).unwrap();
        assert_eq!(again.values, first.values);
        assert_eq!(provider.calls(&source_id), before + 1);

        // fresh:true 重新问
        let fresh = ask(&parse_request(&source_id, &fresh_opts).unwrap())
            .expect("fresh 应重新询问");
        assert!(fresh.ok);
        assert_eq!(provider.calls(&source_id), before + 2);

        // 换标题 = 另一张表单：各自记各自的
        let other = ask(
            &parse_request(
                &source_id,
                r#"{"title":"另一张","fields":[{"key":"pwd","type":"password"}]}"#,
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(other.values["pwd"], Value::String("pwd-value".into()));
        assert_eq!(provider.calls(&source_id), before + 3);

        // 清除记忆后重新问
        forget(&source_id);
        let _ = ask(&parse_request(&source_id, opts).unwrap()).unwrap();
        assert_eq!(provider.calls(&source_id), before + 4);
    }

    /// 没有后端 / 后端说不支持时返回 `ok:false`（带可读原因），不抛错、不缓存。
    #[test]
    fn ask_without_provider_degrades() {
        let request = parse_request(
            "prompt-noprovider",
            r#"{"fields":[{"key":"a","required":true}]}"#,
        )
        .unwrap();

        let missing = ask_with(None, &request).expect("没有后端不是异常");
        assert!(!missing.ok);
        assert!(missing.values.is_empty());
        assert!(missing.message.contains("不支持"), "{}", missing.message);

        struct Unsupported;
        impl PromptProvider for Unsupported {
            fn supported(&self) -> bool {
                false
            }
            fn prompt(&self, _request: &PromptRequest) -> Result<PromptOutcome, String> {
                panic!("不支持时不该真的弹表单");
            }
        }
        let unsupported = ask_with(Some(Arc::new(Unsupported)), &request).unwrap();
        assert!(!unsupported.ok);
        assert!(unsupported.message.contains("不支持"), "{}", unsupported.message);

        // 取消同样是 ok:false，且不带值
        assert!(!PromptOutcome::cancelled().ok);
        assert!(PromptOutcome::cancelled().values.is_empty());
    }

    /// 签名只跟「书源 + 标题 + 字段」有关：字段顺序不同 = 不同表单，类型不同也是。
    #[test]
    fn signature_tracks_form_identity() {
        let a = parse_request("src-1", r#"{"title":"t","fields":[{"key":"a"},{"key":"b"}]}"#)
            .unwrap();
        let b = parse_request("src-1", r#"{"title":"t","fields":[{"key":"b"},{"key":"a"}]}"#)
            .unwrap();
        let c = parse_request(
            "src-1",
            r#"{"title":"t","fields":[{"key":"a"},{"key":"b","type":"number"}]}"#,
        )
        .unwrap();
        assert_ne!(a.signature(), b.signature());
        assert_ne!(a.signature(), c.signature());
        // 同一个源的另一张表单（标题不同）也不该串
        let d = parse_request("src-1", r#"{"title":"t2","fields":[{"key":"a"},{"key":"b"}]}"#)
            .unwrap();
        assert_ne!(a.signature(), d.signature());
    }
}
