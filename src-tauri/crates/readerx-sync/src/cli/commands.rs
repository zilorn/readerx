//! CLI 各子命令的实现与输出渲染。
//!
//! 约定：**结果走标准输出**（纯数据，便于脚本 / 人工查看），日志走标准错误；
//! 需要机器可读时加 `--json`。

use serde_json::json;
use std::collections::BTreeMap;
use std::time::Duration;

use crate::cli::parse::{parse_kv, parse_value};
use crate::cli::Cli;
use crate::engine::SyncEngine;
use crate::error::{Result, SyncError};
use crate::model::{Conflict, ConflictStatus, Entity, Resolution};
use crate::net::{lock_engine, shared, DiscoveryService, PeerServer, ServerOptions, TrustPolicy};
use crate::session::sync_with_addr;

/// 子命令分发。
pub fn dispatch(cli: &Cli) -> Result<()> {
    match cli.command.as_str() {
        "help" | "--help" | "-h" => {
            println!("{}", crate::cli::parse::USAGE_TEXT);
            Ok(())
        }
        "init" => cmd_init(cli),
        "pairing" => cmd_pairing(cli),
        "status" => cmd_status(cli),
        "create" => cmd_create(cli),
        "set" => cmd_set(cli),
        "unset" => cmd_unset(cli),
        "incr" => cmd_incr(cli),
        "add" => cmd_add(cli),
        "rm" => cmd_rm(cli),
        "move" => cmd_move(cli),
        "delete" | "del" => cmd_delete(cli),
        "restore" => cmd_restore(cli),
        "ls" => cmd_ls(cli),
        "show" => cmd_show(cli),
        "ops" => cmd_ops(cli),
        "conflicts" => cmd_conflicts(cli),
        "resolve" => cmd_resolve(cli),
        "serve" => cmd_serve(cli),
        "discover" => cmd_discover(cli),
        "sync" => cmd_sync(cli),
        other => Err(SyncError::Invalid(format!(
            "未知命令：{other}（用 --help 看用法）"
        ))),
    }
}

fn cmd_init(cli: &Cli) -> Result<()> {
    if let Some(code) = cli.flags.get("join") {
        let mut engine = cli.open_engine()?;
        engine.join_group(&code)?;
        print_identity(&engine, Some("已加入同步群组"));
        return Ok(());
    }
    let engine = cli.open_engine()?;
    print_identity(&engine, Some("同步数据目录已就绪"));
    Ok(())
}

fn print_identity(engine: &SyncEngine, headline: Option<&str>) {
    if let Some(headline) = headline {
        println!("{headline}");
    }
    println!("设备 id   : {}", engine.device_id());
    println!("设备名    : {}", engine.device_name());
    println!("群组 id   : {}", engine.group_id());
    println!("数据目录  : {}", engine.data_dir().display());
    println!("配对码    : {}", engine.pairing_code());
}

fn cmd_pairing(cli: &Cli) -> Result<()> {
    let engine = cli.open_engine_read_only()?;
    println!("{}", engine.pairing_code());
    Ok(())
}

fn cmd_status(cli: &Cli) -> Result<()> {
    let engine = cli.open_engine_read_only()?;
    let status = engine.status();
    if cli.flags.is_set("json") {
        println!(
            "{}",
            serde_json::to_string_pretty(&json!({
                "deviceId": status.device_id,
                "deviceName": status.device_name,
                "groupId": status.group_id,
                "dataDir": status.data_dir.display().to_string(),
                "protocol": status.protocol,
                "entities": status.entities,
                "liveEntities": status.live_entities,
                "deletedEntities": status.deleted_entities,
                "ops": status.ops,
                "conflicts": status.conflicts,
                "pendingConflicts": status.pending_conflicts,
                "deferredOps": status.deferred_ops,
                "peers": status.peers,
                "knowledge": status.knowledge,
            }))?
        );
        return Ok(());
    }
    println!("设备      : {}（{}）", status.device_name, status.device_id);
    println!("群组      : {}", status.group_id);
    println!("数据目录  : {}", status.data_dir.display());
    println!(
        "实体      : {} 条（其中已删除 {}）",
        status.entities, status.deleted_entities
    );
    println!("操作日志  : {} 条", status.ops);
    println!(
        "冲突      : {} 条（待处理 {}）",
        status.conflicts, status.pending_conflicts
    );
    println!("因果缓冲  : {} 条", status.deferred_ops);
    println!("已知对端  : {} 台", status.peers);
    println!("版本向量  : {}", status.knowledge.to_short_string());
    let counts = engine.kind_counts(false);
    if !counts.is_empty() {
        println!("按类型    :");
        for (kind, count) in counts {
            println!("  {kind:<16} {count}");
        }
    }
    for (device, peer) in engine.peers() {
        println!(
            "对端      : {} {} {} 上次同步 {} 次",
            crate::version::short_device(device),
            peer.name,
            peer.addr.clone().unwrap_or_else(|| "-".to_string()),
            peer.sync_count
        );
    }
    Ok(())
}

