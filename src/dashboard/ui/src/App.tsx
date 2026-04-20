import { ViewModeProvider, useViewMode } from './context/ViewMode';
import SimpleView from './components/SimpleView';
import AdvancedView from './components/AdvancedView';

/** Renders the correct view based on the current ViewMode. */
function AppShell() {
  const { mode } = useViewMode();
  return mode === 'simple' ? <SimpleView /> : <AdvancedView />;
}

/** Root application component. Wraps the tree with ViewModeProvider. */
export default function App() {
  return (
    <ViewModeProvider>
      <AppShell />
    </ViewModeProvider>
  );
}
