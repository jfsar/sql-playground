/** PlanToolkit interface (plan §4) — the only way app code reaches plan logic. */

import type { PlanDiff, QueryPlan, RawPlanRow } from "../../shared/contracts";

export interface PlanToolkit {
  parsePlan(rows: RawPlanRow[], sqliteVersion: string): QueryPlan;
  diffPlans(before: QueryPlan, after: QueryPlan): PlanDiff;
}
