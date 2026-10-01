//! MOBI6 导入：元信息交给 mobi，正文先拼字节再解码，避免 UTF-8 跨记录丢字。
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use mobi::headers::{Compression, Encryption, ExthRecord, TextEncoding};
use serde::Serialize;
use std::collections::BTreeMap;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedMobi {
    title: String,
    author: String,
    intro: Option<String>,
    html: String,
    images: BTreeMap<usize, String>,
    cover: Option<String>,
}

pub(super) fn invalid() -> String {
    "invalid".into()
}
pub(super) fn u32_at(bytes: &[u8], at: usize) -> Result<usize, String> {
    Ok(u32::from_be_bytes(
        bytes
            .get(at..at + 4)
            .ok_or_else(invalid)?
            .try_into()
            .map_err(|_| invalid())?,
    ) as usize)
}

/// 先检查 PDB 记录边界，防止第三方库在损坏偏移上越界。
fn records(bytes: &[u8]) -> Result<Vec<&[u8]>, String> {
    if bytes.get(60..68) != Some(b"BOOKMOBI") {
        return Err(invalid());
    }
    let count = u16::from_be_bytes(
        bytes
            .get(76..78)
            .ok_or_else(invalid)?
            .try_into()
            .map_err(|_| invalid())?,
    ) as usize;
    if count < 2 || 78 + count * 8 + 2 > bytes.len() {
        return Err(invalid());
    }
    let mut offsets = Vec::with_capacity(count + 1);
    for n in 0..count {
        let offset = u32_at(bytes, 78 + n * 8)?;
        if offset < 78 + count * 8 + 2
            || offset >= bytes.len()
            || offsets.last().is_some_and(|last| *last >= offset)
        {
            return Err(invalid());
        }
        offsets.push(offset);
    }
    offsets.push(bytes.len());
    Ok(offsets
        .windows(2)
        .map(|pair| &bytes[pair[0]..pair[1]])
        .collect())
}

/// 每个正文记录尾部的附加数据采用倒序变长整数长度（长度包含整数自身）。
fn text_record(mut record: &[u8], flags: u32) -> Result<&[u8], String> {
    for bit in 1..32 {
        if flags & (1 << bit) == 0 {
            continue;
        }
        let mut size = 0usize;
        let mut shift = 0;
        let mut found = false;
        for byte in record.iter().rev().take(4) {
            size |= ((byte & 0x7f) as usize) << shift;
            if byte & 0x80 != 0 {
                found = true;
                break;
            }
            shift += 7;
        }
        if !found || size == 0 || size > record.len() {
            return Err(invalid());
        }
        record = &record[..record.len() - size];
    }
    if flags & 1 != 0 {
        let size = (record.last().ok_or_else(invalid)? & 3) as usize + 1;
        record = record
            .get(..record.len().checked_sub(size).ok_or_else(invalid)?)
            .ok_or_else(invalid)?;
    }
    Ok(record)
}

fn palmdoc(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    let mut at = 0;
    while at < bytes.len() {
        let byte = bytes[at];
        at += 1;
        match byte {
            1..=8 => {
                let end = at + byte as usize;
                out.extend_from_slice(bytes.get(at..end).ok_or_else(invalid)?);
                at = end;
            }
            0 | 9..=127 => out.push(byte),
            128..=191 => {
                let next = *bytes.get(at).ok_or_else(invalid)?;
                at += 1;
                let pair = ((byte as usize) << 8) | next as usize;
                let distance = (pair & 0x3fff) >> 3;
                let length = (pair & 7) + 3;
                if distance == 0 || distance > out.len() {
                    return Err(invalid());
                }
                for _ in 0..length {
                    out.push(out[out.len() - distance]);
                }
            }
            _ => {
                out.push(b' ');
                out.push(byte ^ 0x80);
            }
        }
    }
    Ok(out)
}

fn image_url(bytes: &[u8]) -> Option<String> {
    let mime = if bytes.starts_with(b"\xff\xd8\xff") {
        "image/jpeg"
    } else if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        "image/png"
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        "image/gif"
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        "image/webp"
    } else {
        return None;
    };
    Some(format!("data:{mime};base64,{}", B64.encode(bytes)))
}

