import React, { useEffect, useState, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import Plot from "react-plotly.js";
import { FiSearch, FiBarChart2, FiTrendingUp } from "react-icons/fi";
import { apiUrl } from "../services/apiBase";
import "./Stagionalita.css";

export default function StagionalitaMultiYear({ darkMode }) {
  const navigate = useNavigate();
  const location = useLocation();
  const ticker = new URLSearchParams(location.search).get("ticker");

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [selectedYears, setSelectedYears] = useState([]);
  const [minYear, setMinYear] = useState(null);
  const [maxYear, setMaxYear] = useState(null);
  const [viewMode, setViewMode] = useState("chart"); // chart | table | percentile
  const [excludeOutliers, setExcludeOutliers] = useState(false);
  const [rawData, setRawData] = useState(null); // aggiungi questa



  const [benchmarkTicker, setBenchmarkTicker] = useState("");
  const [benchmarkData, setBenchmarkData] = useState(null);

  const rangeRef = useRef(null);
  const seasonCacheRef = useRef(new Map());
  const seasonAbortRef = useRef(null);
  const benchmarkAbortRef = useRef(null);

  const getPointerClientX = (ev) => {
    if (typeof ev?.clientX === "number") return ev.clientX;
    if (ev?.touches?.length) return ev.touches[0].clientX;
    if (ev?.changedTouches?.length) return ev.changedTouches[0].clientX;
    return null;
  };

  const addDragListeners = (move, stop) => {
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", stop);
    document.addEventListener("touchmove", move, { passive: false });
    document.addEventListener("touchend", stop);
    document.addEventListener("touchcancel", stop);
  };

  const removeDragListeners = (move, stop) => {
    document.removeEventListener("mousemove", move);
    document.removeEventListener("mouseup", stop);
    document.removeEventListener("touchmove", move);
    document.removeEventListener("touchend", stop);
    document.removeEventListener("touchcancel", stop);
  };

useEffect(() => {
  window.scrollTo({ top: 0, behavior: "instant" });
}, [ticker]);

useEffect(() => {
  return () => {
    if (seasonAbortRef.current) seasonAbortRef.current.abort();
    if (benchmarkAbortRef.current) benchmarkAbortRef.current.abort();
  };
}, []);




  /* ============================= FETCH TICKER DATA ============================= */
 useEffect(() => {
  if (!ticker) return;

  const fetchSeasonality = async () => {
    const cacheKey = `${ticker}|base`;
    const cached = seasonCacheRef.current.get(cacheKey);
    if (cached && Date.now() - cached.ts < 5 * 60_000) {
      const json = cached.data;
      setRawData(json);
      setData(json);
      const years = json.years || [];
      setMinYear(years[0]);
      setMaxYear(years[years.length - 1]);
      setSelectedYears(years);
      setLoading(false);
      return;
    }

    if (seasonAbortRef.current) seasonAbortRef.current.abort();
    const controller = new AbortController();
    seasonAbortRef.current = controller;

    setLoading(true);
    setError("");
    try {
      const res = await fetch(apiUrl(`/seasonality/${ticker}`), {
        signal: controller.signal
      });
      if (!res.ok) {
        let msg = "Errore stagionalità";
        try {
          const err = await res.json();
          if (err?.error) msg = err.error;
        } catch (e) {
          // ignore
        }
        throw new Error(msg);
      }
      const json = await res.json();
      seasonCacheRef.current.set(cacheKey, { ts: Date.now(), data: json });

      setRawData(json);   // salva i dati originali
      setData(json);      // dati iniziali visibili
      const years = json.years || [];
      setMinYear(years[0]);
      setMaxYear(years[years.length - 1]);
      setSelectedYears(years);
    } catch (e) {
      if (e?.name === "AbortError") return;
      console.error(e);
      setError(e.message || "Impossibile caricare l’analisi di stagionalità");
    } finally {
      setLoading(false);
    }
  };

  fetchSeasonality();
}, [ticker]); // RIMUOVI excludeOutliers dai dependency



useEffect(() => {
  if (!rawData) return;

  if (excludeOutliers) {
    // Soglie globali su tutti i mesi/anni, poi clamp per ogni cella valida
    const allValues = Object.values(rawData.seasonalCurveByYear || {})
      .flat()
      .filter((v) => Number.isFinite(v));

    if (allValues.length === 0) {
      setData(rawData);
      return;
    }

    const sorted = [...allValues].sort((a, b) => a - b);
    const minVal = sorted[Math.floor(0.05 * (sorted.length - 1))];
    const maxVal = sorted[Math.floor(0.95 * (sorted.length - 1))];
    const filteredCurve = {};
    Object.keys(rawData.seasonalCurveByYear).forEach(year => {
      filteredCurve[year] = (rawData.seasonalCurveByYear[year] || []).map((v) =>
        Number.isFinite(v) ? Math.min(Math.max(v, minVal), maxVal) : v
      );
    });

    setData({
      ...rawData,
      seasonalCurveByYear: filteredCurve
    });
  } else {
    setData(rawData); // ripristina dati originali
  }
}, [excludeOutliers, rawData]);






  /* ============================= FETCH BENCHMARK DATA ============================= */
  useEffect(() => {
    if (!benchmarkTicker) return;

    const fetchBenchmark = async () => {
      const key = `${benchmarkTicker}|${excludeOutliers}`;
      const cached = seasonCacheRef.current.get(key);
      if (cached && Date.now() - cached.ts < 5 * 60_000) {
        setBenchmarkData(cached.data);
        return;
      }

      if (benchmarkAbortRef.current) benchmarkAbortRef.current.abort();
      const controller = new AbortController();
      benchmarkAbortRef.current = controller;

      try {
        const res = await fetch(
  apiUrl(`/seasonality/${benchmarkTicker}?exclude_outliers=${excludeOutliers}`),
  { signal: controller.signal }
);

        if (!res.ok) throw new Error("Errore benchmark");
        const json = await res.json();
        seasonCacheRef.current.set(key, { ts: Date.now(), data: json });
        setBenchmarkData(json);
      } catch (e) {
        if (e?.name === "AbortError") return;
        console.error(e);
        setBenchmarkData(null);
      }
    };
    fetchBenchmark();
  }, [benchmarkTicker, excludeOutliers]);


  /* ============================= BENCHMARK INPUT ============================= */
  function BenchmarkInput({ value, onChange }) {
    return (
      <div className="benchmark-container">
        <input
          type="text"
          placeholder="Inserisci ticker benchmark"
          value={value}
          onChange={(e) => onChange(e.target.value.toUpperCase())}
          className="benchmark-input"
        />
        <button className="benchmark-btn" onClick={() => setBenchmarkTicker(value)}>Confronta</button>
      </div>
    );
  }

  /* ============================= RANGE SLIDER ============================= */
  const handleThumbDrag = (type, e) => {
    e.preventDefault();
    if (!rangeRef.current || !data?.years?.length) return;
    const rect = rangeRef.current.getBoundingClientRect();
    const width = rect.width;
    const yearCount = data.years.length;
    if (yearCount < 2 || width <= 0) return;

    const move = (ev) => {
      if (ev.cancelable) ev.preventDefault();
      const clientX = getPointerClientX(ev);
      if (clientX == null) return;
      const x = Math.min(Math.max(clientX - rect.left, 0), width);
      const step = width / (yearCount - 1);
      const index = Math.round(x / step);
      const year = data.years[index];
      if (type === "min" && year < maxYear) setMinYear(year);
      if (type === "max" && year > minYear) setMaxYear(year);
    };

    const stop = () => {
      removeDragListeners(move, stop);
    };

    addDragListeners(move, stop);
  };

  useEffect(() => {
    if (!data) return;
    setSelectedYears(data.years.filter((y) => y >= minYear && y <= maxYear));
  }, [minYear, maxYear, data]);

  if (loading)
    return (
      <div className={`stagionalita-page ${darkMode ? "dark" : "light"}`}>
        <div className={`page-loading ${darkMode ? "dark" : "light"} page-loading--stagionalita`}>
          <div className="loading-title">Calcolo stagionalita</div>
          <div className="skeleton-shell stagionalita-skeleton">
            <div className="skeleton-top">
              <div className="skeleton-block skeleton-nav-card" style={{ height: 90 }} />
              <div className="skeleton-block skeleton-nav-card" style={{ height: 90 }} />
              <div className="skeleton-block skeleton-nav-card" style={{ height: 90 }} />
            </div>
            <div className="skeleton-block skeleton-line" style={{ height: 28, width: "42%" }} />
            <div className="skeleton-kpi">
              <div className="skeleton-block skeleton-kpi-card" style={{ height: 110 }} />
              <div className="skeleton-block skeleton-kpi-card" style={{ height: 110 }} />
            </div>
            <div className="skeleton-block skeleton-slider" />
            <div className="skeleton-block skeleton-divider" />
            <div className="skeleton-toolbar">
              <div className="skeleton-block skeleton-pill" style={{ height: 44, width: 280 }} />
              <div className="skeleton-block skeleton-pill" style={{ height: 44, width: 220 }} />
            </div>
            <div className="skeleton-block skeleton-panel" style={{ height: 420 }} />
            <div className="skeleton-kpi">
              <div className="skeleton-block skeleton-kpi-card" style={{ height: 100 }} />
              <div className="skeleton-block skeleton-kpi-card" style={{ height: 100 }} />
              <div className="skeleton-block skeleton-kpi-card" style={{ height: 100 }} />
            </div>
            <div className="skeleton-block skeleton-panel" style={{ height: 260 }} />
          </div>
        </div>
      </div>
    );
  if (error) return <div className="status error status--stagionalita">{error}</div>;
  if (!data) return null;


  /* ============================= CALCOLA MEDIE ============================= */
  const computeMean = (years, curveData) => {
    const sums = Array(12).fill(0);
    const counts = Array(12).fill(0);
    years.forEach((y) => {
      const row = curveData?.[y] || [];
      row.forEach((v, i) => {
        if (Number.isFinite(v)) {
          sums[i] += v;
          counts[i] += 1;
        }
      });
    });
    return sums.map((s, i) => (counts[i] > 0 ? s / counts[i] : null));
  };

  const meanCurve = computeMean(selectedYears, data.seasonalCurveByYear);

  let benchmarkMeanCurve = null;
  if (benchmarkData) {
    const benchmarkYears = benchmarkData.years.filter(
      (y) => y >= benchmarkData.years[0] && y <= benchmarkData.years[benchmarkData.years.length - 1]
    );
    benchmarkMeanCurve = computeMean(benchmarkYears, benchmarkData.seasonalCurveByYear);
  }



  // Determina mese di acquisto e vendita basandosi sui cumulativi
const computeTradeMonths = (cumulativePercentiles) => {
  if (!cumulativePercentiles || cumulativePercentiles.length === 0) return { buyMonth: null, sellMonth: null };

  // Usiamo la mediana cumulativa per la decisione
  const cumMedian = cumulativePercentiles.map(p => p.median);

  // Trova il minimo per comprare
  const minIndex = cumMedian.indexOf(Math.min(...cumMedian));
  let maxIndex = minIndex;
  let maxValue = cumMedian[minIndex];

  // Trova il massimo **dopo il mese di acquisto**
  for (let i = minIndex + 1; i < cumMedian.length; i++) {
    if (cumMedian[i] > maxValue) {
      maxValue = cumMedian[i];
      maxIndex = i;
    }
  }

  return {
    buyMonth: data.months[minIndex],
    sellMonth: data.months[maxIndex]
  };
};

// Esegui la funzione subito dopo aver calcolato cumulativePercentiles



  /* ============================= CALCOLA PERCENTILI ============================= */
  const computePercentiles = (curveData) => {
    const allValuesByMonth = Array(12).fill().map(() => []);
    selectedYears.forEach((y) => {
      (curveData?.[y] || []).forEach((v, i) => {
        if (Number.isFinite(v)) allValuesByMonth[i].push(v);
      });
    });
    const percentiles = allValuesByMonth.map((vals) => {
      if (!vals.length) return { p10: 0, median: 0, p90: 0 };
      const sorted = vals.slice().sort((a,b) => a-b);
      const p10 = sorted[Math.floor(0.1*sorted.length)] || 0;
      const p90 = sorted[Math.floor(0.9*sorted.length)] || 0;
      const median = sorted[Math.floor(0.5*sorted.length)] || 0;
      return { p10, median, p90 };
    });
    return percentiles;
  };



  const computeCumulativePercentiles = (curveData, years) => {
  const cumulativeByMonth = Array(12).fill().map(() => []);

  years.forEach((y) => {
    let cumulative = 0;
    (curveData?.[y] || []).forEach((v, i) => {
      if (!Number.isFinite(v)) return;
      cumulative += v;
      cumulativeByMonth[i].push(cumulative);
    });
  });

  return cumulativeByMonth.map((vals) => {
    if (!vals.length) return { p10: 0, median: 0, p90: 0 };
    const sorted = vals.slice().sort((a, b) => a - b);
    const p10 = sorted[Math.floor(0.1 * sorted.length)] || 0;
    const median = sorted[Math.floor(0.5 * sorted.length)] || 0;
    const p90 = sorted[Math.floor(0.9 * sorted.length)] || 0;

    return { p10, median, p90 };
  });
};






  const monthlyPercentiles = computePercentiles(data.seasonalCurveByYear);



  const cumulativePercentiles = computeCumulativePercentiles(
  data.seasonalCurveByYear,
  selectedYears
);

const tradeMonths = computeTradeMonths(cumulativePercentiles);

// -----------------------------
// Statistiche mensili con win rate
// -----------------------------
const monthStats = data.months.map((month, i) => {
  // Prendi i valori validi dei mesi selezionati
  const values = selectedYears
    .map(y => data.seasonalCurveByYear[y][i])
    .filter(v => v !== null && v !== undefined);

  const avg = values.length > 0 
    ? values.reduce((a, b) => a + b, 0) / values.length 
    : null;

  const wins = values.filter(v => v > 0).length;
  const winRate = values.length > 0 ? (wins / values.length) * 100 : null;

  return {
    month,
    avg,
    winRate
  };
});

// -----------------------------
// Mese migliore e peggiore basati sulla media
// -----------------------------
const validMonthStats = monthStats.filter(m => m.avg !== null);

const bestMonth = validMonthStats.sort((a, b) => b.avg - a.avg)[0];
const worstMonth = validMonthStats.sort((a, b) => a.avg - b.avg)[0];

// -----------------------------
// Win rate totale su tutti i mesi validi
// -----------------------------
let totalWins = 0;
let totalValidMonths = 0;

selectedYears.forEach(y => {
  data.months.forEach((_, i) => {
    const val = data.seasonalCurveByYear[y][i];
    if (val !== null && val !== undefined) {
      totalValidMonths++;
      if (val > 0) totalWins++;
    }
  });
});

const winRateMean = totalValidMonths > 0 
  ? (totalWins / totalValidMonths) * 100 
  : null;

// -----------------------------
// Output
// -----------------------------
console.log({ monthStats, bestMonth, worstMonth, winRateMean });





  /* ============================= PLOT TRACES ============================= */
  const traces = selectedYears.map((year) => ({
    x: data.months,
    y: data.seasonalCurveByYear[year],
    type: "scatter",
    mode: "lines+markers",
    name: year.toString(),
    line: { width: 2 }
  }));

  traces.push({
    x: data.months,
    y: meanCurve,
    type: "scatter",
    mode: "lines+markers",
    name: "Media",
    line: { width: 2, dash: "dot", color: "#2bd3b1" }
  });

  if (benchmarkMeanCurve) {
    traces.push({
      x: data.months,
      y: benchmarkMeanCurve,
      type: "scatter",
      mode: "lines+markers",
      name: `${benchmarkTicker} (media)`,
      line: { width: 2, dash: "dash", color: "#FFA500" }
    });
  }

  const minPos = (data.years.indexOf(minYear) / (data.years.length - 1)) * 100;
  const maxPos = (data.years.indexOf(maxYear) / (data.years.length - 1)) * 100;

  const handleRangeDrag = (e) => {
  e.preventDefault();
  if (!rangeRef.current || !data) return;

  const rect = rangeRef.current.getBoundingClientRect();
  const width = rect.width;
  const yearCount = data.years.length;
  if (yearCount < 2 || width <= 0) return;
  const step = width / (yearCount - 1);

  const initialMin = minYear;
  const initialMax = maxYear;
  const startX = getPointerClientX(e);
  if (startX == null) return;

  const move = (ev) => {
    if (ev.cancelable) ev.preventDefault();
    const clientX = getPointerClientX(ev);
    if (clientX == null) return;
    const dx = clientX - startX;
    const deltaIndex = Math.round(dx / step);

    let newMinIndex = data.years.indexOf(initialMin) + deltaIndex;
    let newMaxIndex = data.years.indexOf(initialMax) + deltaIndex;

    // Limiti: non superare gli estremi
    const rangeSize = data.years.indexOf(initialMax) - data.years.indexOf(initialMin);

    if (newMinIndex < 0) {
      newMinIndex = 0;
      newMaxIndex = rangeSize; // mantiene la distanza
    }

    if (newMaxIndex > data.years.length - 1) {
      newMaxIndex = data.years.length - 1;
      newMinIndex = newMaxIndex - rangeSize; // mantiene la distanza
    }

    setMinYear(data.years[newMinIndex]);
    setMaxYear(data.years[newMaxIndex]);
  };

  const stop = () => {
    removeDragListeners(move, stop);
  };

  addDragListeners(move, stop);
};



  return (
    <div className={`stagionalita-page ${darkMode ? "dark" : "light"}`}>
      <div className="analysis-card season-card">

  {/* TOP ACTIONS */}
  <div className="top-box season-card">
    <div
      className="ticker-card-modern season-card"
      onClick={() => navigate(`/search?query=${ticker}`)}
    >
      <FiSearch className="ticker-card-icon" />
      <div className="ticker-card-symbol">{ticker}</div>
      <div className="ticker-card-text">Cerca</div>
    </div>

    <div
      className="ticker-card-modern season-card"
      onClick={() => navigate(`/Previsione?ticker=${ticker}`)}
    >
      <FiBarChart2 className="ticker-card-icon" />
      <div className="ticker-card-symbol">{ticker}</div>
      <div className="ticker-card-text">Previsioni</div>
    </div>

    <div
      className="ticker-card-modern season-card"
      onClick={() => navigate(`/technicals?ticker=${ticker}`)}
    >
      <FiTrendingUp className="ticker-card-icon" />
      <div className="ticker-card-symbol">{ticker}</div>
      <div className="ticker-card-text">Tecnici</div>
    </div>
  </div>


  <h1 className="page-title">Stagionalità – {ticker}</h1>

    <div className="seasonality-kpi-row">
  <div className="seasonality-kpi trade-month buy season-card">
    <span className="kpi-label">Compra</span>
    <span className="kpi-value">{tradeMonths.buyMonth || "-"}</span>
  </div>

  <div className="seasonality-kpi trade-month sell season-card">
    <span className="kpi-label">Vendi</span>
    <span className="kpi-value">{tradeMonths.sellMonth || "-"}</span>
  </div>
</div>




      <div className="year-range-container" ref={rangeRef}>
  <div className="year-labels">
    {data.years.map((y, i) => (i % 5 === 0 ? <span key={y}>{y}</span> : null))}
  </div>

  <div className="slider-track" />
  <div className="slider-range" style={{ left: `${minPos}%`, width: `${maxPos - minPos}%` }} />
  
  {/* Indicatori anni selezionati */}
  {data.years.map((y) => (y >= minYear && y <= maxYear ? (
    <div key={y} className="year-indicator" style={{ left: `${(data.years.indexOf(y)/(data.years.length-1))*100}%` }} />
  ) : null))}

  <div
  className="slider-middle"
  style={{ left: `${minPos + (maxPos - minPos)/2}%` }}
  onMouseDown={handleRangeDrag}
  onTouchStart={handleRangeDrag}
/>

  <div
    className="slider-thumb"
    style={{ left: `${minPos}%` }}
    onMouseDown={(e) => handleThumbDrag("min", e)}
    onTouchStart={(e) => handleThumbDrag("min", e)}
  >
    <span>{minYear}</span>
  </div>
  <div
    className="slider-thumb"
    style={{ left: `${maxPos}%` }}
    onMouseDown={(e) => handleThumbDrag("max", e)}
    onTouchStart={(e) => handleThumbDrag("max", e)}
  >
    <span>{maxYear}</span>
  </div>
</div>

  {/* DIVIDER VISIVO */}
  <div className="analysis-divider" />

  {/* TOOLBAR */}
  <div className="view-toggle-benchmark">
    <div className="view-toggle">
      <button
        className={viewMode === "chart" ? "active" : ""}
        onClick={() => setViewMode("chart")}
      >
        Grafico
      </button>
      <button
        className={viewMode === "table" ? "active" : ""}
        onClick={() => setViewMode("table")}
      >
        Tabella
      </button>
      <button
        className={viewMode === "percentile" ? "active" : ""}
        onClick={() => setViewMode("percentile")}
      >
        Percentili
      </button>
      <button
  className={viewMode === "cumulativePercentile" ? "active" : ""}
  onClick={() => setViewMode("cumulativePercentile")}
>
  Percentili cumulativi
</button>

<button
  className={`outlier-toggle ${excludeOutliers ? "active" : ""}`}
  onClick={() => setExcludeOutliers(o => !o)}
>
  {excludeOutliers ? "winsorizzazione" : "winsorizzazione"}
</button>


    </div>

    <div className="benchmark-container">
      <div className="benchmark-input-wrapper">
        <input
          type="text"
          placeholder="Inserisci ticker benchmark"
          value={benchmarkTicker}
          onChange={(e) =>
            setBenchmarkTicker(e.target.value.toUpperCase())
          }
          className="benchmark-input"
        />
        <button
          className="benchmark-submit"
          onClick={() => setBenchmarkTicker(benchmarkTicker)}
        >
          Confronta
        </button>
      </div>
    </div>
  </div>

  <div className="panel season-card">
        {viewMode === "chart" && (
          <Plot
            data={traces}
            layout={{
              paper_bgcolor: darkMode ? "#121212" : "#ffffff",
              plot_bgcolor: darkMode ? "#121212" : "#ffffff",
              font: { color: darkMode ? "#ffffff" : "#000000" },
              yaxis: { title: "Variazione %", ticksuffix: "%", zeroline: true },
              margin: { t: 20, l: 55, r: 20, b: 40 },
              legend: { orientation: "h", x: 0, y: 1.1 }
            }}
            config={{ responsive: true, displayModeBar: true }}
            style={{ width: "100%", height: "420px" }}
          />
          
        )}


        {viewMode === "table" && (
          <div className="seasonality-table-wrapper">
            <table className="seasonality-table">
              <thead>
                <tr>
                  <th>Mese</th>
                  <th>Media</th>
                  {benchmarkMeanCurve && <th>{benchmarkTicker} (Media)</th>}
                  {selectedYears.map((y) => <th key={y}>{y}</th>)}
                </tr>
              </thead>
              <tbody>
                {data.months.map((m, i) => (
                  <tr key={m}>
                    <td>{m}</td>
                    <td className={meanCurve[i] >= 0 ? "pos" : "neg"}>
  {meanCurve[i] != null ? meanCurve[i].toFixed(2) : "-"}%
</td>

                    {benchmarkMeanCurve && (
                      <td className={Number.isFinite(benchmarkMeanCurve[i]) && benchmarkMeanCurve[i] >= 0 ? "pos" : "neg"}>
                        {Number.isFinite(benchmarkMeanCurve[i]) ? `${benchmarkMeanCurve[i].toFixed(2)}%` : "-"}
                      </td>
                    )}
                    {selectedYears.map((y) => {
  const v = data.seasonalCurveByYear[y][i];
  return (
    <td key={y} className={!Number.isFinite(v) ? "" : v >= 0 ? "pos" : "neg"}>
      {Number.isFinite(v) ? v.toFixed(2) + "%" : "-"}
    </td>
  );
})}


                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {viewMode === "percentile" && (
          <Plot
            data={[
              { x: data.months, y: monthlyPercentiles.map(p => p.p10), type: "bar", name: "10° Percentile", marker: { color: "#ff4d4f" } },
              { x: data.months, y: monthlyPercentiles.map(p => p.median), type: "bar", name: "Mediana", marker: { color: "#1890ff" } },
              { x: data.months, y: monthlyPercentiles.map(p => p.p90), type: "bar", name: "90° Percentile", marker: { color: "#52c41a" } }
            ]}
            layout={{
              barmode: "group",
              paper_bgcolor: darkMode ? "#121212" : "#ffffff",
              plot_bgcolor: darkMode ? "#121212" : "#ffffff",
              font: { color: darkMode ? "#ffffff" : "#000000" },
              yaxis: { title: "Variazione %" },
              margin: { t: 20, l: 55, r: 20, b: 40 }
            }}
            config={{ responsive: true, displayModeBar: true }}
            style={{ width: "100%", height: "420px" }}
          />
        )}

{viewMode === "cumulativePercentile" && (
  <Plot
    data={[
      { 
        x: data.months, 
        y: cumulativePercentiles.map(p => p.p10), 
        type: "bar", 
        name: "10° Percentile (Cumulativo)", 
        marker: { color: "#ff4d4f" } 
      },
      { 
        x: data.months, 
        y: cumulativePercentiles.map(p => p.median), 
        type: "bar", 
        name: "Mediana (Cumulativo)", 
        marker: { color: "#1890ff" } 
      },
      { 
        x: data.months, 
        y: cumulativePercentiles.map(p => p.p90), 
        type: "bar", 
        name: "90° Percentile (Cumulativo)", 
        marker: { color: "#52c41a" } 
      }
    ]}
    layout={{
      barmode: "group",
      paper_bgcolor: darkMode ? "#121212" : "#ffffff",
      plot_bgcolor: darkMode ? "#121212" : "#ffffff",
      font: { color: darkMode ? "#ffffff" : "#000000" },
      yaxis: { title: "Variazione % cumulativa" },
      margin: { t: 20, l: 55, r: 20, b: 40 }
    }}
    config={{ responsive: true, displayModeBar: true }}
    style={{ width: "100%", height: "420px" }}
  />
)}



        <div className="seasonality-kpi-row">
  <div className="seasonality-kpi season-card">
    <span className="kpi-label">Mese migliore</span>
    <span className="kpi-value">{bestMonth.month}</span>
    <span className="kpi-sub pos">{bestMonth.avg.toFixed(2)}%</span>
  </div>

  <div className="seasonality-kpi season-card">
    <span className="kpi-label">Mese peggiore</span>
    <span className="kpi-value">{worstMonth.month}</span>
    <span className="kpi-sub neg">{worstMonth.avg.toFixed(2)}%</span>
  </div>

  <div className="seasonality-kpi season-card">
  <span className="kpi-label">Win rate medio (mesi)</span>
  <span className="kpi-value">{winRateMean.toFixed(1)}%</span>
</div>

</div>

<div className="seasonality-ranking season-card">
  <h3>Ranking mesi (per rendimento medio)</h3>

  <table>
    <thead>
      <tr>
        <th>Mese</th>
        <th>Media</th>
        <th>Win rate</th>
      </tr>
    </thead>
    <tbody>
      {[...monthStats]
        .sort((a, b) => b.avg - a.avg)
        .map((m) => (
          <tr key={m.month}>
            <td>{m.month}</td>
            <td className={m.avg >= 0 ? "pos" : "neg"}>
              {m.avg.toFixed(2)}%
            </td>
            <td>{m.winRate.toFixed(0)}%</td>
          </tr>
        ))}
    </tbody>
  </table>
</div>
      </div>
      


</div>


     


      
    </div>

    
  );
}
