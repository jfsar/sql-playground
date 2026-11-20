import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { EnvironmentGate } from "./EnvironmentGate";

afterEach(cleanup);

const supported = {
  webAssembly: true,
  worker: true,
  indexedDb: true,
  opfs: true,
  webLocks: true,
};

describe("EnvironmentGate", () => {
  it("renders the workspace for a supported desktop browser", () => {
    render(
      <EnvironmentGate capabilities={supported} width={1280}>
        <p>workspace</p>
      </EnvironmentGate>,
    );
    expect(screen.getByText("workspace")).toBeTruthy();
    expect(screen.queryByTestId("viewport-notice")).toBeNull();
    expect(screen.queryByTestId("unsupported-browser")).toBeNull();
  });

  it("blocks an unsupported browser and names the missing capabilities", () => {
    render(
      <EnvironmentGate capabilities={{ ...supported, worker: false }} width={1280}>
        <p>workspace</p>
      </EnvironmentGate>,
    );
    expect(screen.getByTestId("unsupported-browser")).toBeTruthy();
    expect(screen.getByText("Web Workers")).toBeTruthy();
    expect(screen.queryByText("workspace")).toBeNull();
  });

  it("shows the tablet notice between 768 and 1023 px", () => {
    render(
      <EnvironmentGate capabilities={supported} width={900}>
        <p>workspace</p>
      </EnvironmentGate>,
    );
    expect(screen.getByTestId("viewport-notice")).toBeTruthy();
    expect(screen.getByText("workspace")).toBeTruthy();
  });

  it("blocks phone-sized viewports", () => {
    render(
      <EnvironmentGate capabilities={supported} width={375}>
        <p>workspace</p>
      </EnvironmentGate>,
    );
    expect(screen.getByTestId("unsupported-viewport")).toBeTruthy();
    expect(screen.queryByText("workspace")).toBeNull();
  });
});
