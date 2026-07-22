import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props { children: ReactNode }
interface State { error: Error | null }

export class AppErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State { return { error }; }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[EngramView] Rendering failed", error, info);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <main className="flex min-h-screen items-center justify-center bg-background p-6 text-foreground">
        <section className="max-w-lg rounded-2xl border bg-card p-6 shadow-sm" role="alert">
          <h1 className="text-xl font-semibold">EngramView could not start</h1>
          <p className="mt-2 text-sm text-muted-foreground">The interface encountered an unexpected error. Restart the app and try again.</p>
          {import.meta.env.DEV ? (
            <pre className="mt-4 max-h-40 overflow-auto whitespace-pre-wrap rounded-lg bg-muted p-3 text-xs">{this.state.error.message}</pre>
          ) : null}
        </section>
      </main>
    );
  }
}
