//! Parse SQLite `EXPLAIN QUERY PLAN` rows (`id, parent, notused, detail`)
//! into a tagged tree. Unknown detail forms degrade to `OTHER` with the raw
//! text preserved — the parser never fails on unexpected output (plan §4).

use serde::{Deserialize, Serialize};

/// Input row. SQLite's `notused` column is dropped at the worker boundary.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RawPlanRow {
    pub id: i64,
    /// As reported by SQLite; 0 = root.
    pub parent: i64,
    pub detail: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Operation {
    Scan,
    Search,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryPlanNode {
    pub id: i64,
    pub parent_id: i64,
    pub operation: Operation,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub table: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub index: Option<String>,
    pub tags: Vec<String>,
    /// Raw SQLite text, always preserved.
    pub detail: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryPlan {
    pub nodes: Vec<QueryPlanNode>,
    pub raw: Vec<RawPlanRow>,
    pub sqlite_version: String,
}

/// Parse all rows into a plan tree, preserving input order.
pub fn parse_plan(rows: &[RawPlanRow], sqlite_version: &str) -> QueryPlan {
    QueryPlan {
        nodes: rows.iter().map(parse_node).collect(),
        raw: rows.to_vec(),
        sqlite_version: sqlite_version.to_string(),
    }
}

/// Parse a single EQP detail string. Never fails.
pub fn parse_node(row: &RawPlanRow) -> QueryPlanNode {
    let detail = row.detail.trim();
    let mut tags: Vec<String> = Vec::new();

    let (operation, table, index) = if let Some(rest) = strip_keyword(detail, "SCAN") {
        let (table, after) = first_token(rest);
        let index = parse_using(after, &mut tags);
        (Operation::Scan, sanitize_table(table), index)
    } else if let Some(rest) = strip_keyword(detail, "SEARCH") {
        let (table, after) = first_token(rest);
        let index = parse_using(after, &mut tags);
        (Operation::Search, sanitize_table(table), index)
    } else {
        (Operation::Other, None, None)
    };

    collect_common_tags(detail, &mut tags);

    QueryPlanNode {
        id: row.id,
        parent_id: row.parent,
        operation,
        table,
        index,
        tags,
        detail: detail.to_string(),
    }
}

/// If `s` starts with `kw` as a whole word (followed by whitespace or end),
/// return the remainder after it.
fn strip_keyword<'a>(s: &'a str, kw: &str) -> Option<&'a str> {
    let rest = s.strip_prefix(kw)?;
    if rest.is_empty() || rest.starts_with(char::is_whitespace) {
        Some(rest)
    } else {
        None
    }
}

/// Read the first token: a quoted identifier (`"…"`, `` `…` ``, `[…]`) or a
/// run of non-whitespace. Returns (token, remainder).
fn first_token(s: &str) -> (String, &str) {
    let s = s.trim_start();
    if s.is_empty() {
        return (String::new(), s);
    }
    let bytes = s.as_bytes();
    let (open, close): (u8, u8) = match bytes[0] {
        b'"' => (b'"', b'"'),
        b'`' => (b'`', b'`'),
        b'[' => (b'[', b']'),
        _ => {
            let end = s.find(char::is_whitespace).unwrap_or(s.len());
            return (s[..end].to_string(), &s[end..]);
        }
    };
    // ASCII delimiters: safe to search byte-wise.
    let mut i = 1;
    while i < bytes.len() {
        if bytes[i] == close {
            return (s[1..i].to_string(), &s[i + 1..]);
        }
        if bytes[i] == open && open != close {
            // Nested brackets in `[...]` are not a thing we need to support.
        }
        i += 1;
    }
    // Unterminated quote: take the rest as the token.
    (s[1..].to_string(), "")
}

