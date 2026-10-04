import { useUi } from '../../state/ui';

const SECTIONS = [
  ['ai', 'AI provider'],
  ['toolchains', 'Toolchains'],
  ['serial', 'Serial'],
  ['editor', 'Editor'],
  ['general', 'General'],
  ['about', 'About & diagnostics'],
] as const;

export function SettingsNav() {
  const ui = useUi();
  return (
    <>
      <div className="sidebar-head">Settings</div>
      <div className="sidebar-body">
        {SECTIONS.map(([id, label]) => (
          <div
            key={id}
            className="list-row click"
            onClick={() => {
              ui.openTab({ id: 'settings', kind: 'settings', title: 'Settings' });
              setTimeout(() => document.getElementById(`settings-${id}`)?.scrollIntoView({ behavior: 'smooth' }), 30);
            }}
          >
            {label}
          </div>
        ))}
        <div className="divider" />
        <div className="list-row click" onClick={() => ui.openTab({ id: 'setup', kind: 'setup', title: 'Setup' })}>
          Environment setup check
        </div>
      </div>
    </>
  );
}
