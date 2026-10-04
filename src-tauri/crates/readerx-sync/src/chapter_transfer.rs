//! 超大章节分片：线上的每帧有界，完整校验前不进入章节暂存区。
use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::PathBuf;

use crate::content::asset_digest;
use crate::content::{ChapterChunk, ChapterContent};
use crate::engine::SyncEngine;
use crate::error::{Result, SyncError};
const CHAPTER_CHUNK_BYTES: usize = 512 * 1024;

/// 每条连接独享工作区和发送快照，避免并行连接互相覆盖片段。
pub(crate) struct ChapterTransfer {
    root: PathBuf,
    incoming: HashMap<String, u64>,
    outgoing: Option<(String, String, Vec<u8>, String)>,
}

impl ChapterTransfer {
    pub(crate) fn new(root: PathBuf) -> Self {
        Self {
            root: root.join(crate::new_id()),
            outgoing: None,
            incoming: HashMap::new(),
        }
    }

    /// 首片固定发送快照，后续不重复读盘 / 编码，也不混入会话中变化的内容。
    pub(crate) fn pull(
        &mut self,
        engine: &SyncEngine,
        book: &str,
        cid: &str,
        offset: u64,
        hash: &str,
    ) -> Result<ChapterChunk> {
        if offset == 0 {
            let chapter = engine
                .content_bodies(book, &[cid.to_string()])
                .into_iter()
                .find(|chapter| chapter.cid == cid)
                .ok_or_else(|| {
                    SyncError::Protocol(format!("章节无法读取 book={book} cid={cid}"))
                })?;
            let bytes = encode(&chapter)?;
            let digest = asset_digest(&bytes);
            self.outgoing = Some((book.to_string(), cid.to_string(), bytes, digest));
        }
        let Some((cached_book, cached_cid, bytes, digest)) = &self.outgoing else {
            return Err(SyncError::Protocol("章节分片缺少起始请求".into()));
        };
        if cached_book != book || cached_cid != cid || (offset > 0 && digest != hash) {
            return Err(SyncError::Protocol("章节分片与发送快照不一致".into()));
        }
        make_chunk(cid, bytes, digest, offset)
    }

    /// 片段落到连接独享文件；仅最后一片通过总长度与完整指纹校验后返回章节。
    pub(crate) fn receive(
        &mut self,
        book: &str,
        chunk: &ChapterChunk,
    ) -> Result<Option<ChapterContent>> {
        validate_chunk(chunk)?;
        fs::create_dir_all(&self.root)?;
        let key = asset_digest(format!("{}\0{}\0{}", book, chunk.cid, chunk.hash).as_bytes());
        if self
            .incoming
            .get(&key)
            .is_some_and(|total| *total != chunk.total)
        {
            return Err(SyncError::Protocol("章节分片总长度发生变化".into()));
        }
        self.incoming.insert(key.clone(), chunk.total);
        let path = self.root.join(&key);
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
                return Err(SyncError::Protocol("重复章节分片内容不一致".into()));
            }
        } else {
            return Err(SyncError::Protocol("章节分片偏移不连续".into()));
        }
        if end != chunk.total {
            return Ok(None);
        }
        if file.metadata()?.len() != chunk.total {
            return Err(SyncError::Protocol("章节分片总长度不一致".into()));
        }
        file.seek(SeekFrom::Start(0))?;
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)?;
        if asset_digest(&bytes) != chunk.hash {
            return Err(SyncError::Protocol("章节分片完整指纹校验失败".into()));
        }
        let chapter: ChapterContent = serde_json::from_slice(&bytes)?;
        if chapter.cid != chunk.cid || !chapter.has_body() {
            return Err(SyncError::Protocol("章节分片重组结果无效".into()));
        }
        drop(file);
        fs::remove_file(path)?;
        self.incoming.remove(&key);
        Ok(Some(chapter))
    }
}

impl Drop for ChapterTransfer {
    fn drop(&mut self) {
        if let Err(error) = fs::remove_dir_all(&self.root) {
            if error.kind() != std::io::ErrorKind::NotFound {
                log::debug!("清理章节分片工作区失败：{error}");
            }
        }
    }
}

pub(crate) fn encode(chapter: &ChapterContent) -> Result<Vec<u8>> {
    Ok(serde_json::to_vec(chapter)?)
}

pub(crate) fn make_chunk(cid: &str, bytes: &[u8], hash: &str, offset: u64) -> Result<ChapterChunk> {
    let start =
        usize::try_from(offset).map_err(|_| SyncError::Protocol("章节分片偏移溢出".into()))?;
    if start >= bytes.len() {
        return Err(SyncError::Protocol("章节分片偏移超出长度".into()));
    }
    let end = start.saturating_add(CHAPTER_CHUNK_BYTES).min(bytes.len());
    Ok(ChapterChunk {
        cid: cid.to_string(),
        hash: hash.to_string(),
        offset,
        total: bytes.len() as u64,
        bytes: bytes[start..end].to_vec(),
    })
}

fn validate_chunk(chunk: &ChapterChunk) -> Result<()> {
    if chunk.cid.is_empty()
        || chunk.hash.len() != 64
        || !chunk.hash.bytes().all(|byte| byte.is_ascii_hexdigit())
        || chunk.bytes.is_empty()
        || chunk.bytes.len() > CHAPTER_CHUNK_BYTES
        || chunk
            .offset
            .checked_add(chunk.bytes.len() as u64)
            .is_none_or(|end| end > chunk.total)
    {
        return Err(SyncError::Protocol("章节分片参数无效".into()));
    }
    Ok(())
}

