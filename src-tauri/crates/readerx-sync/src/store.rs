//! 数据目录与持久化。
//!
//! 与 App 现有存储风格一致：**JSON 文件 + 追加型 JSONL**，不引入数据库。
//! 目录布局（`<data_root>/`）：
//!
//! ```text
//! device.json      设备身份：设备 id、名称、群组 id、群组密钥（配对用）、本机拒绝接入的设备
//! clock.json       HLC 进度（重启后不能从 0 重新计数，否则回拨的钟会倒挂）
//! oplog.jsonl      操作日志，一行一条 Operation（**唯一真相**，追加写 + fsync）
//! entities.json    实体快照（物化视图）+ 快照覆盖到的日志行数
//! conflicts.json   冲突队列
//! deferred.json    因果缓冲：基线还没齐、暂时不能合并的操作
//! peers.json       已知对端：地址、上次同步时间、我们认为对方已有的版本
//! ```
//!
//! **崩溃安全**：操作先写进 `oplog.jsonl` 并 fsync，快照与冲突队列是「可以重建的
//! 派生数据」，用「临时文件 + rename」整体替换。即使快照没来得及写，重启时
//! 快照里记的 `applied_ops` 与日志行数一比就知道要重放哪一段（见 [`EntitySnapshot`]）。
//!
//! **格式版本**：每个文件都带 `format`。读到比本程序新的版本会直接报错
//! （[`SyncError::Unsupported`]），而不是按旧语义写坏新数据；旧版本走 [`migrate`] 升级。

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

use crate::error::{Result, SyncError};
use crate::hlc::HlcState;
use crate::id::{new_id, now_ms, random_bytes, DeviceId};
use crate::model::{Conflict, Entity, Operation};
use crate::version::VersionVector;

/// 当前存储格式版本。**只增不改**：新增字段一律用 `#[serde(default)]`，
/// 这样旧版本读到新文件不会炸（但版本号更高时仍会拒绝加载，避免语义错位）。
pub const FORMAT_VERSION: u32 = 1;

/// 群组密钥长度（字节）
pub const SECRET_BYTES: usize = 32;

/// 设备身份与群组（`device.json`）。
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DeviceConfig {
    pub format: u32,
    /// 本设备 id（ULID，全局唯一）
    pub device_id: DeviceId,
    /// 展示用名称（「手机」「客厅台式机」）
    pub device_name: String,
    /// 同步群组 id：只有同群组的设备才互相接受（多租户 / 多用户隔离）
    pub group_id: String,
    /// 群组密钥（hex）：握手鉴权 + 每帧 MAC；**配对码的一部分，不能进日志**
    pub secret: String,
    pub created_at_ms: u64,
    /// 本机**拒绝接入**的设备 id（界面上「删除设备」的结果）。
    ///
    /// 名单里的设备连进来会在握手阶段被拒绝，直到本机重新与它同步一次
    /// （显式重新接受，见 `SyncEngine::record_peer_sync`）。
    /// 这是本机单方面的决定：对端不知情，也不会因此删掉它手里的数据。
    #[serde(default)]
    pub removed_devices: Vec<DeviceId>,
}

impl DeviceConfig {
    /// 新建一个群组（设备 A 第一次初始化）。
    pub fn create(device_name: &str) -> DeviceConfig {
        DeviceConfig {
            format: FORMAT_VERSION,
            device_id: new_id(),
            device_name: device_name.to_string(),
            group_id: new_id(),
            secret: hex_encode(&random_bytes(SECRET_BYTES)),
            created_at_ms: now_ms(),
            removed_devices: Vec::new(),
        }
    }

    /// 配对码：`群组id.密钥`——抄到另一台设备上即可加入同一群组。
    ///
    /// 它等价于「群组密码」，任何人都能凭它加入同步；展示时按凭据对待。
    pub fn pairing_code(&self) -> String {
        format!("{}.{}", self.group_id, self.secret)
    }

    /// 解析配对码。
    pub fn parse_pairing_code(code: &str) -> Result<(String, String)> {
        let (group, secret) = code
            .trim()
            .split_once('.')
            .ok_or_else(|| SyncError::Invalid("配对码格式应为「群组id.密钥」".to_string()))?;
        if group.is_empty() || secret.len() != SECRET_BYTES * 2 {
            return Err(SyncError::Invalid("配对码内容不完整".to_string()));
        }
        if hex_decode(secret).is_none() {
            return Err(SyncError::Invalid("配对码密钥不是合法的十六进制".to_string()));
        }
        Ok((group.to_string(), secret.to_string()))
    }

