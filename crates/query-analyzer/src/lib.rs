//! SQLite query plan analysis toolkit (see ADR-002).
//!
//! Native code (`cargo test`) covers parsing and diffing; the `wasm_bindgen`
//! exports are the thin typed boundary called from the SQLite worker. App code
//! only ever talks to this crate through the TypeScript `PlanToolkit`
//! interface, so a TypeScript fallback can ship behind the same interface.

mod plan;
mod plan_diff;

pub use plan::{parse_node, parse_plan, Operation, QueryPlan, QueryPlanNode, RawPlanRow};
pub use plan_diff::{diff_plans, ChangedNode, PlanDiff};

use wasm_bindgen::prelude::*;

/// Parse raw `EXPLAIN QUERY PLAN` rows into a tagged plan tree.
#[wasm_bindgen(js_name = parsePlan)]
pub fn parse_plan_js(rows: JsValue, sqlite_version: String) -> Result<JsValue, JsValue> {
    let rows: Vec<RawPlanRow> = serde_wasm_bindgen::from_value(rows)
        .map_err(|e| JsValue::from_str(&format!("invalid plan rows: {e}")))?;
    let plan = plan::parse_plan(&rows, &sqlite_version);
    serde_wasm_bindgen::to_value(&plan)
        .map_err(|e| JsValue::from_str(&format!("failed to serialize plan: {e}")))
}

/// Compare two plan trees and produce a node-level diff.
#[wasm_bindgen(js_name = diffPlans)]
pub fn diff_plans_js(before: JsValue, after: JsValue) -> Result<JsValue, JsValue> {
    let before: QueryPlan = serde_wasm_bindgen::from_value(before)
        .map_err(|e| JsValue::from_str(&format!("invalid before plan: {e}")))?;
    let after: QueryPlan = serde_wasm_bindgen::from_value(after)
        .map_err(|e| JsValue::from_str(&format!("invalid after plan: {e}")))?;
    let diff = plan_diff::diff_plans(&before, &after);
    serde_wasm_bindgen::to_value(&diff)
        .map_err(|e| JsValue::from_str(&format!("failed to serialize diff: {e}")))
}

/// Identifies the active toolkit implementation in worker status (ADR-002 gate).
#[wasm_bindgen(js_name = toolkitVersion)]
pub fn toolkit_version() -> String {
    format!("rust/query-analyzer {}", env!("CARGO_PKG_VERSION"))
}
