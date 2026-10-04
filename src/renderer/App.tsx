import { useEffect } from 'react';
import { handleGlobalKey } from './commands';
import { ActivityBar } from './components/shell/ActivityBar';
import { BottomPanel } from './components/shell/BottomPanel';
import { CommandPalette } from './components/shell/CommandPalette';
import { Dialogs } from './components/shell/Dialogs';
import { EditorArea } from './components/shell/EditorArea';
import { ErrorBoundary } from './components/shell/ErrorBoundary';
import { SideBar } from './components/shell/SideBar';
import { Splitter } from './components/shell/Splitter';
import { StatusBar } from './components/shell/StatusBar';
import { TitleBar } from './components/shell/TitleBar';
import { Toasts } from './components/shell/Toasts';
import { CopilotPanel } from './components/copilot/CopilotPanel';
import { useUi } from './state/ui';

export function App() {
  const { sidebarOpen, sidebarWidth, copilotOpen, copilotWidth, bottomOpen, bottomHeight, setLayout } = useUi();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (handleGlobalKey(e)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  return (
    <div className="app">
      <TitleBar />
      <div className="workbench">
        <ActivityBar />
        {sidebarOpen && (
          <>
            <div className="sidebar" style={{ width: sidebarWidth }}>
              <ErrorBoundary area="Side bar">
                <SideBar />
              </ErrorBoundary>
            </div>
            <Splitter direction="v" onDrag={(d) => setLayout({ sidebarWidth: Math.max(180, Math.min(560, sidebarWidth + d)) })} />
          </>
        )}
        <div className="center">
          <div className="editor-area">
            <ErrorBoundary area="Editor">
              <EditorArea />
            </ErrorBoundary>
          </div>
          {bottomOpen && (
            <>
              <Splitter direction="h" onDrag={(d) => setLayout({ bottomHeight: Math.max(120, Math.min(window.innerHeight - 200, bottomHeight - d)) })} />
              <div className="bottom" style={{ height: bottomHeight }}>
                <ErrorBoundary area="Panel">
                  <BottomPanel />
                </ErrorBoundary>
              </div>
            </>
          )}
        </div>
        {copilotOpen && (
          <>
            <Splitter direction="v" onDrag={(d) => setLayout({ copilotWidth: Math.max(280, Math.min(720, copilotWidth - d)) })} />
            <div className="right-panel" style={{ width: copilotWidth }}>
              <ErrorBoundary area="Copilot">
                <CopilotPanel />
              </ErrorBoundary>
            </div>
          </>
        )}
      </div>
      <StatusBar />
      <CommandPalette />
      <Dialogs />
      <Toasts />
    </div>
  );
}