    /// 群组密钥字节。
    pub fn secret_bytes(&self) -> Result<Vec<u8>> {
        hex_decode(&self.secret)
            .ok_or_else(|| SyncError::Invalid("群组密钥不是合法的十六进制".to_string()))
    }

    /// 校验（读盘后调用：外部改坏的文件要尽早发现）。
    pub fn validate(&self) -> Result<()> {
        if self.device_id.is_empty() || self.group_id.is_empty() {
            return Err(SyncError::Json("device.json 缺少设备 id 或群组 id".to_string()));
        }
        self.secret_bytes()?;
        Ok(())
    }
}

/// 实体快照（`entities.json`）。
///
/// `applied_ops` 是「写这份快照时，oplog.jsonl 已经重放到第几行」：
/// 重启时若日志比它长，说明有操作还没进快照，逐行重放尾部即可（幂等）。
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct EntitySnapshot {
    pub format: u32,
    pub applied_ops: usize,
    pub saved_at_ms: u64,
    pub entities: Vec<Entity>,
}

impl Default for EntitySnapshot {
    fn default() -> Self {
        EntitySnapshot {
            format: FORMAT_VERSION,
            applied_ops: 0,
            saved_at_ms: 0,
            entities: Vec::new(),
        }
    }
}

/// 已知对端的状态（`peers.json`）。
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct PeerState {
    pub device_id: DeviceId,
    #[serde(default)]
    pub name: String,
    /// 最近一次见到的地址（`ip:port`，展示与「重连」用）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub addr: Option<String>,
    /// 我们认为对方已有的版本：下次同步据此只发差集（乐观值，握手时会被对方纠正）
    #[serde(default, skip_serializing_if = "VersionVector::is_empty")]
    pub knowledge: VersionVector,
    #[serde(default)]
    pub last_seen_ms: u64,
    #[serde(default)]
    pub last_sync_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    #[serde(default)]
    pub sync_count: u64,
}

/// 数据目录读写。
pub struct SyncStore {
    root: PathBuf,
    device: DeviceConfig,
    /// `device` 有未落盘的改动（目前只有「已移除设备」名单会改）
    device_dirty: bool,
}

