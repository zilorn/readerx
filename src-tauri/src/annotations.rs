//! 注释的段落聚合与逐条差集；磁盘与同步均按 note id 保留独立记录。
use serde_json::{json, Value};
use std::collections::BTreeMap;

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Note {
    pub anchor: Value,
    pub value: Value,
    pub paragraph_id: String,
}

pub(crate) fn same_paragraph(a: &Value, b: &Value) -> bool {
    ["chapterCid", "unitIndex", "fingerprint"]
        .iter()
        .all(|key| a.get(key) == b.get(key))
}

pub(crate) fn flatten(records: &[Value]) -> Result<BTreeMap<String, Note>, String> {
    let mut result = BTreeMap::new();
    for record in records {
        let id = record
            .get("id")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .ok_or("注释段落身份无效")?;
        let cid = record
            .get("chapterCid")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .ok_or("注释章节无效")?;
        let unit = record
            .get("unitIndex")
            .and_then(Value::as_u64)
            .ok_or("注释位置无效")?;
        let fingerprint = record
            .get("fingerprint")
            .and_then(Value::as_str)
            .filter(|s| {
                s.len() == 64
                    && s.bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            })
            .ok_or("注释指纹无效")?;
        let before = record
            .get("before")
            .and_then(Value::as_str)
            .ok_or("注释上下文无效")?;
        let after = record
            .get("after")
            .and_then(Value::as_str)
            .ok_or("注释上下文无效")?;
        let anchor = json!({"chapterCid": cid, "unitIndex": unit, "fingerprint": fingerprint, "before": before, "after": after});
        for value in record
            .get("notes")
            .and_then(Value::as_array)
            .ok_or("注释列表无效")?
        {
            let note_id = value
                .get("id")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .ok_or("注释身份无效")?;
            let text = value
                .get("text")
                .and_then(Value::as_str)
                .ok_or("注释内容无效")?;
            if text.trim().is_empty()
                || text.encode_utf16().count() > 2000
                || !["createdAt", "updatedAt"]
                    .iter()
                    .all(|k| value.get(k).and_then(Value::as_u64).is_some())
            {
                return Err("注释内容或时间无效".into());
            }
            if result
                .insert(
                    note_id.to_owned(),
                    Note {
                        anchor: anchor.clone(),
                        value: value.clone(),
                        paragraph_id: id.to_owned(),
                    },
                )
                .is_some()
            {
                return Err("注释身份重复".into());
            }
        }
    }
    Ok(result)
}

/// 只应用变过的 note，不能把快照缺少的远端注释当作删除。
pub(crate) fn changed(
    previous: &[Value],
    next: &[Value],
) -> Result<BTreeMap<String, Note>, String> {
    let before = flatten(previous)?;
    Ok(flatten(next)?
        .into_iter()
        .filter(|(id, note)| {
            before
                .get(id)
                .is_none_or(|old| old.anchor != note.anchor || old.value != note.value)
        })
        .collect())
}

pub(crate) fn upsert(records: &mut Vec<Value>, note: &Note) {
    let id = note.value["id"].as_str().unwrap();
    for record in records.iter_mut() {
        if let Some(notes) = record.get_mut("notes").and_then(Value::as_array_mut) {
            notes.retain(|value| value.get("id").and_then(Value::as_str) != Some(id));
        }
    }
    let target = records
        .iter()
        .position(|record| same_paragraph(record, &note.anchor));
    if let Some(i) = target {
        let record = records[i].as_object_mut().unwrap();
        record.extend(note.anchor.as_object().unwrap().clone());
        record
            .get_mut("notes")
            .unwrap()
            .as_array_mut()
            .unwrap()
            .push(note.value.clone());
    } else {
        let mut record = note.anchor.clone();
        record["id"] = json!(note.paragraph_id);
        record["notes"] = json!([note.value]);
        records.push(record);
    }
    records.retain(|record| {
        record["notes"]
            .as_array()
            .is_some_and(|notes| !notes.is_empty())
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    fn record(paragraph: &str, id: &str, text: &str) -> Value {
        json!({"id": paragraph, "chapterCid": "c1", "unitIndex": 1,
            "fingerprint": "a".repeat(64), "before": "", "after": "",
            "notes": [{"id": id, "text": text, "createdAt": 1, "updatedAt": 2}]})
    }
    #[test]
    fn delta_preserves_remote_notes_and_ignores_paragraph_identity() {
        let previous = vec![record("local", "n1", "旧内容")];
        let next = vec![record("folded", "n1", "旧内容")];
        assert!(changed(&previous, &next).unwrap().is_empty());
        let next = vec![record("local", "n1", "修改")];
        let delta = changed(&previous, &next).unwrap();
        let mut disk = vec![record("remote", "n2", "远端新增")];
        for note in delta.values() {
            upsert(&mut disk, note);
        }
        assert_eq!(disk.len(), 1);
        assert_eq!(disk[0]["notes"].as_array().unwrap().len(), 2);
        assert_eq!(disk[0]["id"], "remote");
    }
    #[test]
    fn malformed_snapshot_and_duplicate_notes_are_rejected() {
        let good = record("p", "n", "内容");
        assert!(flatten(&[good.clone(), good]).is_err());
        let mut bad = record("p", "n", " ");
        assert!(flatten(&[bad.clone()]).is_err());
        bad["notes"][0]["text"] = json!("x".repeat(2001));
        assert!(flatten(&[bad]).is_err());
    }
}
