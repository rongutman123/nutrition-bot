// Chart images for in-chat trends.
// Rendered by QuickChart (Chart.js as a service). Only aggregate numbers and
// dates leave this file — no names, no item text, no identifiers.

const QUICKCHART = 'https://quickchart.io/chart';

const GREEN = '#59a14f';
const RED = '#e15759';
const BLUE = '#4e79a7';
const AMBER = '#f0a04b';
const INK = '#333';

const ddmm = (iso) => `${Number(iso.slice(8, 10))}.${Number(iso.slice(5, 7))}`;

/* Thin the x-axis on long ranges, or the labels collide into mush. */
function thinLabels(dates) {
  const step = dates.length > 20 ? Math.ceil(dates.length / 12) : 1;
  return dates.map((d, i) => (i % step === 0 || i === dates.length - 1 ? ddmm(d) : ''));
}

const opts = (title, yOver = {}) => ({
  plugins: {
    title: { display: true, text: title, font: { size: 20 } },
    legend: { position: 'bottom' },
  },
  scales: {
    y: { grid: { color: '#eee' }, ...yOver },
    x: { grid: { display: false } },
  },
});

/* days: [{ day, calories, protein, measuredPct }] oldest → newest */

export function caloriesChart(days, goal, label) {
  return {
    type: 'bar',
    data: {
      labels: thinLabels(days.map((d) => d.day)),
      datasets: [
        {
          label: 'קלוריות',
          data: days.map((d) => d.calories),
          backgroundColor: days.map((d) => (d.calories > goal ? RED : GREEN)),
          borderWidth: 0,
        },
        {
          type: 'line', label: `יעד ${goal}`, data: days.map(() => goal),
          borderColor: INK, borderWidth: 2, fill: false, pointRadius: 0, borderDash: [6, 4],
        },
      ],
    },
    options: opts(`קלוריות — ${label}`, { beginAtZero: true }),
  };
}

export function proteinChart(days, goal, label) {
  return {
    type: 'bar',
    data: {
      labels: thinLabels(days.map((d) => d.day)),
      datasets: [
        {
          label: 'חלבון (ג)',
          data: days.map((d) => d.protein),
          backgroundColor: days.map((d) => (d.protein >= goal ? GREEN : AMBER)),
          borderWidth: 0,
        },
        {
          type: 'line', label: `יעד ${goal}`, data: days.map(() => goal),
          borderColor: INK, borderWidth: 2, fill: false, pointRadius: 0, borderDash: [6, 4],
        },
      ],
    },
    options: opts(`חלבון — ${label}`, { beginAtZero: true }),
  };
}

/* Weight and waist share a chart but not a scale — they move on different ranges. */
export function weightChart(rows) {
  const datasets = [];
  if (rows.some((r) => r.weight_kg != null)) {
    datasets.push({
      label: 'משקל (ק"ג)', yAxisID: 'y',
      data: rows.map((r) => r.weight_kg ?? null),
      borderColor: BLUE, backgroundColor: BLUE,
      fill: false, spanGaps: true, tension: 0.2, pointRadius: 4,
    });
  }
  if (rows.some((r) => r.waist_cm != null)) {
    datasets.push({
      label: 'מותן (ס"מ)', yAxisID: 'y1',
      data: rows.map((r) => r.waist_cm ?? null),
      borderColor: AMBER, backgroundColor: AMBER,
      fill: false, spanGaps: true, tension: 0.2, pointRadius: 4,
    });
  }
  return {
    type: 'line',
    data: { labels: rows.map((r) => ddmm(r.measured_on)), datasets },
    options: {
      plugins: {
        title: { display: true, text: 'משקל והיקף מותן', font: { size: 20 } },
        legend: { position: 'bottom' },
      },
      scales: {
        y: { position: 'left', grid: { color: '#eee' } },
        y1: { position: 'right', grid: { display: false } },
        x: { grid: { display: false } },
      },
    },
  };
}

/* The core quality KPI: share of calories from measured sources, per day. */
export function accuracyChart(days, label) {
  return {
    type: 'line',
    data: {
      labels: thinLabels(days.map((d) => d.day)),
      datasets: [{
        label: '% מדויק (לא הערכה)',
        data: days.map((d) => d.measuredPct),
        borderColor: BLUE, backgroundColor: 'rgba(78,121,167,0.15)',
        fill: true, tension: 0.25, pointRadius: 3,
      }],
    },
    options: opts(`איכות הנתונים — ${label}`, { beginAtZero: true, max: 100 }),
  };
}

/* PNG bytes, or null on failure so the caller can fall back to text. */
export async function renderChart(chart, { width = 900, height = 460 } = {}) {
  try {
    const res = await fetch(QUICKCHART, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chart, width, height, backgroundColor: 'white', format: 'png', version: '4' }),
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) {
      console.error('quickchart', res.status, (await res.text()).slice(0, 200));
      return null;
    }
    return Buffer.from(await res.arrayBuffer());
  } catch (err) {
    console.error('quickchart error:', err.message);
    return null;
  }
}
