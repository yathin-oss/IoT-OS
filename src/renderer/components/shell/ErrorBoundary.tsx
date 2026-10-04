import { Component, type ErrorInfo, type ReactNode } from 'react';

/** Keeps a crashing area from taking down the whole IDE. */
export class ErrorBoundary extends Component<{ area: string; children: ReactNode }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[${this.props.area}] render error`, error, info.componentStack);
  }

  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="empty selectable">
        <h4>{this.props.area} crashed</h4>
        <p className="mono sev-error">{this.state.error.message}</p>
        <button className="btn sm" onClick={() => this.setState({ error: null })}>
          Reload {this.props.area.toLowerCase()}
        </button>
      </div>
    );
  }
}
