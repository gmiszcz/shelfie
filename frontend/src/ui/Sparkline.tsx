/**
 * Sparkline — a tiny inline SVG line chart for trends under a KPI value.
 *
 * Generic and dependency-free: give it a list of numbers and it draws a smooth
 * polyline (plus an optional soft area fill) that scales to the box. Colour comes
 * from the `--app-accent` CSS variable via the stylesheet, or override per-instance
 * with the `color` prop so a KPI can carry its category hue (green / orange / …).
 */
export interface SparklineProps {
  /** The series to plot. Fewer than two points renders nothing. */
  data: number[];
  /** Drawing width in SVG user units (the SVG itself scales to its box). */
  width?: number;
  /** Drawing height in SVG user units. */
  height?: number;
  /** Stroke colour; defaults to the themed accent. Also tints the area fill. */
  color?: string;
  /** Draw a soft area under the line (default true). */
  area?: boolean;
  className?: string;
}

export function Sparkline({
  data,
  width = 100,
  height = 28,
  color,
  area = true,
  className,
}: SparklineProps) {
  if (!data || data.length < 2) {
    return null;
  }

  const pad = 2;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const span = max - min || 1;
  const stepX = (width - pad * 2) / (data.length - 1);

  const points = data.map((v, i) => {
    const x = pad + i * stepX;
    const y = pad + (height - pad * 2) * (1 - (v - min) / span);
    return [x, y] as const;
  });

  const linePath = points
    .map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`)
    .join(' ');

  const areaPath =
    `${linePath} L${points[points.length - 1][0].toFixed(2)},${height} ` +
    `L${points[0][0].toFixed(2)},${height} Z`;

  const style = color ? ({ color } as const) : undefined;

  return (
    <svg
      className={['ui-spark', className ?? ''].filter(Boolean).join(' ')}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-hidden="true"
      style={style}
    >
      {area && <path className="ui-spark-area" d={areaPath} fill={color ?? 'currentColor'} />}
      <path className="ui-spark-line" d={linePath} stroke={color ?? 'currentColor'} />
    </svg>
  );
}
