// src/components/ChartWrapper.js
import React, { useCallback, useEffect, forwardRef, useRef, useState } from "react";
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

const ChartWrapper = forwardRef(({ data, darkMode, chartType, fullscreen = false, drawingTool = "select", onDrawingsChange }, ref) => {
  const internalRef = useRef(null);
  const chartRef = ref || internalRef;
  const containerRef = useRef(null);
  const canvasRef = useRef(null);
  const viewportRef = useRef(null);
  const [drawings, setDrawings] = useState([]);
  const activeDrawing = useRef(null);

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const rect = container.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);
    drawings.forEach((drawing) => {
      const points = drawing.points.map((point) => ({ x: point.x * rect.width, y: point.y * rect.height }));
      if (points.length < 1) return;
      const accent = darkMode ? "#2bd3b1" : "#168f77";
      const gold = darkMode ? "#f3c969" : "#b7791f";
      ctx.beginPath();
      ctx.strokeStyle = drawing.type === "horizontal" || drawing.type === "fibonacci" ? gold : accent;
      ctx.lineWidth = 2;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      const drawLine = (from, to, color = ctx.strokeStyle, width = 2, dash = []) => {
        ctx.beginPath(); ctx.strokeStyle = color; ctx.lineWidth = width; ctx.setLineDash(dash);
        ctx.moveTo(from.x, from.y); ctx.lineTo(to.x, to.y); ctx.stroke(); ctx.setLineDash([]);
      };
      if (drawing.type === "vertical") {
        drawLine({ x: points[0].x, y: 0 }, { x: points[0].x, y: rect.height });
      } else if (drawing.type === "ray") {
        const end = points[1] || points[0];
        const dx = end.x - points[0].x;
        const dy = end.y - points[0].y;
        const target = { x: rect.width, y: points[0].y + (dx ? dy * ((rect.width - points[0].x) / dx) : 0) };
        drawLine(points[0], target);
      } else if (drawing.type === "rectangle") {
        const end = points[1] || points[0];
        ctx.strokeStyle = accent; ctx.setLineDash([]); ctx.strokeRect(points[0].x, points[0].y, end.x - points[0].x, end.y - points[0].y);
      } else if (drawing.type === "fibonacci") {
        const start = points[0]; const end = points[1] || points[0];
        const levels = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
        levels.forEach((level) => {
          const y = start.y + (end.y - start.y) * level;
          drawLine({ x: 0, y }, { x: rect.width, y }, gold, level === 0 || level === 1 ? 1.8 : 1, [5, 4]);
          ctx.fillStyle = gold; ctx.font = "11px Inter, sans-serif"; ctx.fillText(`${Math.round(level * 1000) / 10}%`, 6, y - 4);
        });
        drawLine({ x: start.x * rect.width, y: start.y * rect.height }, { x: end.x * rect.width, y: end.y * rect.height }, accent, 1.4);
      } else {
        ctx.moveTo(points[0].x, points[0].y);
        points.slice(1).forEach((point) => ctx.lineTo(point.x, point.y));
        ctx.stroke();
      }
    });
  }, [drawings, darkMode]);

  useEffect(() => {
    redraw();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(redraw);
    if (containerRef.current) observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [redraw, fullscreen]);

  useEffect(() => { onDrawingsChange?.(drawings); }, [drawings, onDrawingsChange]);

  useEffect(() => {
    const chart = chartRef.current;
    const viewport = viewportRef.current;
    if (!chart || !viewport) return;
    chart.options.scales.x.min = viewport.xMin;
    chart.options.scales.x.max = viewport.xMax;
    chart.options.scales.y.min = viewport.yMin;
    chart.options.scales.y.max = viewport.yMax;
    chart.update("none");
  }, [drawingTool, fullscreen, chartRef]);

  const pointFromEvent = (event) => {
    const rect = containerRef.current.getBoundingClientRect();
    return { x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) };
  };
  const handlePointerDown = (event) => {
    if (drawingTool === "select") return;
    event.currentTarget.setPointerCapture(event.pointerId);
    if (drawingTool === "eraser") { setDrawings((items) => items.slice(0, -1)); return; }
    const firstPoint = pointFromEvent(event);
    activeDrawing.current = { id: `${Date.now()}-${Math.random()}`, type: drawingTool, points: drawingTool === "vertical" ? [firstPoint, { ...firstPoint, y: 1 }] : drawingTool === "horizontal" ? [{ x: 0, y: firstPoint.y }, { x: 1, y: firstPoint.y }] : [firstPoint] };
    setDrawings((items) => [...items, activeDrawing.current]);
  };
  const handlePointerMove = (event) => {
    if (!activeDrawing.current) return;
    const point = pointFromEvent(event);
    setDrawings((items) => items.map((item) => item.id === activeDrawing.current.id ? { ...item, points: drawingTool === "pen" ? [...item.points, point] : drawingTool === "horizontal" ? [{ x: 0, y: item.points[0].y }, { x: 1, y: item.points[0].y }] : drawingTool === "vertical" ? [{ x: item.points[0].x, y: 0 }, { x: item.points[0].x, y: 1 }] : [item.points[0], point] } : item));
  };
  const handlePointerUp = () => { activeDrawing.current = null; };

  if (chartRef.current?.scales?.x && chartRef.current?.scales?.y) {
    viewportRef.current = {
      xMin: chartRef.current.scales.x.min,
      xMax: chartRef.current.scales.x.max,
      yMin: chartRef.current.scales.y.min,
      yMax: chartRef.current.scales.y.max,
    };
  }

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
    <div ref={containerRef} className={`chart-container${fullscreen ? " chart-container--fullscreen" : ""}`} style={{ height: "400px", width: "100%" }}>
      <Chart ref={chartRef} data={chartData} options={options} />
      <canvas ref={canvasRef} className="chart-drawing-layer" style={{ pointerEvents: drawingTool === "select" ? "none" : "auto" }} onPointerDown={handlePointerDown} onPointerMove={handlePointerMove} onPointerUp={handlePointerUp} onPointerCancel={handlePointerUp} aria-label="Livello di disegno del grafico" />
    </div>
  );
});

export default ChartWrapper;
