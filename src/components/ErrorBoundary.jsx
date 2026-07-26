import React from 'react';

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, info) {
    // eslint-disable-next-line no-console
    console.error('Pane crashed:', error, info?.componentStack);
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null });
    if (this.props.onRetry) this.props.onRetry();
  };

  render() {
    if (this.state.hasError) {
      return (
        <div
          style={{
            margin: '20px 12px',
            padding: '20px 16px',
            borderRadius: 12,
            background: '#fef2f2',
            border: '1px solid #fecaca',
            textAlign: 'center',
          }}
        >
          <div style={{ fontSize: 28, marginBottom: 8 }}>⚠️</div>
          <div style={{ fontSize: 14, fontWeight: 800, color: '#991b1b', marginBottom: 4 }}>This page crashed</div>
          <div style={{ fontSize: 11, color: '#b91c1c', marginBottom: 14 }}>
            {this.state.error?.message || 'Unknown error'} — the rest of the app is unaffected.
          </div>
          <button
            onClick={this.handleRetry}
            style={{
              padding: '8px 18px',
              borderRadius: 8,
              border: 'none',
              background: '#dc2626',
              color: '#fff',
              fontWeight: 800,
              fontSize: 12,
              cursor: 'pointer',
            }}
          >
            ↻ Try Again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
