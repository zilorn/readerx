//! HUFF/CDIC 解码：不调用第三方库会打印正文的解压入口。
use super::mobi::{invalid, u32_at};

type Result<T> = std::result::Result<T, String>;
struct Decoder {
    cache: [(usize, bool, u32); 256],
    min: [u32; 33],
    max: [u32; 33],
    phrases: Vec<Option<(Vec<u8>, bool)>>,
    limit: usize,
}
impl Decoder {
    fn new(records: &[&[u8]], limit: usize) -> Result<Self> {
        let huff = records.first().ok_or_else(invalid)?;
        if huff.get(..4) != Some(b"HUFF") || u32_at(huff, 4)? != 24 {
            return Err(invalid());
        }
        let cache_at = u32_at(huff, 8)?;
        let base_at = u32_at(huff, 12)?;
        let mut decoder = Self {
            cache: [(0, false, 0); 256],
            min: [0; 33],
            max: [0; 33],
            phrases: Vec::new(),
            limit,
        };
        for index in 0..256 {
            let value = u32_at(huff, cache_at + index * 4)? as u32;
            let length = (value & 31) as usize;
            let terminal = value & 128 != 0;
            if length == 0 || (length <= 8 && !terminal) {
                return Err(invalid());
            }
            let max = (((value >> 8) as u64 + 1) << (32 - length))
                .checked_sub(1)
                .ok_or_else(invalid)?;
            decoder.cache[index] = (length, terminal, u32::try_from(max).map_err(|_| invalid())?);
        }
        for length in 1..=32 {
            let min = (u32_at(huff, base_at + (length - 1) * 8)? as u64) << (32 - length);
            let max =
                ((u32_at(huff, base_at + (length - 1) * 8 + 4)? as u64 + 1) << (32 - length)) - 1;
            decoder.min[length] = u32::try_from(min).map_err(|_| invalid())?;
            decoder.max[length] = u32::try_from(max).map_err(|_| invalid())?;
        }
        for cdic in &records[1..] {
            if cdic.get(..4) != Some(b"CDIC") || u32_at(cdic, 4)? != 16 {
                return Err(invalid());
            }
            let total = u32_at(cdic, 8)?;
            let bits = u32_at(cdic, 12)?;
            if bits > 16 || total < decoder.phrases.len() {
                return Err(invalid());
            }
            let count = (1usize << bits).min(total - decoder.phrases.len());
            for index in 0..count {
                let pair = cdic
                    .get(16 + index * 2..18 + index * 2)
                    .ok_or_else(invalid)?;
                let at = 16 + u16::from_be_bytes([pair[0], pair[1]]) as usize;
                let pair = cdic.get(at..at + 2).ok_or_else(invalid)?;
                let size = u16::from_be_bytes([pair[0], pair[1]]);
                let bytes = cdic
                    .get(at + 2..at + 2 + (size & 0x7fff) as usize)
                    .ok_or_else(invalid)?;
                decoder
                    .phrases
                    .push(Some((bytes.to_vec(), size & 0x8000 != 0)));
            }
        }
        Ok(decoder)
    }
    fn unpack(&mut self, bytes: &[u8], depth: usize) -> Result<Vec<u8>> {
        if depth > 64 {
            return Err(invalid());
        }
        let mut output = Vec::new();
        let mut bit = 0;
        while bit < bytes.len() * 8 {
            // 32 位前瞻，尾部补零；只消费实际存在的完整代码。
            let byte = bit / 8;
            let mut window = 0u64;
            for index in 0..5 {
                window = (window << 8) | bytes.get(byte + index).copied().unwrap_or(0) as u64;
            }
            let code = (window >> (8 - bit % 8)) as u32;
            let (mut length, terminal, mut max) = self.cache[(code >> 24) as usize];
            if !terminal {
                while length <= 32 && code < self.min[length] {
                    length += 1;
                }
                if length > 32 {
                    return Err(invalid());
                }
                max = self.max[length];
            }
            if length > bytes.len() * 8 - bit {
                break;
            }
            let index = (max.checked_sub(code).ok_or_else(invalid)? >> (32 - length)) as usize;
            // 暂时取出该短语，同时阻止循环引用。
            let (mut phrase, literal) = self
                .phrases
                .get_mut(index)
                .ok_or_else(invalid)?
                .take()
                .ok_or_else(invalid)?;
            if !literal {
                phrase = self.unpack(&phrase, depth + 1)?;
            }
            if output
                .len()
                .checked_add(phrase.len())
                .is_none_or(|size| size > self.limit)
            {
                return Err(invalid());
            }
            output.extend_from_slice(&phrase);
            self.phrases[index] = Some((phrase, true));
            bit += length;
        }
        Ok(output)
    }
}
pub(super) fn decompress(records: &[&[u8]], sections: &[&[u8]], length: usize) -> Result<Vec<u8>> {
    let mut decoder = Decoder::new(records, length)?;
    let mut bytes = Vec::new();
    for section in sections {
        let part = decoder.unpack(section, 0)?;
        if bytes
            .len()
            .checked_add(part.len())
            .is_none_or(|size| size > length)
        {
            return Err(invalid());
        }
        bytes.extend(part);
    }
    Ok(bytes)
}