/// 大章节推送：逐片确认，最后一片才确认完整章节已暂存。
pub(crate) fn push(
    transport: &mut dyn crate::net::Transport,
    book: &str,
    chapter: &ChapterContent,
    progress: &mut dyn FnMut(u64) -> Result<()>,
) -> Result<()> {
    use crate::proto::{Request, Response};
    let bytes = encode(chapter)?;
    let hash = asset_digest(&bytes);
    let mut offset = 0;
    while offset < bytes.len() as u64 {
        let chunk = make_chunk(&chapter.cid, &bytes, &hash, offset)?;
        let size = chunk.bytes.len() as u64;
        let end = offset + size;
        match transport.request(&Request::PushChapterChunk {
            book: book.to_string(),
            chunk,
        })? {
            Response::ChapterChunkAck {
                offset: confirmed,
                complete,
            } if confirmed == end && complete == (end == bytes.len() as u64) => {}
            Response::Error { code, message } => {
                return Err(SyncError::Protocol(format!(
                    "章节分片推送失败（{code}）：{message}"
                )))
            }
            _ => {
                return Err(SyncError::Protocol(format!(
                    "章节分片未完整确认 book={book} cid={}",
                    chapter.cid
                )))
            }
        }
        offset = end;
        progress(size)?;
    }
    Ok(())
}

/// 普通章节请求返回空时走分片拉取；不存在的章节由对端明确报错。
pub(crate) fn pull(
    transport: &mut dyn crate::net::Transport,
    book: &str,
    cid: &str,
    receiver: &mut ChapterTransfer,
    progress: &mut dyn FnMut(u64) -> Result<()>,
) -> Result<(ChapterContent, u64)> {
    use crate::proto::{Request, Response};
    let mut offset = 0;
    let mut hash = String::new();
    let mut total = None;
    loop {
        let chunk = match transport.request(&Request::PullChapterChunk {
            book: book.to_string(),
            cid: cid.to_string(),
            offset,
            hash: hash.clone(),
        })? {
            Response::ChapterChunk { chunk } => chunk,
            Response::Error { code, message } => {
                return Err(SyncError::Protocol(format!(
                    "章节分片拉取失败（{code}）：{message}"
                )))
            }
            _ => {
                return Err(SyncError::Protocol(format!(
                    "对端未返回章节分片 book={book} cid={cid}"
                )))
            }
        };
        if chunk.cid != cid
            || chunk.offset != offset
            || total.is_some_and(|size| size != chunk.total)
            || (!hash.is_empty() && hash != chunk.hash)
        {
            return Err(SyncError::Protocol(format!(
                "章节分片响应不一致 book={book} cid={cid}"
            )));
        }
        let chapter = receiver.receive(book, &chunk)?;
        offset += chunk.bytes.len() as u64;
        hash = chunk.hash;
        total = Some(chunk.total);
        // 完整章节交给调用方先暂存，再执行可取消的检查点。
        if let Some(chapter) = chapter {
            return Ok((chapter, chunk.bytes.len() as u64));
        }
        progress(chunk.bytes.len() as u64)?;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fragments_validate_identity_offsets_hash_retry_and_cleanup() {
        let root = std::env::temp_dir().join(format!("readerx-chapter-chunks-{}", crate::new_id()));
        let chapter = ChapterContent {
            cid: "c1".into(),
            paragraphs: vec!["中🙂".repeat(90_000)],
            ..Default::default()
        };
        let bytes = encode(&chapter).unwrap();
        let hash = asset_digest(&bytes);
        let first = make_chunk("c1", &bytes, &hash, 0).unwrap();
        let last = make_chunk("c1", &bytes, &hash, first.bytes.len() as u64).unwrap();
        let mut receiver = ChapterTransfer::new(root.clone());
        assert!(receiver.receive("book", &last).is_err());
        assert!(receiver.receive("book", &first).unwrap().is_none());
        let mut changed_total = last.clone();
        changed_total.total += 1;
        assert!(receiver.receive("book", &changed_total).is_err());
        assert!(receiver.receive("book", &first).unwrap().is_none());
        assert!(
            receiver.receive("other-book", &last).is_err(),
            "分片不能跨书拼接"
        );
        let mut bad = last.clone();
        bad.bytes[0] ^= 1;
        assert!(receiver.receive("book", &bad).is_err());
        let scratch = receiver.root.clone();
        drop(receiver);
        assert!(!scratch.exists(), "断线清理未完成片段");
        let mut receiver = ChapterTransfer::new(root.clone());
        assert!(receiver.receive("book", &first).unwrap().is_none());
        assert_eq!(receiver.receive("book", &last).unwrap(), Some(chapter));
        assert_eq!(fs::read_dir(&receiver.root).unwrap().count(), 0);
        let mut invalid = first.clone();
        invalid.offset = u64::MAX;
        assert!(receiver.receive("book", &invalid).is_err());
        let mut invalid = first.clone();
        invalid.cid = "different".into();
        let mut receiver2 = ChapterTransfer::new(root.clone());
        assert!(receiver2.receive("book", &invalid).unwrap().is_none());
        let mut invalid_last = last;
        invalid_last.cid = "different".into();
        assert!(
            receiver2.receive("book", &invalid_last).is_err(),
            "重组 cid 与传输身份必须相同"
        );
        drop(receiver);
        drop(receiver2);
        fs::remove_dir_all(root).unwrap();
    }
}