fn cmd_create(cli: &Cli) -> Result<()> {
    let mut engine = cli.open_engine()?;
    let kind = cli.arg(0, "实体类型")?;
    let mut fields: BTreeMap<String, serde_json::Value> = BTreeMap::new();
    for item in cli.flags.all("set") {
        let (key, value) = parse_kv(&item).map_err(SyncError::Invalid)?;
        fields.insert(key, value);
    }
    let id = cli.flags.get("id");
    let id = engine.create_entity(&kind, id, fields)?;
    engine.flush()?;
    println!("{id}");
    Ok(())
}

fn cmd_set(cli: &Cli) -> Result<()> {
    let mut engine = cli.open_engine()?;
    let id = cli.arg(0, "实体 id")?;
    let field = cli.arg(1, "字段名")?;
    let raw = cli.flags.is_set("raw");
    let value = parse_value(&cli.arg(2, "字段值")?, raw).map_err(SyncError::Invalid)?;
    engine.set_field(&id, &field, value)?;
    engine.flush()?;
    Ok(())
}

fn cmd_unset(cli: &Cli) -> Result<()> {
    let mut engine = cli.open_engine()?;
    let id = cli.arg(0, "实体 id")?;
    let field = cli.arg(1, "字段名")?;
    engine.unset_field(&id, &field)?;
    engine.flush()?;
    Ok(())
}

fn cmd_incr(cli: &Cli) -> Result<()> {
    let mut engine = cli.open_engine()?;
    let id = cli.arg(0, "实体 id")?;
    let field = cli.arg(1, "字段名")?;
    let delta = cli
        .arg(2, "增量")?
        .parse::<i64>()
        .map_err(|_| SyncError::Invalid("增量必须是整数".to_string()))?;
    engine.increment(&id, &field, delta)?;
    engine.flush()?;
    println!("{}", engine.field(&id, &field).unwrap_or(serde_json::Value::Null));
    Ok(())
}

fn cmd_add(cli: &Cli) -> Result<()> {
    let mut engine = cli.open_engine()?;
    let id = cli.arg(0, "实体 id")?;
    let field = cli.arg(1, "字段名")?;
    let element = cli.arg(2, "元素")?;
    let position = cli.flags.get("pos");
    let used = engine.add_element(&id, &field, &element, position)?;
    engine.flush()?;
    if !used.is_empty() {
        println!("{used}");
    }
    Ok(())
}

fn cmd_rm(cli: &Cli) -> Result<()> {
    let mut engine = cli.open_engine()?;
    let id = cli.arg(0, "实体 id")?;
    let field = cli.arg(1, "字段名")?;
    let element = cli.arg(2, "元素")?;
    engine.remove_element(&id, &field, &element)?;
    engine.flush()?;
    Ok(())
}

fn cmd_move(cli: &Cli) -> Result<()> {
    let mut engine = cli.open_engine()?;
    let id = cli.arg(0, "实体 id")?;
    let field = cli.arg(1, "字段名")?;
    let element = cli.arg(2, "元素")?;
    let position = cli.arg(3, "位置键")?;
    engine.move_element(&id, &field, &element, &position)?;
    engine.flush()?;
    Ok(())
}

fn cmd_delete(cli: &Cli) -> Result<()> {
    let mut engine = cli.open_engine()?;
    let id = cli.arg(0, "实体 id")?;
    let cascaded = engine.delete_entity(&id, cli.flags.get("reason"))?;
    engine.flush()?;
    if cascaded > 0 {
        println!("同时处理了 {cascaded} 条子记录");
    }
    Ok(())
}

fn cmd_restore(cli: &Cli) -> Result<()> {
    let mut engine = cli.open_engine()?;
    let id = cli.arg(0, "实体 id")?;
    engine.restore_entity(&id)?;
    engine.flush()?;
    Ok(())
}

