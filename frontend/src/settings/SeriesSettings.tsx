import { useCallback, useEffect, useState } from 'react';

import { useAgentAnchor } from '../agent-ui';
import { api } from '../services/api';
import type { SeriesPreferences, SeriesSearchLang } from '../types';
import { LangSegmented } from '../ui';

/**
 * The "Series search" settings sub-screen (wave 6). Lets the user pick the default
 * release-research language (PL / EN / Both, default PL) applied to a newly watched
 * series when it has none. Loads and saves through the series preferences API.
 *
 * Rendered as the body of the drawer's `series` sub-view (see SettingsSidebar). It
 * follows the two-level menu pattern: the menu row opens this screen.
 */
export function SeriesSettings() {
  const [lang, setLang] = useState<SeriesSearchLang>('pl');
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api
      .getSeriesPreferences()
      .then((prefs) => {
        if (!cancelled) {
          setLang(prefs.default_search_lang ?? 'pl');
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) {
          setLoaded(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Save the default language. The series preferences PUT needs the whole object; we
  // read the current prefs first so we never clobber the active filter/sort.
  const save = useCallback(async (next: SeriesSearchLang) => {
    setLang(next);
    setSaving(true);
    setError(null);
    try {
      let current: SeriesPreferences;
      try {
        current = await api.getSeriesPreferences();
      } catch {
        current = { filter: 'all', sort: null, default_search_lang: 'pl' };
      }
      await api.putSeriesPreferences({ ...current, default_search_lang: next });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save');
    } finally {
      setSaving(false);
    }
  }, []);

  // UI-agent anchor: a select the assistant can read and set.
  useAgentAnchor({
    id: 'settings.series.defaultSearchLang',
    kind: 'select',
    label: 'Default series search language',
    description:
      'The default release-research language (pl, en or both) applied to a newly watched ' +
      'series when it has none. Set to "pl", "en" or "both".',
    getState: () => lang,
    options: () => [
      { value: 'pl', label: 'PL' },
      { value: 'en', label: 'EN' },
      { value: 'both', label: 'Both' },
    ],
    set: (v) => {
      const next = v === 'en' || v === 'both' ? (v as SeriesSearchLang) : 'pl';
      void save(next);
    },
  });

  return (
    <div className="settings-body">
      <p className="settings-hint">
        Which language the release research searches when you watch a new series. You can still
        override it per series on the card.
      </p>
      <div className="settings-options">
        <div className="settings-option settings-series-lang">
          <span>Default search language</span>
          <LangSegmented
            value={lang}
            onChange={(next) => void save(next)}
            ariaLabel="Default series search language"
            disabled={!loaded || saving}
          />
        </div>
      </div>
      {error && <p className="settings-hint" style={{ color: 'var(--accent-red)' }}>{error}</p>}
    </div>
  );
}
