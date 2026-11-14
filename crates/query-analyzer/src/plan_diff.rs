//! Node-level diff between two query plans (plan comparison lite, plan §4).
//!
//! Nodes are matched by their SQLite EQP `id`, which is stable for the same
//! query text across runs. Added/removed/changed are reported in input order.

use std::collections::HashMap;

use serde::Serialize;

use crate::plan::{QueryPlan, QueryPlanNode};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedNode {
    pub before: QueryPlanNode,
    pub after: QueryPlanNode,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanDiff {
    pub added: Vec<QueryPlanNode>,
    pub removed: Vec<QueryPlanNode>,
    pub changed: Vec<ChangedNode>,
}

/// Compare two plans node-by-node. Never fails.
pub fn diff_plans(before: &QueryPlan, after: &QueryPlan) -> PlanDiff {
    let before_by_id: HashMap<i64, &QueryPlanNode> =
        before.nodes.iter().map(|n| (n.id, n)).collect();
    let after_by_id: HashMap<i64, &QueryPlanNode> = after.nodes.iter().map(|n| (n.id, n)).collect();

    let mut added = Vec::new();
    let mut removed = Vec::new();
    let mut changed = Vec::new();

    for node in &after.nodes {
        match before_by_id.get(&node.id) {
            None => added.push(node.clone()),
            Some(prev) => {
                if *prev != node {
                    changed.push(ChangedNode {
                        before: (*prev).clone(),
                        after: node.clone(),
                    });
                }
            }
        }
    }
    for node in &before.nodes {
        if !after_by_id.contains_key(&node.id) {
            removed.push(node.clone());
        }
    }

    PlanDiff {
        added,
        removed,
        changed,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plan::{parse_plan, RawPlanRow};

    fn row(id: i64, parent: i64, detail: &str) -> RawPlanRow {
        RawPlanRow {
            id,
            parent,
            detail: detail.to_string(),
        }
    }

    #[test]
    fn identical_plans_have_empty_diff() {
        let rows = vec![row(0, 0, "SCAN t")];
        let a = parse_plan(&rows, "3.54.1");
        let b = parse_plan(&rows, "3.54.1");
        let diff = diff_plans(&a, &b);
        assert!(diff.added.is_empty());
        assert!(diff.removed.is_empty());
        assert!(diff.changed.is_empty());
    }

    #[test]
    fn detects_scan_becoming_search() {
        let before = parse_plan(&[row(0, 0, "SCAN t")], "3.54.1");
        let after = parse_plan(
            &[row(0, 0, "SEARCH t USING INDEX idx_a (a=?)")],
            "3.54.1",
        );
        let diff = diff_plans(&before, &after);
        assert!(diff.added.is_empty());
        assert!(diff.removed.is_empty());
        assert_eq!(diff.changed.len(), 1);
        let c = &diff.changed[0];
        assert_eq!(c.before.operation, crate::plan::Operation::Scan);
        assert_eq!(c.after.operation, crate::plan::Operation::Search);
        assert_eq!(c.after.index.as_deref(), Some("idx_a"));
    }

    #[test]
    fn detects_added_and_removed_nodes() {
        let before = parse_plan(&[row(0, 0, "SCAN t"), row(1, 0, "CO-ROUTINE (subquery-1)")], "3.54.1");
        let after = parse_plan(&[row(0, 0, "SCAN t")], "3.54.1");
        let diff = diff_plans(&before, &after);
        assert_eq!(diff.removed.len(), 1);
        assert_eq!(diff.removed[0].id, 1);
        assert!(diff.added.is_empty());

        let diff_rev = diff_plans(&after, &before);
        assert_eq!(diff_rev.added.len(), 1);
        assert_eq!(diff_rev.added[0].id, 1);
        assert!(diff_rev.removed.is_empty());
    }

    #[test]
    fn serializes_changed_pairs_camel_case() {
        let before = parse_plan(&[row(0, 0, "SCAN t")], "3.54.1");
        let after = parse_plan(&[row(0, 0, "SEARCH t USING INDEX i (a=?)")], "3.54.1");
        let diff = diff_plans(&before, &after);
        let json = serde_json::to_string(&diff).unwrap();
        assert!(json.contains("\"changed\":[{\"before\":"));
        assert!(json.contains("\"after\":"));
    }
}
