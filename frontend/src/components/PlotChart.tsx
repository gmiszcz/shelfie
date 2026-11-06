import ReactECharts from 'echarts-for-react';
import type { EChartsOption } from 'echarts';
import { useEffect, useMemo, useState } from 'react';

import './PlotChart.css';

interface Props {
  /** A raw ECharts option. PlotChart enhances bar series and themes axes/labels. */
  option: Record<string, unknown>;
  height?: number;
  title?: string;
}

const cssVar = (name: string): string =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

interface SeriesLike {
  type?: string;
  stack?: string;
  label?: unknown;
  [key: string]: unknown;
}

/**
 * Theme-reactive ECharts wrapper (per the echarts-plots reference). Reads the app's
 * `--app-*` CSS variables for colors and re-renders when the `data-theme` attribute on
 * `<html>` changes. Bar series get value labels; pure-bar charts hide the y-axis; label
 * shadows are explicitly cleared (they look wrong in dark mode).
 */
export function PlotChart({ option, height = 350, title }: Props) {
  const [themeKey, setThemeKey] = useState(0);

  useEffect(() => {
    const observer = new MutationObserver(() => setThemeKey((k) => k + 1));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    return () => observer.disconnect();
  }, []);

  const themed = useMemo<EChartsOption>(() => {
    const text = cssVar('--app-text') || '#e6e8ee';
    const muted = cssVar('--app-text-muted') || '#9aa0b0';
    const border = cssVar('--app-border') || '#2e3342';
    const surface = cssVar('--app-surface') || '#1a1d27';

    const source = (option ?? {}) as Record<string, unknown>;
    const series = (source.series as SeriesLike[] | undefined) ?? [];
    const isBarOnly = series.length > 0 && series.every((s) => s.type === 'bar');
    const hasStacked = series.some((s) => Boolean(s.stack));

    const enhancedSeries = series.map((s) => {
      if (s.type === 'bar' && s.label === undefined) {
        return {
          ...s,
          label: {
            show: true,
            position: hasStacked ? 'inside' : 'top',
            fontSize: hasStacked ? 10 : 11,
            color: hasStacked ? '#fff' : text,
            // Remove the default shadow/stroke — visible and ugly in dark mode.
            textShadowColor: 'transparent',
            textShadowBlur: 0,
            textBorderColor: 'transparent',
            textBorderWidth: 0,
            formatter: (p: { value: number }) =>
              p.value >= 1 ? Math.round(p.value).toLocaleString() : '',
          },
        };
      }
      return s;
    });

    const base: Record<string, unknown> = {
      backgroundColor: 'transparent',
      ...source,
      series: enhancedSeries,
      grid: {
        left: 20,
        right: 20,
        top: title ? 40 : 20,
        bottom: 30,
        containLabel: true,
        ...(source.grid as Record<string, unknown> | undefined),
      },
    };

    if (title) {
      base.title = { text: title, textStyle: { color: text, fontSize: 14 } };
    } else {
      delete base.title;
    }

    const xAxis = source.xAxis as Record<string, unknown> | undefined;
    if (xAxis) {
      base.xAxis = {
        ...xAxis,
        axisLabel: { color: muted, ...(xAxis.axisLabel as Record<string, unknown> | undefined) },
        axisLine: { lineStyle: { color: border } },
      };
    }

    if (isBarOnly) {
      base.yAxis = { show: false };
    } else {
      const yAxis = source.yAxis as Record<string, unknown> | undefined;
      if (yAxis) {
        base.yAxis = {
          ...yAxis,
          axisLabel: { color: muted, ...(yAxis.axisLabel as Record<string, unknown> | undefined) },
          splitLine: { lineStyle: { color: border } },
        };
      }
    }

    const tooltip = source.tooltip as Record<string, unknown> | undefined;
    if (tooltip) {
      base.tooltip = {
        ...tooltip,
        backgroundColor: surface,
        borderColor: border,
        textStyle: { color: text },
      };
    }

    return base as EChartsOption;
    // themeKey forces a recompute (and remount) when the theme toggles.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [option, title, themeKey]);

  return (
    <ReactECharts
      key={themeKey}
      option={themed}
      notMerge
      lazyUpdate
      style={{ height, width: '100%' }}
    />
  );
}