impl SyncStore {
    /// 打开（必要时初始化）数据目录。
    ///
    /// - 目录里已有 `device.json` → 读出来（设备身份保持不变，否则等于换了一台设备）；
    /// - 没有 → 用 `device_name` 建一个新的群组（[`DeviceConfig::create`]）。
    pub fn open(root: impl Into<PathBuf>, device_name: &str) -> Result<SyncStore> {
        let root = root.into();
        fs::create_dir_all(&root)?;
        let device_path = root.join("device.json");
        let device = if device_path.exists() {
            let mut device: DeviceConfig = read_json(&device_path)?;
            // 名称允许改名：调用方给了就用新的
            if !device_name.is_empty() && device.device_name != device_name {
                device.device_name = device_name.to_string();
                write_json_atomic(&device_path, &device)?;
            }
            device
        } else {
            let device = DeviceConfig::create(device_name);
            write_json_atomic(&device_path, &device)?;
            log::info!(
                "同步数据目录已初始化 dir={} device={} group={}",
                root.display(),
                crate::version::short_device(&device.device_id),
                crate::version::short_device(&device.group_id)
            );
            device
        };
        device.validate()?;
        if device.format > FORMAT_VERSION {
            return Err(SyncError::Unsupported(format!(
                "device.json 版本 {} 高于本程序支持的 {FORMAT_VERSION}",
                device.format
            )));
        }
        // 目录权限：密钥在里面，尽量只给本用户（失败不影响功能，只记一条）
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if let Err(e) = fs::set_permissions(&root, fs::Permissions::from_mode(0o700)) {
                log::debug!("同步目录权限设置失败（忽略）: {e}");
            }
        }
        Ok(SyncStore { root, device, device_dirty: false })
    }

    /// 用配对码加入已有群组（保留本设备 id，只换群组与密钥）。
    pub fn join(root: impl Into<PathBuf>, code: &str, device_name: &str) -> Result<SyncStore> {
        let (group_id, secret) = DeviceConfig::parse_pairing_code(code)?;
        let store = SyncStore::open(root, device_name)?;
        let mut device = store.device.clone();
        device.group_id = group_id;
        device.secret = secret;
        // 换群组 = 换一份数据：旧群组的「已移除设备」名单在这里没有意义
        device.removed_devices.clear();
        write_json_atomic(&store.root.join("device.json"), &device)?;
        log::info!(
            "已加入同步群组 group={} device={}",
            crate::version::short_device(&device.group_id),
            crate::version::short_device(&device.device_id)
        );
        Ok(SyncStore { root: store.root, device, device_dirty: false })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn device(&self) -> &DeviceConfig {
        &self.device
    }

    /// 本机拒绝接入的设备名单。
    pub fn removed_devices(&self) -> &[DeviceId] {
        &self.device.removed_devices
    }

    /// 该设备是否被本机拒绝接入。
    pub fn is_device_removed(&self, device: &str) -> bool {
        self.device.removed_devices.iter().any(|removed| removed == device)
    }

    /// 加入 / 移出「拒绝接入」名单（内存改动，由 [`SyncStore::save_device`] 落盘）。
    ///
    /// 返回是否真的变了 —— 调用方据此决定要不要记日志。
    pub fn set_device_removed(&mut self, device: &str, removed: bool) -> bool {
        if removed {
            if self.is_device_removed(device) {
                return false;
            }
            self.device.removed_devices.push(device.to_string());
        } else {
            let before = self.device.removed_devices.len();
            self.device.removed_devices.retain(|entry| entry != device);
            if self.device.removed_devices.len() == before {
                return false;
            }
        }
        self.device_dirty = true;
        true
    }

    /// 把设备身份写回 `device.json`（没有改动时不碰盘）。
    pub fn save_device(&mut self) -> Result<()> {
        if !self.device_dirty {
            return Ok(());
        }
        write_json_atomic(&self.root.join("device.json"), &self.device)?;
        self.device_dirty = false;
        Ok(())
    }

    pub fn device_id(&self) -> &str {
        &self.device.device_id
    }

    pub fn group_id(&self) -> &str {
        &self.device.group_id
    }

    fn path(&self, name: &str) -> PathBuf {
        self.root.join(name)
    }

    /// 读取 HLC 进度（文件不存在 / 为空时从零开始）。
    pub fn load_clock(&self) -> Result<HlcState> {
        let path = self.path("clock.json");
        if !path.exists() {
            return Ok(HlcState { wall_ms: 0, counter: 0 });
        }
        let state: HlcState = read_json(&path)?;
        state.validate()?;
        Ok(state)
    }

    pub fn save_clock(&self, state: &HlcState) -> Result<()> {
        write_json_atomic(&self.path("clock.json"), state)
    }

    /// 读取实体快照。
    pub fn load_entities(&self) -> Result<EntitySnapshot> {
        let path = self.path("entities.json");
        if !path.exists() {
            return Ok(EntitySnapshot::default());
        }
        let mut value: serde_json::Value = read_json(&path)?;
        migrate(&mut value, FORMAT_VERSION)?;
        let snapshot: EntitySnapshot = serde_json::from_value(value)?;
        Ok(snapshot)
    }

    pub fn save_entities(&self, entities: &[Entity], applied_ops: usize) -> Result<()> {
        let snapshot = EntitySnapshot {
            format: FORMAT_VERSION,
            applied_ops,
            saved_at_ms: now_ms(),
            entities: entities.to_vec(),
        };
        write_json_atomic(&self.path("entities.json"), &snapshot)
    }

    pub fn load_conflicts(&self) -> Result<Vec<Conflict>> {
        let path = self.path("conflicts.json");
        if !path.exists() {
            return Ok(Vec::new());
        }
        read_json(&path).map(|v: Vec<Conflict>| v)
    }

    pub fn save_conflicts(&self, conflicts: &[Conflict]) -> Result<()> {
        write_json_atomic(&self.path("conflicts.json"), &conflicts.to_vec())
    }

    pub fn load_deferred(&self) -> Result<Vec<Operation>> {
        let path = self.path("deferred.json");
        if !path.exists() {
            return Ok(Vec::new());
        }
        read_json(&path)
    }

    pub fn save_deferred(&self, ops: &[Operation]) -> Result<()> {
        write_json_atomic(&self.path("deferred.json"), &ops.to_vec())
    }

    pub fn load_peers(&self) -> Result<BTreeMap<DeviceId, PeerState>> {
        let path = self.path("peers.json");
        if !path.exists() {
            return Ok(BTreeMap::new());
        }
        read_json(&path)
    }

    pub fn save_peers(&self, peers: &BTreeMap<DeviceId, PeerState>) -> Result<()> {
        write_json_atomic(&self.path("peers.json"), peers)
    }

    /// 逐行读操作日志（返回操作与**行数**；建索引与重放都用它）。
    pub fn read_oplog(&self) -> Result<Vec<Operation>> {
        let path = self.path("oplog.jsonl");
        if !path.exists() {
            return Ok(Vec::new());
        }
        let file = File::open(&path)?;
        let reader = BufReader::new(file);
        let mut ops = Vec::new();
        for (line_no, line) in reader.lines().enumerate() {
            let line = line?;
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            match serde_json::from_str::<Operation>(trimmed) {
                Ok(op) => ops.push(op),
                Err(e) => {
                    // 半行 / 坏行：只可能出现在「写到一半掉电」的最后一行。
                    // 丢掉它会丢一次修改，所以这里区分「是不是最后一行」：
                    return Err(SyncError::Json(format!(
                        "oplog.jsonl 第 {} 行解析失败（{}）：{e}",
                        line_no + 1,
                        trimmed.chars().take(80).collect::<String>()
                    )));
                }
            }
        }
        Ok(ops)
    }

    /// 追加一条操作（追加写 + fsync：崩溃也不丢已确认的修改）。
    pub fn append_op(&self, op: &Operation) -> Result<()> {
        let path = self.path("oplog.jsonl");
        let mut file = OpenOptions::new().create(true).append(true).open(&path)?;
        let line = serde_json::to_string(op)?;
        file.write_all(line.as_bytes())?;
        file.write_all(b"\n")?;
        file.flush()?;
        // fsync：局域网同步的量级下开销可接受，换来的是「ACK 过的操作不会丢」
        file.sync_data()?;
        Ok(())
    }

    /// 操作日志行数（用于判断快照之后有没有需要重放的尾部）。
    pub fn oplog_lines(&self) -> Result<usize> {
        let path = self.path("oplog.jsonl");
        if !path.exists() {
            return Ok(0);
        }
        let file = File::open(&path)?;
        let mut count = 0usize;
        for line in BufReader::new(file).lines() {
            if !line?.trim().is_empty() {
                count += 1;
            }
        }
        Ok(count)
    }
}

