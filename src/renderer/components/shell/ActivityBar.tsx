import { CircuitBoard, Cpu, FolderTree, LayoutGrid, Library, Search, Settings, Usb } from 'lucide-react';
import type { ReactNode } from 'react';
import { useDevices } from '../../state/runtime';
import { useUi, type ActivityId } from '../../state/ui';

const ITEMS: { id: ActivityId; label: string; icon: ReactNode }[] = [
  { id: 'explorer', label: 'Explorer', icon: <FolderTree size={20} /> },
  { id: 'search', label: 'Search', icon: <Search size={20} /> },
  { id: 'projects', label: 'Projects', icon: <LayoutGrid size={20} /> },
  { id: 'simulator', label: 'Simulator', icon: <CircuitBoard size={20} /> },
  { id: 'devices', label: 'Devices', icon: <Cpu size={20} /> },
  { id: 'libraries', label: 'Libraries', icon: <Library size={20} /> },
  { id: 'drivers', label: 'Drivers', icon: <Usb size={20} /> },
];

export function ActivityBar() {
  const { activity, sidebarOpen, setActivity } = useUi();
  const connected = useDevices((s) => s.devices.filter((d) => d.state === 'CONNECTED').length);
  const driverIssues = useDevices((s) => s.devices.filter((d) => d.state === 'DRIVER_MISSING').length);
  return (
    <div className="activitybar">
      {ITEMS.map((it) => (
        <button key={it.id} className={`act${activity === it.id && sidebarOpen ? ' active' : ''}`} title={it.label} aria-label={it.label} onClick={() => setActivity(it.id)} data-testid={`activity-${it.id}`}>
          {it.icon}
          {it.id === 'devices' && connected > 0 && <span className="dot">{connected}</span>}
          {it.id === 'drivers' && driverIssues > 0 && <span className="dot" style={{ background: 'var(--err)' }}>{driverIssues}</span>}
        </button>
      ))}
      <div className="spacer" />
      <button className={`act${activity === 'settings' && sidebarOpen ? ' active' : ''}`} title="Settings" aria-label="Settings" onClick={() => setActivity('settings')}>
        <Settings size={20} />
      </button>
    </div>
  );
}
