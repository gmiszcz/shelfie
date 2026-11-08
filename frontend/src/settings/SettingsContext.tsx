import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import type { CardField, DetailSection, Settings } from './settingsTypes';
import {
  CARD_FIELDS,
  DEFAULT_SETTINGS,
  DETAIL_SECTIONS,
  loadSettings,
  saveSettings,
} from './settingsTypes';

export interface SettingsContextValue {
  settings: Settings;
  toggleCardField: (field: CardField) => void;
  toggleDetailSection: (section: DetailSection) => void;
  setShowAllDetails: (value: boolean) => void;
  setShowVoiceButton: (value: boolean) => void;
  /**
   * Set any setting to an explicit boolean by its key (agent `set_setting`).
   * Resolves the key against card fields, detail sections and `showAllDetails`.
   * Returns true when the key was recognised and applied.
   */
  setSettingByKey: (key: string, value: boolean) => boolean;
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

  const setShowVoiceButton = useCallback((value: boolean) => {
    setSettings((prev) => ({ ...prev, showVoiceButton: value }));
  }, []);

  const setSettingByKey = useCallback((key: string, value: boolean): boolean => {
    if (key === 'showAllDetails') {
      setSettings((prev) => ({ ...prev, showAllDetails: value }));
      return true;
    }
    if (key === 'showVoiceButton') {
      setSettings((prev) => ({ ...prev, showVoiceButton: value }));
      return true;
    }
    if (key === 'showChatButton') {
      setSettings((prev) => ({ ...prev, showChatButton: value }));
      return true;
    }
    if ((CARD_FIELDS as string[]).includes(key)) {
      setSettings((prev) => ({
        ...prev,
        cardFields: { ...prev.cardFields, [key as CardField]: value },
      }));
      return true;
    }
    if ((DETAIL_SECTIONS as string[]).includes(key)) {
      setSettings((prev) => ({
        ...prev,
        detailSections: { ...prev.detailSections, [key as DetailSection]: value },
      }));
      return true;
    }
    return false;
  }, []);

  const reset = useCallback(() => setSettings(DEFAULT_SETTINGS), []);

  const value = useMemo<SettingsContextValue>(
    () => ({
      settings,
      toggleCardField,
      toggleDetailSection,
      setShowAllDetails,
      setShowVoiceButton,
      setSettingByKey,
      reset,
    }),
    [
      settings,
      toggleCardField,
      toggleDetailSection,
      setShowAllDetails,
      setShowVoiceButton,
      setSettingByKey,
      reset,
    ],
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
