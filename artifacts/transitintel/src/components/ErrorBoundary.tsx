import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";

interface Props {
  children: ReactNode;
  /** Optional fallback UI. If omitted, a default card is rendered. */
  fallback?: ReactNode;
  /** Context label shown in the error card (e.g. "Dashboard", "Optimizer"). */
  context?: string;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

/**
 * Global React Error Boundary.
 *
 * Catches uncaught render errors and displays a user-friendly fallback.
 * In development it also logs to the console; in production it could
 * be wired to an error-reporting service (Sentry, etc.).
 */
export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Log to console (and eventually to Sentry / LogRocket / etc.)
    console.error(
      `[ErrorBoundary${this.props.context ? ` — ${this.props.context}` : ""}]`,
      error,
      info.componentStack,
    );
  }

  private handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (!this.state.hasError) return this.props.children;

    if (this.props.fallback) return this.props.fallback;

    return (
      <div className="flex items-center justify-center min-h-[40vh] p-6">
        <div className="max-w-md w-full bg-card border border-destructive/30 rounded-xl p-6 shadow-lg text-center space-y-4">
          <div className="flex justify-center">
            <AlertTriangle className="h-12 w-12 text-destructive" />
          </div>
          <h2 className="text-lg font-semibold text-foreground">
            {this.props.context
              ? `Errore in "${this.props.context}"`
              : "Si è verificato un errore"}
          </h2>
          <p className="text-sm text-muted-foreground">
            {this.state.error?.message || "Errore sconosciuto durante il rendering."}
          </p>
          <button
            onClick={this.handleReset}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors"
          >
            <RefreshCw className="h-4 w-4" />
            Riprova
          </button>
          {import.meta.env.DEV && this.state.error?.stack && (
            <details className="text-left mt-4">
              <summary className="text-xs text-muted-foreground cursor-pointer">
                Stack trace (dev only)
              </summary>
              <pre className="mt-2 text-xs bg-muted p-3 rounded overflow-auto max-h-40 whitespace-pre-wrap">
                {this.state.error.stack}
              </pre>
            </details>
          )}
        </div>
      </div>
    );
  }
}

export default ErrorBoundary;
