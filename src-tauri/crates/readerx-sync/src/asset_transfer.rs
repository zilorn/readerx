//! 超大资源分片：线上的每帧有界，完整校验前不进入资源暂存区。
use std::fs::{self, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::PathBuf;

use crate::assets::{valid_name, Asset, AssetChunk};
use crate::content::asset_digest;
use crate::engine::SyncEngine;
use crate::error::{Result, SyncError};
use crate::proto::ASSET_CHUNK_BYTES;

/// 每条连接独享工作区和发送快照，避免并行连接互相覆盖片段。
pub(crate) struct AssetTransfer {
    root: PathBuf,
    outgoing: Option<(String, String, Vec<u8>, String)>,
}

impl AssetTransfer {
    pub(crate) fn new(root: PathBuf) -> Self {
        Self {
            root: root.join(crate::new_id()),
            outgoing: None,
        }
    }

    /// 首片固定发送快照，后续不重复读盘 / 编码，也不混入会话中变化的内容。
    pub(crate) fn pull(
        &mut self,
        engine: &SyncEngine,
        book: &str,
        name: &str,
        offset: u64,
        hash: &str,
    ) -> Result<AssetChunk> {
        if offset == 0 {
            let asset = engine
                .asset_bodies(book, &[name.to_string()])
                .into_iter()
                .find(|asset| asset.name == name)
                .ok_or_else(|| {
                    SyncError::Protocol(format!("资源无法读取 book={book} name={name}"))
                })?;
            let bytes = encode(&asset)?;
            let digest = asset_digest(&bytes);
            self.outgoing = Some((book.to_string(), name.to_string(), bytes, digest));
        }
        let Some((cached_book, cached_name, bytes, digest)) = &self.outgoing else {
            return Err(SyncError::Protocol("资源分片缺少起始请求".into()));
        };
        if cached_book != book || cached_name != name || (offset > 0 && digest != hash) {
            return Err(SyncError::Protocol("资源分片与发送快照不一致".into()));
        }
        make_chunk(name, bytes, digest, offset)
    }

    /// 片段落到连接独享文件；仅最后一片通过总长度与完整指纹校验后返回资源。
    pub(crate) fn receive(&mut self, chunk: &AssetChunk) -> Result<Option<Asset>> {
        validate_chunk(chunk)?;
        fs::create_dir_all(&self.root)?;
        let key = asset_digest(format!("{}\0{}", chunk.name, chunk.hash).as_bytes());
        let path = self.root.join(key);
        let mut file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&path)?;
        let len = file.metadata()?.len();
        let end = chunk.offset + chunk.bytes.len() as u64;
        if chunk.offset == len {
            file.seek(SeekFrom::End(0))?;
            file.write_all(&chunk.bytes)?;
            file.sync_all()?;
        } else if end <= len {
            // 同一连接重试同一片段时不重复追加。
            file.seek(SeekFrom::Start(chunk.offset))?;
            let mut existing = vec![0; chunk.bytes.len()];
            file.read_exact(&mut existing)?;
            if existing != chunk.bytes {
                return Err(SyncError::Protocol("重复资源分片内容不一致".into()));
            }
        } else {
            return Err(SyncError::Protocol("资源分片偏移不连续".into()));
        }
        if end != chunk.total {
            return Ok(None);
        }
        if file.metadata()?.len() != chunk.total {
            return Err(SyncError::Protocol("资源分片总长度不一致".into()));
        }
        file.seek(SeekFrom::Start(0))?;
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)?;
        if asset_digest(&bytes) != chunk.hash {
            return Err(SyncError::Protocol("资源分片完整指纹校验失败".into()));
        }
        let asset: Asset = serde_json::from_slice(&bytes)?;
        if asset.name != chunk.name || asset.bytes.is_empty() {
            return Err(SyncError::Protocol("资源分片重组结果无效".into()));
        }
        drop(file);
        fs::remove_file(path)?;
        Ok(Some(asset))
    }
}

impl Drop for AssetTransfer {
    fn drop(&mut self) {
        if let Err(error) = fs::remove_dir_all(&self.root) {
            if error.kind() != std::io::ErrorKind::NotFound {
                log::debug!("清理资源分片工作区失败：{error}");
            }
        }
    }
}

pub(crate) fn encode(asset: &Asset) -> Result<Vec<u8>> {
    Ok(serde_json::to_vec(asset)?)
}

pub(crate) fn make_chunk(name: &str, bytes: &[u8], hash: &str, offset: u64) -> Result<AssetChunk> {
    let start =
        usize::try_from(offset).map_err(|_| SyncError::Protocol("资源分片偏移溢出".into()))?;
    if start >= bytes.len() {
        return Err(SyncError::Protocol("资源分片偏移超出长度".into()));
    }
    let end = start.saturating_add(ASSET_CHUNK_BYTES).min(bytes.len());
    Ok(AssetChunk {
        name: name.to_string(),
        hash: hash.to_string(),
        offset,
        total: bytes.len() as u64,
        bytes: bytes[start..end].to_vec(),
    })
}

fn validate_chunk(chunk: &AssetChunk) -> Result<()> {
    if !valid_name(&chunk.name)
        || chunk.hash.len() != 64
        || !chunk.hash.bytes().all(|byte| byte.is_ascii_hexdigit())
        || chunk.bytes.is_empty()
        || chunk.bytes.len() > ASSET_CHUNK_BYTES
        || chunk
            .offset
            .checked_add(chunk.bytes.len() as u64)
            .is_none_or(|end| end > chunk.total)
    {
        return Err(SyncError::Protocol("资源分片参数无效".into()));
    }
    Ok(())
}