fn cmd_ls(cli: &Cli) -> Result<()> {
    let engine = cli.open_engine_read_only()?;
    let all = cli.flags.is_set("all");
    let kind = cli.flags.get("kind");
    let entities: Vec<&Entity> = match &kind {
        Some(kind) => engine.entities_of_kind(kind, all),
        None => engine.all_entities(all),
    };
    if cli.flags.is_set("json") {
        let list: Vec<serde_json::Value> =
            entities.iter().map(|e| entity_json(&engine, e)).collect();
        println!("{}", serde_json::to_string_pretty(&list)?);
        return Ok(());
    }
    if entities.is_empty() {
        println!("（没有匹配的实体）");
        return Ok(());
    }
    for entity in entities {
        let title = entity
            .field("title")
            .or_else(|| entity.field("name"))
            .and_then(|v| v.as_str().map(str::to_string))
            .unwrap_or_default();
        let mark = if engine.is_effectively_deleted(entity) { "✗" } else { "·" };
        println!(
            "{mark} {:<16} {:<12} {}{}",
            entity.id,
            entity.kind,
            title,
            if entity.conflicted.is_empty() {
                String::new()
            } else {
                format!("  [待裁决: {}]", entity.conflicted.iter().cloned().collect::<Vec<_>>().join(","))
            }
        );
    }
    Ok(())
}

fn entity_json(engine: &SyncEngine, entity: &Entity) -> serde_json::Value {
    let fields: BTreeMap<String, serde_json::Value> = entity
        .fields
        .iter()
        .map(|(name, state)| {
            let policy = engine
                .schemas()
                .get(&entity.kind)
                .field_kind(name)
                .set_policy()
                .unwrap_or(crate::model::SetPolicy::AddWins);
            (name.clone(), state.display_value(policy))
        })
        .collect();
    json!({
        "id": entity.id,
        "kind": entity.kind,
        "fields": fields,
        "version": entity.version,
        "deleted": entity.is_deleted(),
        "effectivelyDeleted": engine.is_effectively_deleted(entity),
        "created": entity.created.to_string(),
        "updated": entity.updated.to_string(),
        "conflicted": entity.conflicted,
    })
}

fn cmd_show(cli: &Cli) -> Result<()> {
    let engine = cli.open_engine_read_only()?;
    let id = cli.arg(0, "实体 id")?;
    let entity = engine
        .entity(&id)
        .ok_or_else(|| SyncError::NotFound(format!("实体 {id}")))?;
    println!("{}", serde_json::to_string_pretty(&entity_json(&engine, entity))?);
    Ok(())
}

fn cmd_ops(cli: &Cli) -> Result<()> {
    let engine = cli.open_engine_read_only()?;
    let limit = cli.flags.get_u64("limit").unwrap_or(20) as usize;
    let ops = engine.ops();
    for op in ops.iter().rev().take(limit).rev() {
        println!(
            "{}  {}  {}",
            op.hlc,
            crate::version::short_device(&op.origin),
            op.summary()
        );
    }
    println!("（共 {} 条操作）", ops.len());
    Ok(())
}

fn cmd_conflicts(cli: &Cli) -> Result<()> {
    let engine = cli.open_engine_read_only()?;
    let all = cli.flags.is_set("all");
    let conflicts = engine.conflicts(if all { None } else { Some(ConflictStatus::Pending) });
    if cli.flags.is_set("json") {
        println!("{}", serde_json::to_string_pretty(&conflicts)?);
        return Ok(());
    }
    if conflicts.is_empty() {
        println!("（没有{}冲突）", if all { "" } else { "待处理的" });
        return Ok(());
    }
    for conflict in conflicts {
        print_conflict(conflict);
    }
    Ok(())
}

fn print_conflict(conflict: &Conflict) {
    println!(
        "{}  {:?}  {:?}  {}.{}",
        conflict.id,
        conflict.reason,
        conflict.status,
        conflict.kind,
        if conflict.field.is_empty() { "-" } else { &conflict.field }
    );
    println!("    实体 : {}", conflict.entity_id);
    if let Some(note) = &conflict.note {
        println!("    说明 : {note}");
    }
    println!(
        "    本地 : {} @ {}",
        conflict.local.value.clone().unwrap_or(serde_json::Value::Null),
        conflict.local.hlc
    );
    println!(
        "    对端 : {} @ {}",
        conflict.remote.value.clone().unwrap_or(serde_json::Value::Null),
        conflict.remote.hlc
    );
}

fn cmd_resolve(cli: &Cli) -> Result<()> {
    let mut engine = cli.open_engine()?;
    let id = cli.arg(0, "冲突 id")?;
    let resolution = if cli.flags.is_set("dismiss") {
        Resolution::Dismiss
    } else if let Some(value) = cli.flags.get("value") {
        Resolution::Value { value: parse_value(&value, cli.flags.is_set("raw")).map_err(SyncError::Invalid)? }
    } else {
        match cli.flags.get("keep").as_deref() {
            Some("local") | Some("本地") => Resolution::KeepLocal,
            Some("remote") | Some("对端") => Resolution::KeepRemote,
            _ => {
                return Err(SyncError::Invalid(
                    "请指定 --keep local|remote、--value <json> 或 --dismiss".to_string(),
                ))
            }
        }
    };
    engine.resolve_conflict(&id, resolution)?;
    engine.flush()?;
    println!("已处理");
    Ok(())
}