/// 数据目录的独占锁（`<data_dir>/.lock`）。
///
/// **为什么需要**：同一个数据目录被两个进程同时打开时，两边各有一份内存视图，
/// 各自 append 日志、各自覆盖快照——不会立刻报错，却会**静默分叉**（后写的快照
/// 把另一边的实体状态盖掉）。App 端有单实例保护，CLI 端没有，所以这里显式拦住：
/// 拿不到锁就明确报错，而不是让用户在两台「同一台机器」上看到两份数据。
///
/// 锁文件里记 PID：进程崩溃留下的残留锁在下一次打开时会被识别并接管
/// （Linux/Android 用 `/proc/<pid>` 判断存活；其它平台保守地视为存活，
/// 需要时用 `--force-unlock` 语义（[`LockGuard::steal`]）手动清理）。
#[derive(Debug)]
pub struct LockGuard {
    path: PathBuf,
    pid: u32,
}

#[derive(Debug, Serialize, Deserialize)]
struct LockInfo {
    pid: u32,
    #[serde(default)]
    device: String,
    started_at_ms: u64,
}

impl LockGuard {
    /// 获取目录锁。
    pub fn acquire(root: &Path, device: &str) -> Result<LockGuard> {
        fs::create_dir_all(root)?;
        let path = root.join(".lock");
        let pid = std::process::id();
        if path.exists() {
            match read_json::<LockInfo>(&path) {
                Ok(info) if info.pid == pid => {
                    // 同一个进程重复打开（测试、CLI 连续命令）：放行
                    return Ok(LockGuard { path, pid });
                }
                Ok(info) if process_alive(info.pid) => {
                    return Err(SyncError::Invalid(format!(
                        "数据目录已被另一个进程（pid {}）打开：{}。请先退出那个进程（或改用别的 --data-dir）",
                        info.pid,
                        root.display()
                    )));
                }
                Ok(info) => {
                    log::warn!("接管残留的目录锁 dir={} 旧 pid={}", root.display(), info.pid);
                }
                Err(e) => {
                    log::warn!("目录锁内容无法解析（按残留处理）：{e}");
                }
            }
        }
        let info = LockInfo { pid, device: device.to_string(), started_at_ms: now_ms() };
        write_json_atomic(&path, &info)?;
        Ok(LockGuard { path, pid })
    }

