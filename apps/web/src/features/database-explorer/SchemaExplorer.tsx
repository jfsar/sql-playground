import { useState } from "react";
import type { DatabaseInfo, DatabaseSchema, TableSchema } from "../../shared/contracts";
import { DEMO_QUERIES } from "../../services/database/sampleDatabase";

export interface SchemaExplorerProps {
  schema: DatabaseSchema | null;
  activeDatabase: DatabaseInfo | null;
  busy: boolean;
  error: string | null;
  onRefresh: () => void;
  onBrowse: (table: string) => void;
  onLoadQuery: (sql: string) => void;
}

function columnBadges(table: TableSchema, columnName: string): string[] {
  const column = table.columns.find((c) => c.name === columnName);
  if (!column) return [];
  const badges: string[] = [];
  if (column.primaryKey) badges.push("PK");
  if (column.notNull) badges.push("NOT NULL");
  if (column.defaultValue !== null) badges.push(`DEFAULT ${column.defaultValue}`);
  return badges;
}

function constraintLines(table: TableSchema): { key: string; text: string }[] {
  const lines: { key: string; text: string }[] = [];
  const primaryKey = table.columns
    .filter((column) => column.primaryKey)
    .sort((a, b) => a.primaryKeyOrder - b.primaryKeyOrder)
    .map((column) => column.name);
  if (primaryKey.length > 0) {
    lines.push({ key: "pk", text: `PRIMARY KEY (${primaryKey.join(", ")})` });
  }
  for (const column of table.columns) {
    if (column.notNull && !column.primaryKey) {
      lines.push({ key: `notnull-${column.name}`, text: `NOT NULL ${column.name}` });
    }
    if (column.defaultValue !== null) {
      lines.push({
        key: `default-${column.name}`,
        text: `DEFAULT ${column.name} = ${column.defaultValue}`,
      });
    }
  }
  for (const fk of table.foreignKeys) {
    const actions =
      fk.onDelete !== "NO ACTION" || fk.onUpdate !== "NO ACTION"
        ? ` · ON DELETE ${fk.onDelete} · ON UPDATE ${fk.onUpdate}`
        : "";
    lines.push({
      key: `fk-${fk.id}-${fk.from}`,
      text: `FOREIGN KEY ${fk.from} → ${fk.table}(${fk.to ?? "rowid"})${actions}`,
    });
  }
  for (const index of table.indexes) {
    if (index.origin === "u") {
      lines.push({
        key: `unique-${index.name}`,
        text: `UNIQUE (${index.columns.join(", ")})`,
      });
    }
  }
  for (const [i, check] of table.checkConstraints.entries()) {
    lines.push({ key: `check-${i}`, text: `CHECK ${check}` });
  }
  return lines;
}