fn cmd_serve(cli: &Cli) -> Result<()> {
    let engine = cli.open_engine()?;
    let bind_port = cli.flags.get_u64("port").unwrap_or(crate::DEFAULT_PORT as u64) as u16;
    let discovery_port = cli.discovery_port();
    let options = ServerOptions::from_engine(&engine)?
        .with_bind(std::net::SocketAddr::from(([0, 0, 0, 0], bind_port)));
    let options = if let Some(list) = cli.flags.get("allow") {
        let devices: Vec<String> = list.split(',').map(|s| s.trim().to_string()).collect();
        options.with_trust(TrustPolicy::AllowList(devices))
    } else {
        options
    };
    let secret = engine.secret_bytes()?;
    let group = engine.group_id().to_string();
    let device = engine.device_id().to_string();
    let name = engine.device_name().to_string();

    let shared = shared(engine);
    let server = PeerServer::start(shared.clone(), options)?;
    let sync_port = server.local_addr().port();
    // 让引擎知道自己在监听哪个端口：握手时告诉对端，对端才能主动连回来
    lock_engine(&shared).set_listen_port(sync_port);

    let discovery = if cli.flags.is_set("no-discovery") {
        None
    } else {
        match DiscoveryService::start(
            secret,
            group,
            device,
            name,
            sync_port,
            discovery_port,
            std::net::IpAddr::V4(std::net::Ipv4Addr::UNSPECIFIED),
        ) {
            Ok(service) => Some(service),
            Err(e) => {
                // 发现端口被占用不影响同步（可以手动填地址），只提示一下
                eprintln!("发现服务未启动（不影响同步）：{e}");
                None
            }
        }
    };

    println!("同步服务已启动：{}", server.local_addr());
    if let Some(service) = &discovery {
        println!("发现服务已启动：{}", service.local_addr());
    }
    println!("按 Ctrl+C 退出");
    // 前台常驻：Ctrl+C 由系统结束进程（服务端与发现服务各自在后台线程里跑）
    loop {
        std::thread::sleep(Duration::from_secs(3600));
    }
}

fn cmd_discover(cli: &Cli) -> Result<()> {
    let engine = cli.open_engine_read_only()?;
    let timeout = Duration::from_secs(cli.flags.get_u64("timeout").unwrap_or(3));
    let peers = crate::net::discovery::scan(
        &engine.secret_bytes()?,
        engine.group_id(),
        engine.device_id(),
        engine.device_name(),
        timeout,
        cli.discovery_port(),
    )?;
    if peers.is_empty() {
        println!("（没有发现同群组的对端；确认对方已 serve，且在同一局域网）");
        return Ok(());
    }
    for peer in peers {
        println!(
            "{}  {}  {}  {}",
            crate::version::short_device(&peer.device),
            peer.name,
            peer.addr,
            peer.protocol
        );
    }
    Ok(())
}

fn cmd_sync(cli: &Cli) -> Result<()> {
    let mut engine = cli.open_engine()?;
    let target = cli.arg(0, "对端地址（host:port 或 auto）")?;
    let timeout = cli.timeout();

    if target == "auto" {
        let peers = crate::net::discovery::scan(
            &engine.secret_bytes()?,
            engine.group_id(),
            engine.device_id(),
            engine.device_name(),
            Duration::from_secs(cli.flags.get_u64("timeout").unwrap_or(3)),
            cli.discovery_port(),
        )?;
        if peers.is_empty() {
            return Err(SyncError::NotFound("没有发现可同步的对端".to_string()));
        }
        let mut failures = 0usize;
        for peer in peers {
            let addr = peer.addr.to_string();
            match sync_with_addr(&mut engine, &addr, timeout) {
                Ok(report) => println!("{}  {}", peer.name, report.summary()),
                Err(e) => {
                    failures += 1;
                    println!("{} 失败：{e}", peer.name);
                }
            }
        }
        if failures > 0 && failures == engine.status().peers {
            return Err(SyncError::Transport("所有对端都同步失败".to_string()));
        }
        return Ok(());
    }

    // 也允许直接给「对端设备 id」，从 peers.json 里查最近地址
    let addr = match resolve_peer_addr(&engine, &target) {
        Some(addr) => addr,
        None => target.clone(),
    };
    let report = sync_with_addr(&mut engine, &addr, timeout)?;
    println!("{}", report.summary());
    Ok(())
}

/// 把「设备 id（或前缀）」解析成最近一次见过的地址。
fn resolve_peer_addr(engine: &SyncEngine, target: &str) -> Option<String> {
    let peer = engine.peers().values().find(|p| p.device_id == target || p.device_id.starts_with(target))?;
    peer.addr.clone()
}
