/**
 * ChartBlock — rende un blocco ```chart (config Chart.js) come grafico reale.
 * Chart.js caricato in modo LAZY solo quando serve.
 */
import React from "react";

let _chartReady: Promise<any> | null = null;

function loadChart(): Promise<any> {
  if (!_chartReady) {
    _chartReady = import("chart.js").then((mod) => {
      const { Chart, registerables } = mod as any;
      Chart.register(...registerables);
      return Chart;
    });
  }
  return _chartReady;
}

export default function ChartBlock({ config }: { config: any }) {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const [err, setErr] = React.useState(false);

  React.useEffect(() => {
    let chart: any = null;
    let cancelled = false;
    loadChart()
      .then((Chart) => {
        if (cancelled || !canvasRef.current) return;
        // Opzioni di default coerenti col tema scuro del pannello.
        const cfg = {
          ...config,
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { labels: { color: "#e5e7eb", font: { size: 10 } } } },
            scales: { x: { ticks: { color: "#a1a1aa", font: { size: 9 } } }, y: { ticks: { color: "#a1a1aa", font: { size: 9 } } } },
            ...(config?.options || {}),
          },
        };
        chart = new Chart(canvasRef.current, cfg);
      })
      .catch(() => { if (!cancelled) setErr(true); });
    return () => { cancelled = true; if (chart) chart.destroy(); };
  }, [config]);

  if (err) {
    return <pre className="text-[10px] overflow-x-auto bg-black/40 rounded p-2 my-2">{JSON.stringify(config, null, 2)}</pre>;
  }
  return (
    <div className="my-2 rounded-xl border border-violet-400/20 bg-white/5 p-2" style={{ height: 220 }}>
      <canvas ref={canvasRef} />
    </div>
  );
}
