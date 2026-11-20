import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Top-level error boundary (plan §7 Week 3): a render failure shows a
 * recovery screen instead of a blank page. Databases live in browser storage,
 * so the message reassures the user their data is unaffected.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("Unhandled UI error:", error, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div
        role="alert"
        data-testid="error-boundary"
        className="flex min-h-screen flex-col items-center justify-center gap-4 bg-neutral-950 px-6 text-center text-neutral-100"
      >
        <h1 className="text-lg font-semibold">Something went wrong in the interface</h1>
        <p className="max-w-md text-sm text-red-300">{error.message}</p>
        <p className="max-w-md text-sm text-neutral-400">
          Your databases are stored in the browser and were not affected. You can dismiss this
          message to keep working, or reload the app.
        </p>
        <div className="flex gap-3">
          <button
            type="button"
            data-testid="error-boundary-dismiss"
            onClick={() => this.setState({ error: null })}
            className="rounded bg-neutral-700 px-4 py-2 font-medium text-neutral-100 hover:bg-neutral-600"
          >
            Dismiss
          </button>
          <button
            type="button"
            data-testid="error-boundary-reload"
            onClick={() => window.location.reload()}
            className="rounded bg-sky-800 px-4 py-2 font-medium text-white hover:bg-sky-700"
          >
            Reload the app
          </button>
        </div>
      </div>
    );
  }
}
