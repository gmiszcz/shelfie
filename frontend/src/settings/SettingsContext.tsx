import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import type { CardField, DetailSection, Settings } from './settingsTypes';
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from './settingsTypes';

export interface SettingsContextValue {
  settings: Settings;
  toggleCardField: (field: CardField) => void;
  toggleDetailSection: (section: DetailSection) => void;
  setShowAllDetails: (value: boolean) => void;
  reset: () => void;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings>(() => loadSettings());

  // Persist on every change.
  useEffect(() => {
    saveSettings(settings);
  }, [settings]);

  const toggleCardField = useCallback((field: CardField) => {
    setSettings((prev) => ({
      ...prev,
      cardFields: { ...prev.cardFields, [field]: !prev.cardFields[field] },
    }));
  }, []);

  const toggleDetailSection = useCallback((section: DetailSection) => {
    setSettings((prev) => ({
      ...prev,
      detailSections: { ...prev.detailSections, [section]: !prev.detailSections[section] },
    }));
  }, []);

  const setShowAllDetails = useCallback((value: boolean) => {
    setSettings((prev) => ({ ...prev, showAllDetails: value }));
  }, []);

  const reset = useCallback(() => setSettings(DEFAULT_SETTINGS), []);

  const value = useMemo<SettingsContextValue>(
    () => ({ settings, toggleCardField, toggleDetailSection, setShowAllDetails, reset }),
    [settings, toggleCardField, toggleDetailSection, setShowAllDetails, reset],
  );

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings(): SettingsContextValue {
  const ctx = useContext(SettingsContext);
  if (!ctx) {
    throw new Error('useSettings must be used within a SettingsProvider');
  }
  return ctx;
}
