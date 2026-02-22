// src/components/ChartWrapper.js
import React, { useEffect, forwardRef, useRef } from "react";
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  TimeScale,
  LineController,
  LineElement,
  PointElement,
  Tooltip,
  Legend,
} from "chart.js";
import { Chart } from "react-chartjs-2";
import { CandlestickController, CandlestickElement } from "chartjs-chart-financial";
import zoomPlugin from "chartjs-plugin-zoom";
import "chartjs-adapter-date-fns";

ChartJS.register(
  CategoryScale,
  LinearScale,
  TimeScale,
  LineController,
  LineElement,
  PointElement,
  Tooltip,
  Legend,
  CandlestickController,
  CandlestickElement,
  zoomPlugin
);

const ChartWrapper = forwardRef(({ data, darkMode, chartType }, ref) => {
  const internalRef = useRef(null);
  const chartRef = ref || internalRef;

  const chartData = {
    labels: data.map(d => new Date(d.date)),
    datasets: [
      chartType === "candlestick"
        ? {
            label: "Candele",
            data: data.map(d => ({
              x: new Date(d.date),
              o: d.open,
              h: d.high,
              l: d.low,
              c: d.close,
            })),
            type: "candlestick",
            borderColor: "#333",
            borderWidth: 1,
            color: { up: "#4caf50", down: "#f44336", unchanged: "#999" },
          }
        : {
            label: "Prezzo",
            data: data.map(d => ({ x: new Date(d.date), y: d.close })),
            type: "line",
            borderColor: "#00ffcc",
            backgroundColor: "rgba(0,255,204,0.2)",
            tension: 0.2,
            pointRadius: 2,
          },
    ],
  };

  const options = {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 200 },
    plugins: {
      legend: { display: false },
      tooltip: {
        mode: "index",
        intersect: false,
        backgroundColor: darkMode ? "rgba(10,12,16,0.92)" : "#fff",
        titleColor: darkMode ? "#fff" : "#000",
        bodyColor: darkMode ? "#fff" : "#000",
      },
      zoom: {
        pan: { enabled: true, mode: "xy" },
        zoom: {
          wheel: { enabled: true, speed: 0.05 },
          pinch: { enabled: true, speed: 0.05 },
          mode: "xy",
        },
      },
    },
    scales: {
      x: {
        type: "time",
        time: { tooltipFormat: "dd MMM yyyy", unit: "day" },
        grid: { color: darkMode ? "#222" : "#ddd" },
        ticks: { color: darkMode ? "#eee" : "#111" },
      },
      y: {
        grid: { color: darkMode ? "#222" : "#ddd" },
        ticks: { color: darkMode ? "#eee" : "#111" },
      },
    },
    layout: { padding: 10 },
  };

  // Aggiorna e centra il grafico ad ogni cambio tipo o dati
  useEffect(() => {
    if (!chartRef.current) return;
    const chartInstance = chartRef.current;

    // Calcola min/max y
    let yValues = [];
    if (chartType === "candlestick") {
      yValues = (data || []).flatMap((d) => [d.high, d.low]);
    } else {
      yValues = (data || []).map((d) => d.close);
    }
    yValues = yValues.filter((v) => Number.isFinite(v));
    if (!yValues.length) return;
    const yMin = Math.min(...yValues);
    const yMax = Math.max(...yValues);

    // Aggiorna limiti Y
    chartInstance.scales.y.options.min = yMin - (yMax - yMin) * 0.05;
    chartInstance.scales.y.options.max = yMax + (yMax - yMin) * 0.05;

    // Reset zoom e centra automaticamente tutto
    chartInstance.resetZoom();
    chartInstance.update();
  }, [chartType, data, chartRef]);

  return (
    <div className="chart-container" style={{ height: "400px", width: "100%" }}>
      <Chart ref={chartRef} data={chartData} options={options} />
    </div>
  );
});

export default ChartWrapper;
