import { Component, type ReactNode } from 'react'

interface Props {
  children: ReactNode
  fallback?: ReactNode
}

interface State {
  hasError: boolean
  error: Error | null
}

export default class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('ErrorBoundary caught:', error, errorInfo)
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback
      return (
        <div className="panel-bg border border-zred/30 rounded-lg p-8 text-center animate-fade-in">
          <div className="text-zred text-sm font-medium mb-2">Something went wrong</div>
          <div className="text-xs text-ztextdim mb-4 max-w-md mx-auto">
            {this.state.error?.message || 'An unexpected error occurred'}
          </div>
          <button
            onClick={() => this.setState({ hasError: false, error: null })}
            className="px-4 py-1.5 text-xs rounded bg-zcyan/20 text-zcyan border border-zcyan hover:bg-zcyan/30 transition-all duration-200"
          >
            Try Again
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
