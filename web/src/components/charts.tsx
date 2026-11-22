import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

type Point = Record<string, string | number | null>;

/**
 * Single-series trend line. The card title names the series, so there is no legend.
 * 2px line, recessive horizontal grid, crosshair tooltip on hover, brand color.
 */
export function TrendChart({
  data,
  xKey,
  yKey,
  name,
  formatX,
  formatY = (v) => v.toLocaleString('en-IN'),
  yDomain,
  height = 220,
  reversed = false,
}: {
  data: Point[];
  xKey: string;
  yKey: string;
  name: string;
  formatX?: (v: string | number) => string;
  formatY?: (v: number) => string;
  yDomain?: [number, number];
  height?: number;
  /** Lower is better (e.g. Google position): 1 at the top. */
  reversed?: boolean;
}) {
  if (data.length === 0) {
    return (
      <div
        className="flex items-center justify-center rounded-lg bg-slate-50 text-sm text-slate-400"
        style={{ height }}
      >
        No data yet
      </div>
    );
  }
  return (
    <div style={{ height }} role="img" aria-label={`${name} chart`}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
          <CartesianGrid vertical={false} stroke="#eef2f6" />
          <XAxis
            dataKey={xKey}
            tickFormatter={formatX}
            tick={{ fontSize: 11, fill: '#64748b' }}
            tickLine={false}
            axisLine={{ stroke: '#cbd5e1' }}
            minTickGap={24}
          />
          <YAxis
            domain={yDomain ?? (reversed ? [1, 'auto'] : [0, 'auto'])}
            reversed={reversed}
            tickFormatter={(v: number) => formatY(v)}
            tick={{ fontSize: 11, fill: '#64748b' }}
            tickLine={false}
            axisLine={false}
            width={48}
            allowDecimals={false}
          />
          <Tooltip
            cursor={{ stroke: '#94a3b8', strokeWidth: 1 }}
            formatter={(v) => [formatY(Number(v)), name]}
            labelFormatter={(l) => (formatX ? formatX(l as string) : String(l))}
            contentStyle={{ borderRadius: 8, border: '1px solid #e2e8f0', fontSize: 12 }}
          />
          <Line
            type="monotone"
            dataKey={yKey}
            name={name}
            stroke="var(--brand)"
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 5, strokeWidth: 2, stroke: '#fff' }}
            connectNulls
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
