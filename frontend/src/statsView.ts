/** Pure helpers for the statistics page: preset date ranges, local date formatting, and
 * ECharts bar-chart option building. No React, no DOM — fully unit-testable. */
import type { StatsBucket } from './types';

export type PresetRange = 'thisYear' | 'lastYear' | 'last12Months' | 'allTime';
export type StatsMetric = 'books' | 'pages';

export interface DateRange {
  from: string | null;
  to: string | null;
}

/** Format a Date as a LOCAL `YYYY-MM-DD` string (never UTC — avoids `toISOString` drift). */
export function toIsoDate(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Resolve a preset into a `{ from, to }` pair of local `YYYY-MM-DD` strings.
 * `allTime` returns `{ from: null, to: null }` so the backend applies no bound.
 * `today` is the reference date (defaults to the current local date).
 */
export function presetRange(preset: PresetRange, today: Date = new Date()): DateRange {
  const year = today.getFullYear();

  switch (preset) {
    case 'thisYear':
      return { from: toIsoDate(new Date(year, 0, 1)), to: toIsoDate(new Date(year, 11, 31)) };
    case 'lastYear':
      return {
        from: toIsoDate(new Date(year - 1, 0, 1)),
        to: toIsoDate(new Date(year - 1, 11, 31)),
      };
    case 'last12Months': {
      // Inclusive window ending today, starting the same day one year earlier.
      const from = new Date(today.getFullYear(), today.getMonth(), today.getDate());
      from.setFullYear(from.getFullYear() - 1);
      return { from: toIsoDate(from), to: toIsoDate(today) };
    }
    case 'allTime':
    default:
      return { from: null, to: null };
  }
}

export interface BarColors {
  bar: string;
  text: string;
  muted: string;
  border: string;
}

/**
 * Build an ECharts `option` for a single bar series over the given buckets.
 * `metric` selects which numeric field feeds the bar; axis labels rotate when buckets are many.
 * PlotChart applies value labels, hides the y-axis and themes the rest.
 */
export function barOption(
  buckets: StatsBucket[],
  metric: StatsMetric,
  colors: BarColors,
): Record<string, unknown> {
  const keys = buckets.map((b) => b.key);
  const values = buckets.map((b) => (metric === 'pages' ? b.pages : b.books));
  const seriesName = metric === 'pages' ? 'Pages' : 'Books';
  // Rotate category labels once they would otherwise overlap.
  const rotate = keys.length > 8 ? 45 : 0;

  return {
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    xAxis: {
      type: 'category',
      data: keys,
      axisLabel: {
        color: colors.muted,
        rotate,
        interval: 0,
        hideOverlap: true,
      },
      axisLine: { lineStyle: { color: colors.border } },
    },
    yAxis: { type: 'value' },
    series: [
      {
        name: seriesName,
        type: 'bar',
        data: values,
        itemStyle: { color: colors.bar, borderRadius: [4, 4, 0, 0] },
      },
    ],
  };
}
