import { Bot, Hammer, PanelBottom, PanelLeft, PanelRight, Search, Square, Upload } from 'lucide-react';
import { displayKeys, runCommand } from '../../commands';
import { useProject } from '../../state/project';
import { useBuild, useDevices } from '../../state/runtime';
import { useUi } from '../../state/ui';

export function TitleBar() {
  const snapshot = useProject((s) => s.snapshot);
  const { running, flashing } = useBuild();
  const port = useDevices((s) => s.selectedPort);
  const ui = useUi();
  return (
    <div className="titlebar">
      <div className="brand">
        <div className="logo">io</div>
        <span>IoT-OS</span>
        {snapshot && <span className="muted">— {snapshot.manifest.name}</span>}
      </div>
      <div className="search" onClick={() => ui.setPalette(true)} title="Command palette">
        <Search size={13} />
        <span>Search commands, build, upload…</span>
        <span className="spacer" />
        <span className="kbd">{displayKeys('Mod+Shift+P')}</span>
      </div>
      <div className="actions">
        {snapshot && (
          <>
            {running || flashing ? (
              <button className="btn sm" onClick={() => runCommand('build.cancel')} title="Cancel">
                <Square size={12} /> Cancel
              </button>
            ) : (
              <>
                <button className="btn sm" onClick={() => runCommand('build.run')} title={`Build (${displayKeys('Mod+Shift+B')})`} data-testid="build-button">
                  <Hammer size={13} /> Build
                </button>
                <button className="btn sm" onClick={() => runCommand('build.upload')} disabled={!port} title={port ? `Upload to ${port}` : 'Connect a board to upload'}>
                  <Upload size={13} /> Upload
                </button>
              </>
            )}
          </>
        )}
        <button className={`icon-btn${ui.sidebarOpen ? ' active' : ''}`} onClick={() => runCommand('view.sidebar')} title="Toggle side bar">
          <PanelLeft size={15} />
        </button>
        <button className={`icon-btn${ui.bottomOpen ? ' active' : ''}`} onClick={() => runCommand('view.panel')} title="Toggle panel">
          <PanelBottom size={15} />
        </button>
        <button className={`icon-btn${ui.copilotOpen ? ' active' : ''}`} onClick={() => runCommand('view.copilot')} title="Toggle Copilot">
          <PanelRight size={15} />
        </button>
        <button className="icon-btn" onClick={() => runCommand('ai.ask')} title="Ask Copilot">
          <Bot size={15} />
        </button>
      </div>
    </div>
  );
}
