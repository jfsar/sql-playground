import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BackupReminder } from "./BackupReminder";

afterEach(cleanup);

describe("BackupReminder", () => {
  it("stays hidden when no reminder is due", () => {
    render(
      <BackupReminder
        status={{
          lastBackupAt: 100,
          due: false,
          reason: null,
          show: false,
          dismissedAt: null,
        }}
        onExport={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("backup-reminder")).toBeNull();
  });

  it("offers export and dismiss for a due reminder", () => {
    const onExport = vi.fn();
    const onDismiss = vi.fn();
    render(
      <BackupReminder
        status={{
          lastBackupAt: null,
          due: true,
          reason: "never",
          show: true,
          dismissedAt: null,
        }}
        onExport={onExport}
        onDismiss={onDismiss}
      />,
    );

    expect(screen.getByTestId("backup-reminder").textContent).toContain("No backup yet");
    fireEvent.click(screen.getByTestId("backup-now"));
    fireEvent.click(screen.getByTestId("backup-dismiss"));
    expect(onExport).toHaveBeenCalledOnce();
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