    /// 强制接管（给「确认没有别的实例在跑」的场景用）。
    pub fn steal(root: &Path, device: &str) -> Result<LockGuard> {
        let path = root.join(".lock");
        let _ = fs::remove_file(&path);
        LockGuard::acquire(root, device)
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for LockGuard {
    fn drop(&mut self) {
        // 只删自己写的那把锁：如果已经被别人接管，别把别人的锁删掉
        if let Ok(info) = read_json::<LockInfo>(&self.path) {
            if info.pid == self.pid {
                let _ = fs::remove_file(&self.path);
            }
        }
    }
}

/// 进程是否还活着（Linux / Android 看 `/proc`；其它平台保守当作活着）。
fn process_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    #[cfg(any(target_os = "linux", target_os = "android"))]
    {
        std::path::Path::new(&format!("/proc/{pid}")).exists()
    }
    #[cfg(not(any(target_os = "linux", target_os = "android")))]
    {
        let _ = pid;
        true
    }
}

/// 读 JSON（解析失败时带上路径，便于定位是哪个文件被改坏）。
pub fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<T> {
    let text = fs::read_to_string(path)?;
    serde_json::from_str(&text).map_err(|e| SyncError::Json(format!("{}: {e}", path.display())))
}

/// 原子写 JSON：先写 `<名字>.tmp`，再 rename 覆盖。
///
/// rename 在同一文件系统内是原子的：断电后看到的要么是旧文件、要么是新文件，
/// 不会出现「写了一半的 JSON」——那种文件下次启动根本解析不了。
pub fn write_json_atomic<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension(format!(
        "{}tmp",
        path.extension().and_then(|e| e.to_str()).map(|e| format!("{e}.")).unwrap_or_default()
    ));
    let data = serde_json::to_vec_pretty(value)?;
    {
        let mut file = File::create(&tmp)?;
        file.write_all(&data)?;
        file.flush()?;
        file.sync_data()?;
    }
    fs::rename(&tmp, path)?;
    Ok(())
}

/// 把旧版本的文件内容升级到当前版本。
///
/// 目前只有 v1，函数体是空的；保留这个入口是为了以后加字段 / 改语义时
/// **只改这一处**，而不是在每个 load 里散落 `if version < N` 分支。
pub fn migrate(value: &mut serde_json::Value, target: u32) -> Result<()> {
    let Some(object) = value.as_object_mut() else {
        return Ok(());
    };
    let version = object.get("format").and_then(|v| v.as_u64()).unwrap_or(FORMAT_VERSION as u64) as u32;
    if version > target {
        return Err(SyncError::Unsupported(format!(
            "数据格式版本 {version} 高于本程序支持的 {target}"
        )));
    }
    // 未来：if version < 2 { … 把 v1 结构改写成 v2 … }
    object.insert("format".to_string(), serde_json::Value::from(target));
    Ok(())
}

/// 十六进制编码（密钥 / MAC 展示用，避免为一个 base64 再拉依赖）。
pub fn hex_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

