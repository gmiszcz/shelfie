import { Button } from 'primereact/button';
import { Checkbox } from 'primereact/checkbox';
import { Divider } from 'primereact/divider';
import { InputSwitch } from 'primereact/inputswitch';
import { Sidebar } from 'primereact/sidebar';

import { useSettings } from './SettingsContext';
import {
  CARD_FIELDS,
  CARD_FIELD_LABELS,
  DETAIL_SECTIONS,
  DETAIL_SECTION_LABELS,
} from './settingsTypes';

interface Props {
  visible: boolean;
  onHide: () => void;
}

export function SettingsSidebar({ visible, onHide }: Props) {
  const { settings, toggleCardField, toggleDetailSection, setShowAllDetails, reset } =
    useSettings();

  return (
    <Sidebar
      visible={visible}
      position="right"
      onHide={onHide}
      className="settings-sidebar"
      header={
        <span className="settings-title">
          <i className="pi pi-cog" /> Settings
        </span>
      }
    >
      <div className="settings-body">
        <section className="settings-section">
          <h4>Library cards</h4>
          <p className="settings-hint">Which fields appear on each book card.</p>
          <div className="settings-options">
            {CARD_FIELDS.map((field) => (
              <label key={field} className="settings-option">
                <Checkbox
                  inputId={`card-${field}`}
                  checked={settings.cardFields[field]}
                  onChange={() => toggleCardField(field)}
                />
                <span>{CARD_FIELD_LABELS[field]}</span>
              </label>
            ))}
          </div>
        </section>

        <Divider />

        <section className="settings-section">
          <h4>Book detail</h4>
          <p className="settings-hint">Which sections appear in the book detail view.</p>
          <div className="settings-options">
            {DETAIL_SECTIONS.map((section) => (
              <label key={section} className="settings-option">
                <Checkbox
                  inputId={`detail-${section}`}
                  checked={settings.detailSections[section]}
                  onChange={() => toggleDetailSection(section)}
                />
                <span>{DETAIL_SECTION_LABELS[section]}</span>
              </label>
            ))}
          </div>
        </section>

        <Divider />

        <section className="settings-section">
          <label className="settings-option">
            <InputSwitch
              checked={settings.showAllDetails}
              onChange={(e) => setShowAllDetails(!!e.value)}
            />
            <span>Show all details by default</span>
          </label>
          <p className="settings-hint">
            Expand the extended sections (insights, notes, purchase…) whenever a book is opened.
          </p>
        </section>

        <Divider />

        <Button
          label="Reset to defaults"
          icon="pi pi-refresh"
          text
          onClick={reset}
          className="settings-reset"
        />
      </div>
    </Sidebar>
  );
}
