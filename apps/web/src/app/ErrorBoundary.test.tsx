import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "./ErrorBoundary";

function Boom(): never {
  throw new Error("kaboom");
}

function Flaky({ shouldThrow }: { shouldThrow: boolean }) {
  if (shouldThrow) throw new Error("flaky boom");
  return <div data-testid="child-ok">child rendered</div>;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ErrorBoundary", () => {
  it("catches a render error and shows recovery actions", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );

    const boundary = screen.getByTestId("error-boundary");
    expect(boundary).not.toBeNull();
    expect(boundary.getAttribute("role")).toBe("alert");
    expect(boundary.textContent).toContain("kaboom");
    // Reassurance: data lives in storage, not in the crashed render tree.
    expect(boundary.textContent).toContain("not affected");
    expect(screen.getByTestId("error-boundary-reload")).not.toBeNull();
    expect(screen.getByTestId("error-boundary-dismiss")).not.toBeNull();
  });

  it("renders children normally when nothing throws", () => {
    render(
      <ErrorBoundary>
        <Flaky shouldThrow={false} />
      </ErrorBoundary>,
    );

    expect(screen.getByTestId("child-ok")).not.toBeNull();
    expect(screen.queryByTestId("error-boundary")).toBeNull();
  });

  it("dismiss clears the error and re-renders the children", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    const { rerender } = render(
      <ErrorBoundary>
        <Flaky shouldThrow />
      </ErrorBoundary>,
    );
    expect(screen.getByTestId("error-boundary")).not.toBeNull();

    // Fix the child first; the boundary keeps showing the caught error until
    // dismissed (it does not silently re-render a previously failed tree).
    rerender(
      <ErrorBoundary>
        <Flaky shouldThrow={false} />
      </ErrorBoundary>,
    );
    expect(screen.getByTestId("error-boundary")).not.toBeNull();

    fireEvent.click(screen.getByTestId("error-boundary-dismiss"));

    expect(screen.queryByTestId("error-boundary")).toBeNull();
    expect(screen.getByTestId("child-ok")).not.toBeNull();
  });
});