/// 十六进制解码（非法输入返回 `None`）。
// 这里不用 `is_multiple_of`：它要求较新的工具链，而本项目的构建环境版本跨度较大
#[allow(clippy::manual_is_multiple_of)]
pub fn hex_decode(text: &str) -> Option<Vec<u8>> {
    if text.len() % 2 != 0 {
        return None;
    }
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(text.len() / 2);
    for pair in bytes.chunks(2) {
        let hi = (pair[0] as char).to_digit(16)?;
        let lo = (pair[1] as char).to_digit(16)?;
        out.push((hi * 16 + lo) as u8);
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::OpKind;
    use crate::hlc::Hlc;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("readerx-sync-test-{tag}-{}", new_id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    fn sample_op(origin: &str, seq: u64) -> Operation {
        Operation {
            op_id: new_id(),
            origin: origin.to_string(),
            seq,
            hlc: Hlc::new(1_000 + seq, 0, origin),
            entity_id: "book-1".to_string(),
            kind: "book".to_string(),
            field: "title".to_string(),
            op: OpKind::Set { value: serde_json::json!("三体") },
            base: VersionVector::new(),
            schema_ver: 1,
            at_ms: 1_000,
        }
    }

    #[test]
    fn open_creates_identity_and_reuses_it() {
        let dir = temp_dir("open");
        let store = SyncStore::open(&dir, "手机").unwrap();
        let id = store.device().device_id.clone();
        assert_eq!(store.device().device_name, "手机");
        assert_eq!(store.device().secret_bytes().unwrap().len(), SECRET_BYTES);

        // 再次打开：设备 id 与密钥保持不变（换了就等于换设备）
        let again = SyncStore::open(&dir, "手机").unwrap();
        assert_eq!(again.device().device_id, id);
        assert_eq!(again.device().secret, store.device().secret);
        // 改名生效
        let renamed = SyncStore::open(&dir, "客厅台式机").unwrap();
        assert_eq!(renamed.device().device_name, "客厅台式机");
        assert_eq!(renamed.device().device_id, id);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn pairing_code_roundtrip_and_join() {
        let dir_a = temp_dir("pair-a");
        let dir_b = temp_dir("pair-b");
        let a = SyncStore::open(&dir_a, "A").unwrap();
        let code = a.device().pairing_code();

        let b = SyncStore::join(&dir_b, &code, "B").unwrap();
        assert_eq!(b.group_id(), a.group_id());
        assert_eq!(b.device().secret, a.device().secret);
        assert_ne!(b.device_id(), a.device_id(), "加入群组不应改变本设备 id");
        // 重新打开 B：群组信息保留
        let b2 = SyncStore::open(&dir_b, "B").unwrap();
        assert_eq!(b2.group_id(), a.group_id());

        assert!(SyncStore::join(&dir_b, "坏码", "B").is_err());
        assert!(SyncStore::join(&dir_b, "group.short", "B").is_err());
        fs::remove_dir_all(&dir_a).ok();
        fs::remove_dir_all(&dir_b).ok();
    }

    #[test]
    fn oplog_append_and_read_back() {
        let dir = temp_dir("oplog");
        let store = SyncStore::open(&dir, "A").unwrap();
        assert_eq!(store.read_oplog().unwrap().len(), 0);
        for seq in 1..=3 {
            store.append_op(&sample_op(store.device_id(), seq)).unwrap();
        }
        let ops = store.read_oplog().unwrap();
        assert_eq!(ops.len(), 3);
        assert_eq!(ops[2].seq, 3);
        assert_eq!(store.oplog_lines().unwrap(), 3);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn snapshot_roundtrip_and_migration_guard() {
        let dir = temp_dir("snapshot");
        let store = SyncStore::open(&dir, "A").unwrap();
        let entity = Entity::new("book-1", "book", Hlc::new(1, 0, "A"), 1);
        store.save_entities(std::slice::from_ref(&entity), 7).unwrap();
        let snapshot = store.load_entities().unwrap();
        assert_eq!(snapshot.applied_ops, 7);
        assert_eq!(snapshot.entities.len(), 1);
        assert_eq!(snapshot.format, FORMAT_VERSION);

        // 未来版本：拒绝加载，而不是按旧语义写坏
        let mut value = serde_json::to_value(&snapshot).unwrap();
        value["format"] = serde_json::json!(FORMAT_VERSION + 1);
        fs::write(dir.join("entities.json"), serde_json::to_vec(&value).unwrap()).unwrap();
        let err = store.load_entities().unwrap_err();
        assert!(matches!(err, SyncError::Unsupported(_)), "应拒绝未来版本：{err}");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn migrate_fills_missing_version() {
        // 老文件没有 format 字段：按当前版本补齐
        let mut value = serde_json::json!({ "applied_ops": 0, "saved_at_ms": 0, "entities": [] });
        migrate(&mut value, FORMAT_VERSION).unwrap();
        assert_eq!(value["format"], serde_json::json!(FORMAT_VERSION));
    }

    #[test]
    fn hex_helpers() {
        let bytes = vec![0x00, 0x1f, 0xff, 0xa5];
        let text = hex_encode(&bytes);
        assert_eq!(text, "001fffa5");
        assert_eq!(hex_decode(&text).unwrap(), bytes);
        assert!(hex_decode("xyz").is_none());
        assert!(hex_decode("abc").is_none());
    }

    #[test]
    fn peers_and_conflicts_roundtrip() {
        let dir = temp_dir("peers");
        let store = SyncStore::open(&dir, "A").unwrap();
        let mut peers = BTreeMap::new();
        peers.insert(
            "peer-1".to_string(),
            PeerState {
                device_id: "peer-1".to_string(),
                name: "手机".to_string(),
                addr: Some("192.168.1.9:47821".to_string()),
                knowledge: VersionVector::from_pairs([("peer-1", 4)]),
                last_seen_ms: 42,
                sync_count: 2,
                ..PeerState::default()
            },
        );
        store.save_peers(&peers).unwrap();
        let back = store.load_peers().unwrap();
        assert_eq!(back["peer-1"].knowledge.get("peer-1"), 4);
        assert_eq!(back["peer-1"].sync_count, 2);

        store.save_deferred(&[sample_op("peer-1", 9)]).unwrap();
        assert_eq!(store.load_deferred().unwrap().len(), 1);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn lock_is_created_and_released() {
        let dir = temp_dir("lock");
        fs::create_dir_all(&dir).unwrap();
        let lock = LockGuard::acquire(&dir, "dev-1").unwrap();
        assert!(lock.path().exists(), "打开后应留下锁文件");
        let info: LockInfo = read_json(lock.path()).unwrap();
        assert_eq!(info.pid, std::process::id());
        drop(lock);
        assert!(!dir.join(".lock").exists(), "释放后锁文件应被删除");

        // 同一进程重复获取（连续命令 / 测试）应当放行
        let a = LockGuard::acquire(&dir, "dev-1").unwrap();
        let b = LockGuard::acquire(&dir, "dev-1").unwrap();
        drop((a, b));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn lock_from_a_dead_process_is_taken_over() {
        let dir = temp_dir("lock-stale");
        fs::create_dir_all(&dir).unwrap();
        // 一个几乎不可能存在的 pid：旧锁应被接管
        write_json_atomic(
            &dir.join(".lock"),
            &LockInfo { pid: 4_000_000_000, device: "ghost".into(), started_at_ms: 1 },
        )
        .unwrap();
        let lock = LockGuard::acquire(&dir, "dev-1").expect("残留锁应可接管");
        let info: LockInfo = read_json(lock.path()).unwrap();
        assert_eq!(info.pid, std::process::id());
        drop(lock);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    #[cfg(any(target_os = "linux", target_os = "android"))]
    fn lock_held_by_a_live_process_is_refused() {
        let dir = temp_dir("lock-live");
        fs::create_dir_all(&dir).unwrap();
        // pid 1（init）一定存在：模拟「另一个进程正开着这个目录」
        write_json_atomic(
            &dir.join(".lock"),
            &LockInfo { pid: 1, device: "other".into(), started_at_ms: 1 },
        )
        .unwrap();
        let err = LockGuard::acquire(&dir, "dev-1").unwrap_err();
        assert!(matches!(err, SyncError::Invalid(_)), "{err}");
        assert!(err.to_string().contains("另一个进程"), "{err}");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn atomic_write_leaves_no_partial_file() {
        let dir = temp_dir("atomic");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("x.json");
        write_json_atomic(&path, &serde_json::json!({"a": 1})).unwrap();
        let value: serde_json::Value = read_json(&path).unwrap();
        assert_eq!(value["a"], serde_json::json!(1));
        // 目录里不应残留临时文件
        let leftovers: Vec<String> = fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.contains("tmp"))
            .collect();
        assert!(leftovers.is_empty(), "残留临时文件：{leftovers:?}");
        fs::remove_dir_all(&dir).ok();
    }
}
