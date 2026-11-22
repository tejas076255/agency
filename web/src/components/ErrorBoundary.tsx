import { Component, type ErrorInfo, type ReactNode } from 'react';

type Props = {
  children: ReactNode;
  /** Changing this value clears the error (e.g. the route path). */ resetKey?: string;
};
type State = { error: Error | null };

/** Shows a friendly message instead of a blank page if a screen crashes while rendering. */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Screen crashed', error, info.componentStack);
  }

  override componentDidUpdate(prev: Props) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="mx-auto max-w-lg p-6">
        <div
          className="rounded-xl border border-red-200 bg-red-50 p-5 text-sm text-red-800"
          role="alert"
        >
          <h2 className="text-base font-semibold">Something went wrong on this page</h2>
          <p className="mt-1">
            The page could not be displayed. Your data is safe. Try reloading; if it keeps
            happening, send a screenshot of this message.
          </p>
          <p className="mt-2 break-all font-mono text-xs text-red-700">
            {this.state.error.message}
          </p>
          <button
            className="mt-4 rounded-lg bg-red-600 px-4 py-2 font-medium text-white hover:bg-red-700"
            onClick={() => window.location.reload()}
          >
            Reload page
          </button>
        </div>
      </div>
    );
  }
}