function TableDetails({
  table,
  onBrowse,
}: {
  table: TableSchema;
  onBrowse: (table: string) => void;
}) {
  const constraints = constraintLines(table);
  return (
    <div
      data-testid={`schema-details-${table.name}`}
      className="mt-1 space-y-2 rounded border border-neutral-800 bg-neutral-950/70 p-2 text-[11px]"
    >
      <div>
        <div className="mb-1 font-medium text-neutral-400">Columns</div>
        <ul className="space-y-0.5">
          {table.columns.map((column) => (
            <li key={column.name} className="flex flex-wrap items-baseline gap-1">
              <span className="font-mono text-neutral-200">{column.name}</span>
              {column.declaredType ? (
                <span className="text-neutral-500">{column.declaredType}</span>
              ) : null}
              {columnBadges(table, column.name).map((badge) => (
                <span
                  key={badge}
                  className="rounded bg-neutral-800 px-1 text-[10px] text-neutral-400"
                >
                  {badge}
                </span>
              ))}
            </li>
          ))}
        </ul>
      </div>

      {table.type !== "view" ? (
        <div>
          <div className="mb-1 font-medium text-neutral-400">Constraints</div>
          {constraints.length === 0 ? (
            <div className="text-neutral-600">none</div>
          ) : (
            <ul className="space-y-0.5 text-amber-200/90">
              {constraints.map((constraint) => (
                <li key={constraint.key} data-testid={`schema-constraint-${constraint.key}`}>
                  {constraint.text}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}

      {table.type !== "view" ? (
        <div>
          <div className="mb-1 font-medium text-neutral-400">Indexes</div>
          {table.indexes.length === 0 ? (
            <div className="text-neutral-600">none</div>
          ) : (
            <ul className="space-y-0.5 text-emerald-200/90">
              {table.indexes.map((index) => (
                <li key={index.name} className="font-mono">
                  {index.name}
                  <span className="ml-1 font-sans text-neutral-500">
                    ({index.columns.join(", ")})
                  </span>
                  {index.unique ? (
                    <span className="ml-1 text-[10px] text-emerald-300">UNIQUE</span>
                  ) : null}
                  {index.partial ? (
                    <span className="ml-1 text-[10px] text-amber-300">PARTIAL</span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}

      <button
        type="button"
        data-testid={`browse-${table.name}`}
        onClick={() => onBrowse(table.name)}
        className="rounded bg-neutral-800 px-2 py-1 text-[11px] font-medium text-neutral-200 hover:bg-neutral-700"
      >
        Browse data
      </button>
    </div>
  );
}

function SchemaGroup({
  title,
  testId,
  items,
  expanded,
  onToggle,
  onBrowse,
}: {
  title: string;
  testId: string;
  items: TableSchema[];
  expanded: ReadonlySet<string>;
  onToggle: (name: string) => void;
  onBrowse: (table: string) => void;
}) {
  return (
    <div data-testid={testId}>
      <div className="px-1 py-1 text-[10px] font-semibold uppercase tracking-wide text-neutral-500">
        {title} · {items.length}
      </div>
      {items.length === 0 ? (
        <div className="px-1 pb-1 text-[11px] text-neutral-600">none</div>
      ) : (
        <ul className="space-y-0.5">
          {items.map((item) => {
            const isOpen = expanded.has(item.name);
            return (
              <li key={item.name}>
                <button
                  type="button"
                  data-testid={`schema-item-${item.name}`}
                  aria-expanded={isOpen}
                  onClick={() => onToggle(item.name)}
                  className="flex w-full items-center gap-1 rounded px-1 py-1 text-left text-xs text-neutral-200 hover:bg-neutral-900"
                >
                  <span className="w-3 text-neutral-500" aria-hidden="true">
                    {isOpen ? "▾" : "▸"}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono">{item.name}</span>
                  <span className="text-[10px] text-neutral-600">
                    {item.columns.length} col{item.columns.length === 1 ? "" : "s"}
                  </span>
                </button>
                {isOpen ? <TableDetails table={item} onBrowse={onBrowse} /> : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** Schema tree for the active database (plan §7 Week 5). */
export function SchemaExplorer({
  schema,
  activeDatabase,
  busy,
  error,
  onRefresh,
  onBrowse,
  onLoadQuery,
}: SchemaExplorerProps) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  const toggle = (name: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="schema-explorer">
      <div className="flex items-center justify-between border-y border-neutral-800 px-3 py-2">
        <span className="text-xs font-medium text-neutral-400">
          Schema
          {activeDatabase ? (
            <span className="ml-1 font-normal text-neutral-500">· {activeDatabase.name}</span>
          ) : null}
        </span>
        <button
          type="button"
          data-testid="refresh-schema"
          onClick={onRefresh}
          disabled={busy || !activeDatabase}
          className="rounded bg-neutral-800 px-2 py-1 text-[11px] font-medium text-neutral-200 hover:bg-neutral-700 disabled:opacity-40"
        >
          Refresh
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {error ? (
          <div
            data-testid="schema-error"
            className="mb-2 rounded border border-red-800 bg-red-950/40 p-2 text-[11px] text-red-300"
          >
            {error}
          </div>
        ) : null}
        {!activeDatabase ? (
          <p className="p-1 text-xs text-neutral-500">Open a database to inspect its schema.</p>
        ) : busy && !schema ? (
          <p className="p-1 text-xs text-neutral-500" data-testid="schema-loading">
            Reading schema…
          </p>
        ) : !schema ? (
          <p className="p-1 text-xs text-neutral-500">Schema unavailable.</p>
        ) : (
          <>
            <SchemaGroup
              title="Tables"
              testId="schema-tables"
              items={schema.tables}
              expanded={expanded}
              onToggle={toggle}
              onBrowse={onBrowse}
            />
            <div className="mt-3">
              <SchemaGroup
                title="Views"
                testId="schema-views"
                items={schema.views}
                expanded={expanded}
                onToggle={toggle}
                onBrowse={onBrowse}
              />
            </div>

            {activeDatabase.sample ? (
              <div className="mt-3 border-t border-neutral-800 pt-2" data-testid="demo-queries">
                <div className="px-1 py-1 text-[10px] font-semibold uppercase tracking-wide text-neutral-500">
                  Demo queries
                </div>
                <ul className="space-y-1">
                  {DEMO_QUERIES.map((query, index) => (
                    <li key={query.title}>
                      <button
                        type="button"
                        data-testid={`demo-query-${index}`}
                        title={query.description}
                        onClick={() => onLoadQuery(query.sql)}
                        className="w-full rounded px-1 py-1 text-left text-[11px] text-sky-300 hover:bg-neutral-900 hover:text-sky-200"
                      >
                        {query.title}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
