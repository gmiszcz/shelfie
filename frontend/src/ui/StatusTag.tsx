import { Tag } from 'primereact/tag';

import type { ReadingStatus } from '../types';
import { STATUS_LABELS, STATUS_SEVERITY } from '../types';

/** The single reading-status badge, so labels and colours match everywhere. */
export function StatusTag({ status }: { status: ReadingStatus }) {
  return <Tag value={STATUS_LABELS[status]} severity={STATUS_SEVERITY[status]} />;
}
