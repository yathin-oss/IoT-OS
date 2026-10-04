import { useUi } from '../../state/ui';
import { DevicesView } from '../views/DevicesView';
import { DriversView } from '../views/DriversView';
import { ExplorerView } from '../views/ExplorerView';
import { LibrariesView } from '../views/LibrariesView';
import { ProjectsView } from '../views/ProjectsView';
import { SearchView } from '../views/SearchView';
import { SettingsNav } from '../views/SettingsNav';
import { SimulatorSideView } from '../simulator/Palette';

export function SideBar() {
  const activity = useUi((s) => s.activity);
  switch (activity) {
    case 'explorer':
      return <ExplorerView />;
    case 'search':
      return <SearchView />;
    case 'projects':
      return <ProjectsView />;
    case 'simulator':
      return <SimulatorSideView />;
    case 'devices':
      return <DevicesView />;
    case 'libraries':
      return <LibrariesView />;
    case 'drivers':
      return <DriversView />;
    case 'settings':
      return <SettingsNav />;
  }
}