/// 大资源推送：逐片确认，最后一片才确认完整资源已暂存。
pub(crate) fn push(
    transport: &mut dyn crate::net::Transport,
    book: &str,
    asset: &Asset,
    progress: &mut dyn FnMut(u64) -> Result<()>,
) -> Result<()> {
    use crate::proto::{Request, Response};
    let bytes = encode(asset)?;
    let hash = asset_digest(&bytes);
    let mut offset = 0;
    while offset < bytes.len() as u64 {
        let chunk = make_chunk(&asset.name, &bytes, &hash, offset)?;
        let size = chunk.bytes.len() as u64;
        let end = offset + size;
        match transport.request(&Request::PushAssetChunk {
            book: book.to_string(),
            chunk,
        })? {
            Response::AssetChunkAck {
                offset: confirmed,
                complete,
            } if confirmed == end && complete == (end == bytes.len() as u64) => {}
            Response::Error { code, message } => {
                return Err(SyncError::Protocol(format!(
                    "资源分片推送失败（{code}）：{message}"
                )))
            }
            _ => {
                return Err(SyncError::Protocol(format!(
                    "资源分片未完整确认 book={book} name={}",
                    asset.name
                )))
            }
        }
        offset = end;
        progress(size)?;
    }
    Ok(())
}

/// 普通资源请求返回空时走分片拉取；不存在的资源由对端明确报错。
pub(crate) fn pull(
    transport: &mut dyn crate::net::Transport,
    book: &str,
    name: &str,
    receiver: &mut AssetTransfer,
    progress: &mut dyn FnMut(u64) -> Result<()>,
) -> Result<Asset> {
    use crate::proto::{Request, Response};
    let mut offset = 0;
    let mut hash = String::new();
    let mut total = None;
    loop {
        let chunk = match transport.request(&Request::PullAssetChunk {
            book: book.to_string(),
            name: name.to_string(),
            offset,
            hash: hash.clone(),
        })? {
            Response::AssetChunk { chunk } => chunk,
            Response::Error { code, message } => {
                return Err(SyncError::Protocol(format!(
                    "资源分片拉取失败（{code}）：{message}"
                )))
            }
            _ => {
                return Err(SyncError::Protocol(format!(
                    "对端未返回资源分片 book={book} name={name}"
                )))
            }
        };
        if chunk.name != name
            || chunk.offset != offset
            || total.is_some_and(|size| size != chunk.total)
            || (!hash.is_empty() && hash != chunk.hash)
        {
            return Err(SyncError::Protocol(format!(
                "资源分片响应不一致 book={book} name={name}"
            )));
        }
        let asset = receiver.receive(&chunk)?;
        offset += chunk.bytes.len() as u64;
        hash = chunk.hash;
        total = Some(chunk.total);
        progress(chunk.bytes.len() as u64)?;
        if let Some(asset) = asset {
            return Ok(asset);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::assets::AssetKind;

    #[test]
    fn startup_cleans_only_unfinished_fragments_and_read_only_keeps_them() {
        let root = std::env::temp_dir().join(format!("readerx-chunk-cleanup-{}", crate::new_id()));
        let engine = SyncEngine::open(&root, crate::EngineOptions::new("cleanup")).unwrap();
        let scratch = engine.asset_transfer_root();
        fs::create_dir_all(&scratch).unwrap();
        fs::write(scratch.join("unfinished"), b"partial").unwrap();
        let asset = Asset::new("cover", AssetKind::Cover, "image/png", "png", vec![1]);
        let mut engine = engine;
        engine.stage_assets("book", &[asset]).unwrap();
        let reader =
            SyncEngine::open(&root, crate::EngineOptions::new("reader").read_only()).unwrap();
        assert!(scratch.exists());
        drop(reader);
        drop(engine);
        let engine = SyncEngine::open(&root, crate::EngineOptions::new("cleanup")).unwrap();
        assert!(!scratch.exists());
        assert_eq!(engine.staged_assets("book").len(), 1);
        drop(engine);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn fragments_verify_offsets_and_hash_and_cleanup() {
        let root = std::env::temp_dir().join(format!("readerx-chunks-{}", crate::new_id()));
        let asset = Asset::new(
            "cover",
            AssetKind::Cover,
            "image/png",
            "png",
            vec![1; ASSET_CHUNK_BYTES],
        );
        let bytes = encode(&asset).unwrap();
        let hash = asset_digest(&bytes);
        let first = make_chunk("cover", &bytes, &hash, 0).unwrap();
        let last = make_chunk("cover", &bytes, &hash, first.bytes.len() as u64).unwrap();
        let mut receiver = AssetTransfer::new(root.clone());
        assert!(receiver.receive(&last).is_err(), "禁止缺少首片");
        assert!(receiver.receive(&first).unwrap().is_none());
        assert!(
            receiver.receive(&first).unwrap().is_none(),
            "重试首片不重复追加"
        );
        let mut bad = last.clone();
        bad.bytes[0] ^= 1;
        assert!(receiver.receive(&bad).is_err(), "整份指纹不符不允许落库");
        drop(receiver);
        let mut receiver = AssetTransfer::new(root.clone());
        assert!(receiver.receive(&first).unwrap().is_none());
        let received = receiver.receive(&last).unwrap().unwrap();
        assert_eq!(received.bytes, asset.bytes);
        assert_eq!(received.name, asset.name);
        assert_eq!(fs::read_dir(&receiver.root).unwrap().count(), 0);
        let path = receiver.root.clone();
        drop(receiver);
        assert!(!path.exists());
        fs::remove_dir_all(root).unwrap();
    }
}
