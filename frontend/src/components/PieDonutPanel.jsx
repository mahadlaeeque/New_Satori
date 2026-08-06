// ─── PieDonutPanel ───
// The pie / donut body of a dashboard panel.
//
// Split out of the renderer because the label strategy is the whole trick and
// it needs to be reviewable on its own. Recharts' default — labels outside the
// ring on leader lines — collapses into an unreadable tangle as soon as a
// category has a long tail, which real data almost always does (an attendance
// status mix carries four sub-1% "Submitted …" statuses behind Present and
// Missing Punch). So: percentages INSIDE the wedge, only where a wedge is big
// enough to hold one; the legend names every slice; hover gives the exact
// figure and share.

import {
  PieChart, Pie, Cell, Tooltip, Legend, ResponsiveContainer,
} from "recharts";

// Beyond this many slices the tail is rolled into a single "Other" wedge.
const MAX_SLICES = 8;
// A wedge narrower than this can't hold a legible label.
const MIN_LABEL_SHARE = 0.05;

/** Sort descending and roll up the tail. */
const compactPieData = (rows, labelKey, valueKey) => {
  // Always sort, not just when rolling up: walking the slices big-to-small
  // keeps the slivers adjacent instead of scattered between the big wedges.
  const sorted = [...(rows || [])].sort(
    (a, b) => Number(b?.[valueKey] || 0) - Number(a?.[valueKey] || 0),
  );
  if (sorted.length <= MAX_SLICES) return sorted;
  const top = sorted.slice(0, MAX_SLICES - 1);
  const other = sorted.slice(MAX_SLICES - 1)
    .reduce((sum, r) => sum + Number(r?.[valueKey] || 0), 0);
  return [...top, { [labelKey]: "Other", [valueKey]: other }];
};

const clip = (s, max) => {
  const str = s == null ? "" : String(s);
  return str.length > max ? `${str.slice(0, max - 1)}…` : str;
};

export default function PieDonutPanel({
  rows = [],
  labelKey = "label",
  valueKey = "value",
  type = "donut",
  colors = ["#8AC441"],
  formatValue = (v) => String(v),
  onSliceClick,
  height = 330,
  // Recharts only draws the slice labels once the reveal animation finishes,
  // so anything measuring this chart headlessly has to turn it off first.
  animate = true,
}) {
  const data = compactPieData(rows, labelKey, valueKey);
  const total = data.reduce((s, r) => s + (Number(r?.[valueKey]) || 0), 0) || 1;
  const isDonut = type === "donut";

  const renderSliceLabel = ({ cx, cy, midAngle, innerRadius, outerRadius, value, percent, payload }) => {
    // Recharts hands the slice's share straight to a label renderer as
    // `percent`; `value` is not always populated on the top-level props, so
    // deriving the share from it alone silently returns null for every slice
    // and the chart draws with no labels at all. Fall back through the payload
    // before giving up.
    const raw = value ?? payload?.[valueKey] ?? payload?.payload?.[valueKey];
    const share = Number.isFinite(Number(percent)) ? Number(percent) : (Number(raw) || 0) / total;
    if (!Number.isFinite(share) || share < MIN_LABEL_SHARE) return null;
    const RAD = Math.PI / 180;
    const r = innerRadius + (outerRadius - innerRadius) * (isDonut ? 0.5 : 0.62);
    return (
      <text
        x={cx + r * Math.cos(-midAngle * RAD)}
        y={cy + r * Math.sin(-midAngle * RAD)}
        fill="#fff" fontSize={11.5} fontWeight={700}
        textAnchor="middle" dominantBaseline="central"
      >
        {Math.round(share * 100)}%
      </text>
    );
  };

  return (
    <ResponsiveContainer width="100%" height={height}>
      <PieChart margin={{ top: 4, right: 4, bottom: 4, left: 4 }}>
        <Pie
          data={data}
          dataKey={valueKey}
          nameKey={labelKey}
          cx="50%"
          cy="45%"
          innerRadius={isDonut ? 54 : 0}
          outerRadius={92}
          paddingAngle={isDonut ? 2 : 0}
          label={renderSliceLabel}
          labelLine={false}
          isAnimationActive={animate}
          onClick={(d) => onSliceClick?.(d?.[labelKey] ?? d?.name)}
          style={{ cursor: onSliceClick ? "pointer" : "default" }}
        >
          {data.map((_, i) => <Cell key={i} fill={colors[i % colors.length]} />)}
        </Pie>
        {/* The share is the point of a pie — put it in the tooltip rather than
            making the reader eyeball the wedge. */}
        <Tooltip formatter={(v, name) => [
          `${formatValue(v)} · ${(((Number(v) || 0) / total) * 100).toFixed(1)}%`, name,
        ]} />
        <Legend
          iconSize={9}
          wrapperStyle={{ fontSize: 11.5, lineHeight: 1.7, paddingTop: 4 }}
          formatter={(value) => clip(value, 24)}
        />
      </PieChart>
    </ResponsiveContainer>
  );
}