fn parse(bytes: Vec<u8>) -> Result<ParsedMobi, String> {
    let raw = records(&bytes)?;
    let header = raw[0];
    if header.get(16..20) != Some(b"MOBI") {
        return Err(invalid());
    }
    // 版本在 PalmDOC 后 MOBI 头的偏移 20。纯 KF8 的正文需要重建，不能当 HTML 导入。
    if u32_at(header, 36)? >= 8 {
        return Err("unsupported".into());
    }
    let header_len = u32_at(header, 20)?;
    if header_len < 232 || header_len + 16 > header.len() {
        return Err(invalid());
    }
    let name_at = u32_at(header, 84)?;
    let name_len = u32_at(header, 88)?;
    if name_at
        .checked_add(name_len)
        .is_none_or(|end| end > header.len())
    {
        return Err(invalid());
    }
    if header.get(12..14) != Some(&[0, 0]) {
        return Err("encrypted".into());
    }
    let compression = u16::from_be_bytes(header[..2].try_into().map_err(|_| invalid())?);
    if !matches!(compression, 1 | 2 | 17480) {
        return Err(invalid());
    }
    // EXTH 的长度属于文件输入，先约束到记录内，避免库按损坏长度分配内存。
    if u32_at(header, 128)? & 0x40 != 0 {
        let at = 16 + header_len;
        let size = u32_at(header, at + 4)?;
        let count = u32_at(header, at + 8)?;
        let end = at.checked_add(size).ok_or_else(invalid)?;
        if header.get(at..at + 4) != Some(b"EXTH")
            || size < 12
            || end > header.len()
            || count > (size - 12) / 8
        {
            return Err(invalid());
        }
        let mut cursor = at + 12;
        for _ in 0..count {
            let length = u32_at(header, cursor + 4)?;
            cursor = cursor.checked_add(length).ok_or_else(invalid)?;
            if length < 8 || cursor > end {
                return Err(invalid());
            }
        }
    }
    // 部分旧文件使用 232 字节头；库按 264 字节读固定字段，补齐元信息视图。
    let mut normalized = bytes.clone();
    if header_len < 264 {
        let padding = 264 - header_len;
        let first_offset = u32_at(&bytes, 78)?;
        let insert = first_offset + 16 + header_len;
        normalized.splice(insert..insert, std::iter::repeat_n(0, padding));
        let set = |data: &mut [u8], at: usize, value: usize| {
            data[at..at + 4].copy_from_slice(&(value as u32).to_be_bytes());
        };
        set(&mut normalized, first_offset + 20, 264);
        if name_at >= 16 + header_len {
            set(&mut normalized, first_offset + 84, name_at + padding);
        }
        for index in 1..raw.len() {
            let offset = u32_at(&bytes, 78 + index * 8)?;
            set(&mut normalized, 78 + index * 8, offset + padding);
        }
    }
    let book = mobi::Mobi::new(&normalized).map_err(|_| invalid())?;
    if book.encryption() != Encryption::No || book.metadata.mobi.drm_count > 0 {
        return Err("encrypted".into());
    }
    let count = book.metadata.palmdoc.record_count as usize;
    let sections = raw.get(1..count + 1).ok_or_else(invalid)?;
    let flags = if header_len >= 228 {
        u32_at(header, 240)? as u32
    } else {
        0
    };
    let mut text = Vec::new();
    match book.compression() {
        Compression::No | Compression::PalmDoc => {
            for section in sections {
                let data = text_record(section, flags)?;
                if book.compression() == Compression::PalmDoc {
                    text.extend(palmdoc(data)?);
                } else {
                    text.extend_from_slice(data);
                }
            }
        }
        Compression::Huff => {
            let start = book.metadata.mobi.first_huff_record as usize;
            let end = start
                .checked_add(book.metadata.mobi.huff_record_count as usize)
                .ok_or_else(invalid)?;
            let huffs = raw.get(start..end).ok_or_else(invalid)?;
            let sections = sections
                .iter()
                .map(|section| text_record(section, flags))
                .collect::<Result<Vec<_>, _>>()?;
            text = crate::mobi_huff::decompress(
                huffs,
                &sections,
                book.metadata.palmdoc.text_length as usize,
            )?;
        }
    }
    let length = book.metadata.palmdoc.text_length as usize;
    if text.len() < length {
        return Err(invalid());
    }
    text.truncate(length);
    let html = match book.text_encoding() {
        TextEncoding::UTF8 => String::from_utf8(text).map_err(|_| invalid())?,
        TextEncoding::CP1252 => encoding_rs::WINDOWS_1252
            .decode_without_bom_handling(&text)
            .0
            .into_owned(),
        _ => return Err(invalid()),
    };
    finish(&book, &raw, html)
}