/// Parse the `USING …` suffix of a SCAN/SEARCH detail (may be empty).
/// Pushes recognized tags; returns the index name if one is named.
fn parse_using(s: &str, tags: &mut Vec<String>) -> Option<String> {
    let s = s.trim_start();
    let Some(rest) = strip_keyword(s, "USING") else {
        return None;
    };
    let rest = rest.trim_start();

    // 3.54 can report "AUTOMATIC COVERING INDEX"; match the longer form first.
    if let Some(r) = strip_keyword(rest, "AUTOMATIC COVERING INDEX") {
        push_tag(tags, "AUTOMATIC INDEX");
        push_tag(tags, "COVERING INDEX");
        return automatic_index_name(r);
    }
    if let Some(r) = strip_keyword(rest, "COVERING INDEX") {
        push_tag(tags, "COVERING INDEX");
        return index_name(r);
    }
    if let Some(r) = strip_keyword(rest, "INDEX") {
        return index_name(r);
    }
    if let Some(r) = strip_keyword(rest, "AUTOMATIC INDEX") {
        push_tag(tags, "AUTOMATIC INDEX");
        return automatic_index_name(r);
    }
    if rest.starts_with("INTEGER PRIMARY KEY") {
        push_tag(tags, "INTEGER PRIMARY KEY");
    }
    None
}

/// Name of an automatic index, when SQLite reports one. Older builds use
/// `(i0 (a=?))`; 3.54 reports `(a=?)` with no name, so the name is optional.
fn automatic_index_name(s: &str) -> Option<String> {
    let inner = s.trim_start().strip_prefix('(')?;
    let (name, rest) = first_token(inner);
    if !name.is_empty() && rest.trim_start().starts_with('(') {
        Some(name)
    } else {
        None
    }
}

/// Index name after `INDEX`/`COVERING INDEX`, tolerating a trailing `(…)`.
fn index_name(s: &str) -> Option<String> {
    let (name, _) = first_token(s);
    let name = name.split('(').next().unwrap_or("").trim().to_string();
    if name.is_empty() {
        None
    } else {
        Some(name)
    }
}

/// Subquery pseudo-tables like `(subquery-1)` are not tables.
fn sanitize_table(table: String) -> Option<String> {
    let t = table.trim();
    if t.is_empty() || t.starts_with('(') {
        None
    } else {
        Some(t.to_string())
    }
}

/// Tags that can appear on any operation's detail text.
fn collect_common_tags(detail: &str, tags: &mut Vec<String>) {
    if detail.contains("TEMP B-TREE") {
        push_tag(tags, "TEMP B-TREE");
    }
    if detail.contains("CO-ROUTINE") {
        push_tag(tags, "CO-ROUTINE");
    }
    if detail.contains("MATERIALIZE") {
        push_tag(tags, "MATERIALIZE");
    }
    if detail.contains("BLOOM FILTER") {
        push_tag(tags, "BLOOM FILTER");
    }
}

