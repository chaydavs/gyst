import { createContext, useContext, useState, type ReactNode } from 'react';

export type ViewMode = 'simple' | 'advanced';

interface ViewModeContextValue {
  mode: ViewMode;
  setMode: (m: ViewMode) => void;
}

const ViewModeContext = createContext<ViewModeContextValue | null>(null);

const STORAGE_KEY = 'gyst-view-mode';

function loadStoredMode(): ViewMode {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'advanced' || stored === 'simple') return stored;
  } catch {
    // localStorage unavailable (e.g. SSR or private browsing restriction)
  }
  return 'simple';
}

/** Provides ViewMode state to the component tree and persists the preference. */
export function ViewModeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ViewMode>(loadStoredMode);

  const setMode = (m: ViewMode) => {
    setModeState(m);
    try {
      localStorage.setItem(STORAGE_KEY, m);
    } catch {
      // best-effort
    }
  };

  return (
    <ViewModeContext.Provider value={{ mode, setMode }}>
      {children}
    </ViewModeContext.Provider>
  );
}

/**
 * Returns the current ViewMode and a setter.
 * Must be called inside a ViewModeProvider.
 */
export function useViewMode(): ViewModeContextValue {
  const ctx = useContext(ViewModeContext);
  if (!ctx) throw new Error('useViewMode must be used inside ViewModeProvider');
  return ctx;
}