fn finish(book: &mobi::Mobi, raw: &[&[u8]], html: String) -> Result<ParsedMobi, String> {
    let first = book.metadata.mobi.first_image_index as usize;
    let images: BTreeMap<_, _> = raw
        .iter()
        .enumerate()
        .skip(first)
        .filter_map(|(index, bytes)| image_url(bytes).map(|url| (index - first + 1, url)))
        .collect();
    let cover_index = book
        .metadata
        .exth
        .get_record(ExthRecord::CoverOffset)
        .and_then(|values| values.first())
        .and_then(|value| u32_at(value, 0).ok());
    let cover = cover_index
        .and_then(|offset| images.get(&(offset + 1)))
        .cloned();
    Ok(ParsedMobi {
        title: book.title(),
        author: book.author().unwrap_or_default(),
        intro: book.description(),
        html,
        images,
        cover,
    })
}

#[tauri::command]
pub async fn readerx_parse_mobi(data_base64: String) -> Result<ParsedMobi, String> {
    tauri::async_runtime::spawn_blocking(move || {
        readerx_source::panic_guard::catch_result("MOBI 解析", || {
            parse(B64.decode(data_base64).map_err(|_| invalid())?)
        })
        .map_err(|error| {
            if matches!(error.as_str(), "encrypted" | "unsupported") {
                error
            } else {
                invalid()
            }
        })
    })
    .await
    .map_err(|_| invalid())?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn set32(bytes: &mut [u8], at: usize, value: usize) {
        bytes[at..at + 4].copy_from_slice(&(value as u32).to_be_bytes());
    }
    fn fixture(compression: u16, sections: &[&[u8]], length: usize, images: &[&[u8]]) -> Vec<u8> {
        let title = "测试书".as_bytes();
        let mut first = vec![0; 16 + 264];
        first[..2].copy_from_slice(&compression.to_be_bytes());
        set32(&mut first, 4, length);
        first[8..10].copy_from_slice(&(sections.len() as u16).to_be_bytes());
        first[10..12].copy_from_slice(&4096u16.to_be_bytes());
        first[16..20].copy_from_slice(b"MOBI");
        set32(&mut first, 20, 264);
        set32(&mut first, 24, 2);
        set32(&mut first, 28, 65001);
        set32(&mut first, 36, 6);
        set32(&mut first, 80, sections.len() + 1);
        set32(&mut first, 84, 280);
        set32(&mut first, 88, title.len());
        set32(&mut first, 96, 6);
        set32(&mut first, 108, sections.len() + 1);
        set32(&mut first, 168, u32::MAX as usize);
        first.extend_from_slice(title);
        let count = 1 + sections.len() + images.len();
        let mut bytes = vec![0; 78 + count * 8 + 2];
        bytes[60..68].copy_from_slice(b"BOOKMOBI");
        bytes[76..78].copy_from_slice(&(count as u16).to_be_bytes());
        for (index, record) in std::iter::once(first.as_slice())
            .chain(sections.iter().copied())
            .chain(images.iter().copied())
            .enumerate()
        {
            let offset = bytes.len();
            set32(&mut bytes, 78 + index * 8, offset);
            bytes.extend_from_slice(record);
        }
        bytes
    }
    #[test]
    fn preserves_final_record_and_utf8_across_records() {
        let html = "<h1>第一章</h1><p>中文正文</p>";
        let bytes = html.as_bytes();
        let split = 5; // 第一个中文字符跨记录
        let parsed = parse(fixture(
            1,
            &[&bytes[..split], &bytes[split..]],
            bytes.len(),
            &[],
        ))
        .unwrap();
        assert_eq!(parsed.title, "测试书");
        assert_eq!(parsed.html, html);
    }
    #[test]
    fn palmdoc_import_and_overlapping_backreference() {
        let html = b"<p>Hello</p>";
        let parsed = parse(fixture(2, &[html], html.len(), &[])).unwrap();
        assert_eq!(parsed.html, "<p>Hello</p>");
        assert_eq!(palmdoc(&[b'a', 0x80, 0x0b]).unwrap(), b"aaaaaaa");
        assert!(palmdoc(&[0x80, 0]).is_err());
        assert!(palmdoc(&[8, 1]).is_err());
    }
    #[test]
    fn image_indices_do_not_shift_over_non_images() {
        let parsed = parse(fixture(
            1,
            &[b"<p>body</p>"],
            11,
            &[b"not an image", b"\x89PNG\r\n\x1a\nimage"],
        ))
        .unwrap();
        assert!(!parsed.images.contains_key(&1));
        assert!(parsed.images[&2].starts_with("data:image/png;base64,"));
    }
    #[test]
    fn rejects_damage_encryption_and_kf8() {
        assert_eq!(parse(vec![0; 100]).unwrap_err(), "invalid");
        let original = fixture(1, &[b"<p>body</p>"], 11, &[]);
        let first = u32_at(&original, 78).unwrap();
        let mut encrypted = original.clone();
        encrypted[first + 12..first + 14].copy_from_slice(&2u16.to_be_bytes());
        assert_eq!(parse(encrypted).unwrap_err(), "encrypted");
        let mut kf8 = original.clone();
        set32(&mut kf8, first + 36, 8);
        assert_eq!(parse(kf8).unwrap_err(), "unsupported");
        let mut damaged = original;
        set32(&mut damaged, 86, usize::MAX);
        assert_eq!(parse(damaged).unwrap_err(), "invalid");
    }
    #[test]
    fn strips_record_trailers() {
        assert_eq!(text_record(b"body\x01\x82", 2).unwrap(), b"body");
        assert_eq!(text_record(b"body\x00", 1).unwrap(), b"body");
        assert!(text_record(b"body\x7f", 2).is_err());
    }
    #[test]
    fn huff_dictionary_includes_last_record() {
        let html = b"<p>HUFF content</p>";
        let mut huff = vec![0; 24 + 1024 + 256];
        huff[..4].copy_from_slice(b"HUFF");
        set32(&mut huff, 4, 24);
        set32(&mut huff, 8, 24);
        set32(&mut huff, 12, 24 + 1024);
        for index in 0..256 {
            set32(&mut huff, 24 + index * 4, 0x88);
        }
        let mut cdic = vec![0; 20];
        cdic[..4].copy_from_slice(b"CDIC");
        set32(&mut cdic, 4, 16);
        set32(&mut cdic, 8, 1);
        cdic[16..18].copy_from_slice(&2u16.to_be_bytes());
        cdic[18..20].copy_from_slice(&(0x8000 | html.len() as u16).to_be_bytes());
        cdic.extend_from_slice(html);
        let mut bytes = fixture(17480, &[&[0]], html.len(), &[&huff, &cdic]);
        let first = u32_at(&bytes, 78).unwrap();
        set32(&mut bytes, first + 112, 2);
        set32(&mut bytes, first + 116, 2);
        assert_eq!(parse(bytes).unwrap().html.as_bytes(), html);
    }
    #[test]
    fn reads_short_legacy_header_and_windows1252() {
        let mut bytes = fixture(1, &[b"<p>caf\xe9</p>"], 11, &[]);
        let first = u32_at(&bytes, 78).unwrap();
        bytes.drain(first + 16 + 232..first + 16 + 264);
        let second = u32_at(&bytes, 86).unwrap();
        set32(&mut bytes, 86, second - 32);
        set32(&mut bytes, first + 20, 232);
        set32(&mut bytes, first + 84, 248);
        set32(&mut bytes, first + 28, 1252);
        assert_eq!(parse(bytes).unwrap().html, "<p>café</p>");
    }
    #[test]
    fn extracts_exth_metadata_and_cover() {
        let mut bytes = fixture(1, &[b"<p>body</p>"], 11, &[b"\x89PNG\r\n\x1a\nimage"]);
        let first = u32_at(&bytes, 78).unwrap();
        let mut exth = vec![0; 12];
        exth[..4].copy_from_slice(b"EXTH");
        let values: [(usize, &[u8]); 3] = [
            (100, "作者".as_bytes()),
            (103, b"description"),
            (201, &[0, 0, 0, 0]),
        ];
        for (kind, value) in values {
            exth.extend_from_slice(&(kind as u32).to_be_bytes());
            exth.extend_from_slice(&((value.len() + 8) as u32).to_be_bytes());
            exth.extend_from_slice(value);
        }
        let length = exth.len();
        set32(&mut exth, 4, length);
        set32(&mut exth, 8, 3);
        bytes.splice(first + 280..first + 280, exth);
        set32(&mut bytes, first + 84, 280 + length);
        set32(&mut bytes, first + 128, 0x40);
        for index in 1..3 {
            let offset = u32_at(&bytes, 78 + index * 8).unwrap();
            set32(&mut bytes, 78 + index * 8, offset + length);
        }
        let parsed = parse(bytes).unwrap();
        assert_eq!(parsed.author, "作者");
        assert_eq!(parsed.intro.as_deref(), Some("description"));
        assert_eq!(parsed.cover, parsed.images.get(&1).cloned());
    }
}