fn push_tag(tags: &mut Vec<String>, tag: &str) {
    if !tags.iter().any(|t| t == tag) {
        tags.push(tag.to_string());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(id: i64, parent: i64, detail: &str) -> RawPlanRow {
        RawPlanRow {
            id,
            parent,
            detail: detail.to_string(),
        }
    }

    #[test]
    fn parses_table_scan() {
        let node = parse_node(&row(0, 0, "SCAN notes"));
        assert_eq!(node.operation, Operation::Scan);
        assert_eq!(node.table.as_deref(), Some("notes"));
        assert_eq!(node.index, None);
        assert!(node.tags.is_empty());
        assert_eq!(node.detail, "SCAN notes");
    }

    #[test]
    fn parses_covering_index_scan() {
        let node = parse_node(&row(2, 0, "SCAN notes USING COVERING INDEX idx_body"));
        assert_eq!(node.operation, Operation::Scan);
        assert_eq!(node.table.as_deref(), Some("notes"));
        assert_eq!(node.index.as_deref(), Some("idx_body"));
        assert_eq!(node.tags, vec!["COVERING INDEX"]);
    }

    #[test]
    fn parses_index_search() {
        let node = parse_node(&row(1, 0, "SEARCH notes USING INDEX idx_body (body=?)"));
        assert_eq!(node.operation, Operation::Search);
        assert_eq!(node.table.as_deref(), Some("notes"));
        assert_eq!(node.index.as_deref(), Some("idx_body"));
        assert!(!node.tags.iter().any(|t| t == "COVERING INDEX"));
    }

    #[test]
    fn parses_automatic_index_search() {
        let node = parse_node(&row(1, 0, "SEARCH t USING AUTOMATIC INDEX (i0 (a=?))"));
        assert_eq!(node.operation, Operation::Search);
        assert_eq!(node.index.as_deref(), Some("i0"));
        assert_eq!(node.tags, vec!["AUTOMATIC INDEX"]);
    }

    #[test]
    fn parses_automatic_covering_index_search_3_54() {
        let node = parse_node(&row(16, 0, "SEARCH b USING AUTOMATIC COVERING INDEX (y=?)"));
        assert_eq!(node.operation, Operation::Search);
        assert_eq!(node.table.as_deref(), Some("b"));
        assert_eq!(node.index, None);
        assert_eq!(node.tags, vec!["AUTOMATIC INDEX", "COVERING INDEX"]);
    }

    #[test]
    fn parses_automatic_index_without_name_3_54() {
        let node = parse_node(&row(16, 0, "SEARCH b USING AUTOMATIC INDEX (y=?)"));
        assert_eq!(node.operation, Operation::Search);
        assert_eq!(node.index, None);
        assert_eq!(node.tags, vec!["AUTOMATIC INDEX"]);
    }

    #[test]
    fn tags_bloom_filter() {
        let node = parse_node(&row(7, 0, "BLOOM FILTER ON b (y=?)"));
        assert_eq!(node.operation, Operation::Other);
        assert_eq!(node.tags, vec!["BLOOM FILTER"]);
    }

    #[test]
    fn parses_integer_primary_key_search() {
        let node = parse_node(&row(1, 0, "SEARCH t USING INTEGER PRIMARY KEY (rowid=?)"));
        assert_eq!(node.operation, Operation::Search);
        assert_eq!(node.index, None);
        assert_eq!(node.tags, vec!["INTEGER PRIMARY KEY"]);
    }

    #[test]
    fn parses_quoted_table_name() {
        let node = parse_node(&row(0, 0, r#"SCAN "my table""#));
        assert_eq!(node.table.as_deref(), Some("my table"));
    }

    #[test]
    fn temp_b_tree_tag_on_other() {
        let node = parse_node(&row(3, 0, "USE TEMP B-TREE FOR ORDER BY"));
        assert_eq!(node.operation, Operation::Other);
        assert_eq!(node.tags, vec!["TEMP B-TREE"]);
        assert_eq!(node.detail, "USE TEMP B-TREE FOR ORDER BY");
    }

    #[test]
    fn co_routine_and_materialize_tags() {
        let c = parse_node(&row(1, 0, "CO-ROUTINE (subquery-1)"));
        assert_eq!(c.tags, vec!["CO-ROUTINE"]);
        assert_eq!(c.operation, Operation::Other);

        let m = parse_node(&row(1, 0, "MATERIALIZE (subquery-2)"));
        assert_eq!(m.tags, vec!["MATERIALIZE"]);
    }

    #[test]
    fn unknown_detail_degrades_to_other_never_errors() {
        let node = parse_node(&row(9, 0, "SOMETHING WE NEVER SAW"));
        assert_eq!(node.operation, Operation::Other);
        assert_eq!(node.detail, "SOMETHING WE NEVER SAW");
        assert_eq!(node.table, None);
        assert_eq!(node.index, None);
    }

    #[test]
    fn subquery_pseudo_table_is_not_a_table() {
        let node = parse_node(&row(0, 0, "SCAN (subquery-1)"));
        assert_eq!(node.operation, Operation::Scan);
        assert_eq!(node.table, None);
    }

    #[test]
    fn parse_plan_preserves_order_and_raw_rows() {
        let rows = vec![row(0, 0, "SCAN a"), row(1, 0, "SEARCH b USING INDEX i (x=?)")];
        let plan = parse_plan(&rows, "3.54.1");
        assert_eq!(plan.nodes.len(), 2);
        assert_eq!(plan.nodes[0].id, 0);
        assert_eq!(plan.nodes[1].id, 1);
        assert_eq!(plan.raw, rows);
        assert_eq!(plan.sqlite_version, "3.54.1");
    }

    #[test]
    fn serializes_to_camel_case_json() {
        let plan = parse_plan(&[row(0, 0, "SCAN notes")], "3.54.1");
        let json = serde_json::to_string(&plan).unwrap();
        assert!(json.contains("\"parentId\":0"));
        assert!(json.contains("\"operation\":\"SCAN\""));
        assert!(json.contains("\"sqliteVersion\":\"3.54.1\""));
        // None fields are omitted, not null.
        assert!(!json.contains("\"table\":null"));
        assert!(!json.contains("\"index\":null"));
    }
}
