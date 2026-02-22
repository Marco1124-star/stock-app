import React, { useEffect, useState, useMemo, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import "./TechnicalsPage.css";
import { FiSearch, FiTrendingUp, FiCalendar } from "react-icons/fi";
import Plot from "react-plotly.js";
import { API_BASE_URL } from "../services/apiBase";

const TIMEFRAMES = ["1h", "4h", "1d", "1w", "1mo"];
const API_BASE = API_BASE_URL;

export default function TechnicalsPage({ darkMode }) {
  const location = useLocation();
  const navigate = useNavigate();
  const normalizeTicker = (value) =>
    (value || "").trim().toUpperCase().replace(/\s+/g, "");
  const ticker = normalizeTicker(
    new URLSearchParams(location.search).get("ticker")
  );

  const [data, setData] = useState(null);
  const [partialCorr, setPartialCorr] = useState(null);

  const [timeframe, setTimeframe] = useState("1d");

  const [loadingTechnicals, setLoadingTechnicals] = useState(true);
  const [loadingCorr, setLoadingCorr] = useState(true);

  const [error, setError] = useState(null);
  const [isPhoneViewport, setIsPhoneViewport] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.innerWidth <= 560;
  });

  const [summary, setSummary] = useState({
    general: "Neutral",
    oscillators: "Neutral",
    movingAverages: "Neutral",
    totalCounts: { Buy: 0, Sell: 0, Neutral: 0 },
    strength: 0,
    strengthLabel: "Weak",
  });

  const technicalCacheRef = useRef(new Map());
  const corrCacheRef = useRef(new Map());
  const technicalAbortRef = useRef(null);
  const corrAbortRef = useRef(null);

  // --- FETCH DATI TECNICI ---
  useEffect(() => {
    if (!ticker) return;

    const key = `${ticker}|${timeframe}`;
    const cached = technicalCacheRef.current.get(key);
    if (cached && Date.now() - cached.ts < 90_000) {
      const json = cached.data;
      setData(json);
      setError(null);
      setLoadingTechnicals(false);
      return;
    }

    if (technicalAbortRef.current) technicalAbortRef.current.abort();
    const controller = new AbortController();
    technicalAbortRef.current = controller;

    const fetchTechnicals = async () => {
      setLoadingTechnicals(true);
      setError(null);
      try {
        const res = await fetch(
          `${API_BASE}/stock/${encodeURIComponent(ticker)}/technicals?timeframe=${timeframe}`,
          { signal: controller.signal }
        );
        if (!res.ok) throw new Error(`Errore API (${res.status})`);
        const json = await res.json();
        if (!json || (!json.oscillatorsSummary && !json.movingAveragesSummary))
          throw new Error("Dati tecnici non validi");

        technicalCacheRef.current.set(key, { ts: Date.now(), data: json });
        setData(json);

        const countAction = (arr = []) => {
          const counts = { Buy: 0, Sell: 0, Neutral: 0 };
          arr.forEach((x) => {
            const action = x.action ?? "Neutral";
            if (counts[action] !== undefined) counts[action]++;
          });
          return counts;
        };

        const oscCounts = countAction(json.oscillatorsSummary);
        const maCounts = countAction(json.movingAveragesSummary);

        const totalCounts = {
          Buy: oscCounts.Buy + maCounts.Buy,
          Sell: oscCounts.Sell + maCounts.Sell,
          Neutral: oscCounts.Neutral + maCounts.Neutral,
        };

        const totalSignals = totalCounts.Buy + totalCounts.Sell + totalCounts.Neutral;
        const strength = totalSignals > 0
          ? Math.max(totalCounts.Buy, totalCounts.Sell) / totalSignals
          : 0;

        const strengthLabel =
          strength > 0.7 ? "Strong" : strength > 0.55 ? "Moderate" : "Weak";

        const general =
          totalCounts.Buy > Math.max(totalCounts.Sell, totalCounts.Neutral)
            ? "Buy"
            : totalCounts.Sell > Math.max(totalCounts.Buy, totalCounts.Neutral)
            ? "Sell"
            : "Neutral";

        const oscillators =
          oscCounts.Buy > oscCounts.Sell
            ? "Buy"
            : oscCounts.Sell > oscCounts.Buy
            ? "Sell"
            : "Neutral";

        const movingAverages =
          maCounts.Buy > maCounts.Sell
            ? "Buy"
            : maCounts.Sell > maCounts.Buy
            ? "Sell"
            : "Neutral";

        setSummary({
          general,
          oscillators,
          movingAverages,
          totalCounts,
          strength,
          strengthLabel,
        });
      } catch (e) {
        if (e?.name === "AbortError") return;
        console.error(e);
        setError(e.message);
        setData(null);
      } finally {
        setLoadingTechnicals(false);
      }
    };

    fetchTechnicals();
  }, [ticker, timeframe]);

  // --- FETCH CORRELAZIONI (solo cambio ticker) ---
  useEffect(() => {
    if (!ticker) return;

    const cached = corrCacheRef.current.get(ticker);
    if (cached && Date.now() - cached.ts < 8 * 60_000) {
      setPartialCorr(cached.data);
      setLoadingCorr(false);
      return;
    }

    if (corrAbortRef.current) corrAbortRef.current.abort();
    const controller = new AbortController();
    corrAbortRef.current = controller;

    const fetchPartialCorr = async () => {
      setLoadingCorr(true);
      try {
        const res = await fetch(
          `${API_BASE}/stock/${encodeURIComponent(ticker)}/partial_corr`,
          { signal: controller.signal }
        );
        if (!res.ok) throw new Error("Errore correlazioni");
        const json = await res.json();
        corrCacheRef.current.set(ticker, { ts: Date.now(), data: json });
        setPartialCorr(json);
      } catch (e) {
        if (e?.name === "AbortError") return;
        console.error(e);
        setPartialCorr(null);
      } finally {
        setLoadingCorr(false);
      }
    };

    fetchPartialCorr();
  }, [ticker]);

  // --- SCROLL IN ALTO QUANDO CAMBIA TICKER ---
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [ticker]);

  useEffect(() => {
    return () => {
      if (technicalAbortRef.current) technicalAbortRef.current.abort();
      if (corrAbortRef.current) corrAbortRef.current.abort();
    };
  }, []);

  useEffect(() => {
    const onResize = () => {
      setIsPhoneViewport(window.innerWidth <= 560);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // --- TABELLE MEMORIZZATE ---
  const oscillatorsTable = useMemo(
    () =>
      data?.oscillatorsSummary?.map((osc) => ({
        name: osc.name === "Momentum3M" ? "Momentum 3M" : osc.name,
        value: osc.value?.toFixed?.(2) ?? "N/A",
        action: osc.action ?? "Neutral",
        cssClass:
          osc.action === "Buy"
            ? "compra"
            : osc.action === "Sell"
            ? "vendi"
            : "neutro",
      })) ?? [],
    [data]
  );

  const maTable = useMemo(
    () =>
      data?.movingAveragesSummary?.map((ma) => ({
        name: ma.name,
        value: ma.value?.toFixed?.(2) ?? "N/A",
        action: ma.action ?? "Neutral",
        cssClass:
          ma.action === "Buy"
            ? "compra"
            : ma.action === "Sell"
            ? "vendi"
            : "neutro",
      })) ?? [],
    [data]
  );

  // --- FUNZIONI GAUGE ---
  const getNeedleAngle = (signal) =>
    signal === "Buy" ? -60 : signal === "Sell" ? 60 : 0;

  const getNeedleColor = (signal) =>
    signal === "Buy"
      ? "#2bd3b1"
      : signal === "Sell"
      ? "#e34646"
      : "#434689";

  const heatmapLayout = useMemo(
    () => ({
      autosize: true,
      margin: isPhoneViewport
        ? { t: 52, r: 18, l: 18, b: 56 }
        : { t: 80, r: 80, l: 80, b: 80 },
      xaxis: {
        tickangle: isPhoneViewport ? -30 : -45,
        automargin: true,
        tickfont: { size: isPhoneViewport ? 10 : 12 },
      },
      yaxis: {
        automargin: true,
        tickfont: { size: isPhoneViewport ? 10 : 12 },
      },
      plot_bgcolor: darkMode ? "#1e1e2f" : "#ffffff",
      paper_bgcolor: darkMode ? "#1e1e2f" : "#ffffff",
    }),
    [darkMode, isPhoneViewport]
  );

  if (loadingTechnicals)
    return (
      <div className={`technicals-page ${darkMode ? "dark" : "light"}`}>
        <div className={`page-loading ${darkMode ? "dark" : "light"} page-loading--technicals`}>
          <div className="loading-title">Caricamento analisi tecnica</div>
          <div className="skeleton-shell technicals-skeleton">
            <div className="skeleton-top">
              <div className="skeleton-block" style={{ height: 100 }} />
              <div className="skeleton-block" style={{ height: 220 }} />
              <div className="skeleton-stack">
                <div className="skeleton-block" style={{ height: 95 }} />
                <div className="skeleton-block" style={{ height: 95 }} />
              </div>
            </div>
            <div className="skeleton-panels">
              <div className="skeleton-block" style={{ height: 320 }} />
              <div className="skeleton-block" style={{ height: 320 }} />
            </div>
            <div className="skeleton-panels">
              <div className="skeleton-block" style={{ height: 340 }} />
              <div className="skeleton-block" style={{ height: 340 }} />
            </div>
          </div>
        </div>
      </div>
    );

  if (error) return <div className="status error status--technicals">{error}</div>;

  return (
    <div className={`technicals-page ${darkMode ? "dark" : "light"}`}>
      {/* 🔷 TOP BOX CON CARDS MODERNE */}
      <div className="top-box tech-card">
        <div
          className="ticker-card-modern tech-card"
          onClick={() => navigate(`/search?query=${encodeURIComponent(ticker)}`)}
        >
          <FiSearch className="ticker-card-icon" />
          <div className="ticker-card-symbol">{ticker}</div>
          <div className="ticker-card-text">Vai a Ricerca</div>
        </div>

        <div className="top-box-main" style={{ flex: 1, textAlign: "center" }}>
          <h1 className="tech-title">Analisi Tecnica — {ticker}</h1>

          <div className="timeframe-selector">
            {TIMEFRAMES.map((tf) => (
              <button
                key={tf}
                className={tf === timeframe ? "active" : ""}
                onClick={() => setTimeframe(tf)}
              >
                {tf === "1mo" ? "1M" : tf.toUpperCase()}
              </button>
            ))}
          </div>

          <div className="summary-dashboard highlight-card tech-card is-ghost">
  { /*<h3>Segnale Generale</h3> */}

  <div className="signal-card">
    <div className={`signal-main ${summary.general.toLowerCase()}`}>
      {summary.general}
    </div>

    <div className="strength-section">
      <div className="strength-bar-container">
        <div
          className={`strength-fill ${summary.general.toLowerCase()}`}
          style={{ width: `${summary.strength * 100}%` }}
        />
      </div>
      <div className="strength-text">
        Forza del segnale: <strong>{summary.strengthLabel}</strong> (
        {Math.round(summary.strength * 100)}%)
      </div>
    </div>

    <div className="counts-section">
      <div className="count buy">Buy: {summary.totalCounts.Buy}</div>
      <div className="count neutral">Neutral: {summary.totalCounts.Neutral}</div>
      <div className="count sell">Sell: {summary.totalCounts.Sell}</div>
    </div>
  </div>
</div>



        </div>

        <div className="right-cards">
          <div
            className="ticker-card-modern tech-card"
            onClick={() => navigate(`/Previsione?ticker=${encodeURIComponent(ticker)}`)}
          >
            <FiTrendingUp className="ticker-card-icon" />
            <div className="ticker-card-symbol">Previsioni</div>
          </div>

          <div
            className="ticker-card-modern tech-card"
            onClick={() => navigate(`/Stagionalità?ticker=${encodeURIComponent(ticker)}`)}
          >
            <FiCalendar className="ticker-card-icon" />
            <div className="ticker-card-symbol">Stagionalità</div>
          </div>
        </div>
      </div>

      {/* 🔹 Cruscotti Oscillatori + Medie */}
      <div className="summary-panels">
        {[
          { key: "oscillators", label: "Oscillatori", table: oscillatorsTable },
          { key: "movingAverages", label: "Medie Mobili", table: maTable },
        ].map(({ key, label, table }) => (
          <div key={key} className="panel tech-card">
            <h4>{label}</h4>
            <div className="gauge-container">
              <div className="gauge" style={{ width: "110px", height: "55px" }}>
                <div className="gauge-center"></div>
                <div
                  className="gauge-needle"
                  style={{
                    transform: `rotate(${getNeedleAngle(summary[key])}deg)`,
                    backgroundColor: getNeedleColor(summary[key]),
                    height: "55px",
                  }}
                ></div>
              </div>
              <div className={`gauge-label ${summary[key].toLowerCase()}`}>
                {summary[key]}
              </div>
            </div>

            <table>
              <thead>
                <tr>
                  <th>Nome</th>
                  <th>Valore</th>
                  <th>Azione</th>
                </tr>
              </thead>
              <tbody>
                {table.map((row, idx) => (
                  <tr key={idx}>
                    <td>{row.name}</td>
                    <td>{row.value}</td>
                    <td className={row.cssClass}>{row.action}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>

      {/* 🔹 Heatmaps Correlation */}
      {partialCorr && (
        <div className="panel tech-card">
          <h3 className="panel-title">
            <span className="line-blue-vertical" />
            <span className="title-text">Matrici di Correlazione</span>
            <span className="line-blue-horizontal" />
          </h3>

          <div className="heatmaps-container">
            {/* Partial Correlation */}
            <div className="heatmap-box tech-card">
              <h4 className="heatmap-title">Partial Correlation</h4>
              <Plot
                data={[
                  {
                    z: partialCorr.partial_matrix,
                    x: partialCorr.variables,
                    y: partialCorr.variables,
                    type: "heatmap",
                    colorscale: [
                      [0, "red"],
                      [0.5, "white"],
                      [1, "blue"],
                    ],
                    zmin: -1,
                    zmax: 1,
                    colorbar: { title: "Partial Corr", titleside: "right" },
                    text: partialCorr.partial_matrix.map((row) =>
                      row.map((v) => v.toFixed(3))
                    ),
                    hovertemplate:
                      "<b>%{y} vs %{x}</b><br>Partial Corr: %{text}<extra></extra>",
                  },
                ]}
                layout={{
                  ...heatmapLayout,
                }}
                config={{ responsive: true }}
              />

               {/* 🧮 Tabella compatta Partial Correlation con evidenziazione valori massimi */}
<div className="partial-corr-table-compact">
  <table>
    <thead>
      <tr>
        <th>Var 1</th>
        <th>Var 2</th>
        <th>Corr</th>
      </tr>
    </thead>
    <tbody>
      {partialCorr.variables.map((var1, i) => {
        // Trova indice della correlazione massima per questa variabile (escludendo se stessa)
        const maxIndex = partialCorr.partial_matrix[i]
          .map((v, idx) => (idx !== i ? Math.abs(v) : -1))
          .reduce((maxIdx, val, idx, arr) => (val > arr[maxIdx] ? idx : maxIdx), 0);

        return partialCorr.variables.map((var2, j) => {
          const value = partialCorr.partial_matrix[i][j];
          if (i >= j || value === 0) return null; // solo upper triangle e non-zero
          const isMax = j === maxIndex;
          return (
            <tr key={`${i}-${j}`} className={isMax ? "max-corr" : ""}>
              <td>{var1}</td>
              <td>{var2}</td>
              <td className={value > 0 ? "positive" : "negative"}>
                {value.toFixed(3)}
              </td>
            </tr>
          );
        });
      })}
    </tbody>
  </table>
</div>


            </div>

            {/* Normal Correlation */}
            <div className="heatmap-box tech-card">
              <h4 className="heatmap-title">Normal Correlation</h4>
              <Plot
                data={[
                  {
                    z: partialCorr.normal_matrix,
                    x: partialCorr.variables,
                    y: partialCorr.variables,
                    type: "heatmap",
                    colorscale: [
                      [0, "red"],
                      [0.5, "white"],
                      [1, "blue"],
                    ],
                    zmin: -1,
                    zmax: 1,
                    colorbar: { title: "Corr", titleside: "right" },
                    text: partialCorr.normal_matrix.map((row) =>
                      row.map((v) => v.toFixed(3))
                    ),
                    hovertemplate:
                      "<b>%{y} vs %{x}</b><br>Corr: %{text}<extra></extra>",
                  },
                ]}
                layout={{
                  ...heatmapLayout,
                }}
                config={{ responsive: true }}
              />

             



            </div>
            
          </div>
        </div>
      )}
    </div>
  );
}

