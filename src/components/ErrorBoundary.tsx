import React from 'react';

interface ErrorBoundaryState {
  error: Error | null;
}

/** 捕获渲染期异常，避免整页白屏，展示错误详情便于排查 */
export class ErrorBoundary extends React.Component<React.PropsWithChildren, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('Render crash caught by ErrorBoundary:', error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="min-h-screen bg-[#F5F5F5] flex items-center justify-center p-6">
          <div className="max-w-2xl w-full bg-white rounded-3xl p-8 shadow-sm border border-red-100 space-y-4">
            <h1 className="text-xl font-bold text-red-600">页面渲染出错</h1>
            <p className="text-sm text-black/60">
              分析数据中可能包含了非预期的结构。已捕获错误，分析结果仍在内存中——点击下方按钮尝试恢复，或刷新页面重新分析。
            </p>
            <pre className="p-4 bg-red-50 border border-red-100 rounded-xl text-xs text-red-800 overflow-auto max-h-48 whitespace-pre-wrap">
              {this.state.error.message}
              {'\n'}
              {this.state.error.stack?.split('\n').slice(1, 5).join('\n')}
            </pre>
            <div className="flex gap-3">
              <button
                onClick={() => this.setState({ error: null })}
                className="px-4 py-2 bg-black text-white rounded-xl text-sm font-bold hover:bg-black/80 transition-all"
              >
                尝试恢复
              </button>
              <button
                onClick={() => window.location.reload()}
                className="px-4 py-2 bg-black/5 text-black/60 rounded-xl text-sm font-bold hover:bg-black/10 transition-all"
              >
                刷新页面
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
