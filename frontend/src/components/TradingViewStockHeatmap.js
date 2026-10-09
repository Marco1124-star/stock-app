import React, { useEffect, useMemo, useState } from "react";
import { FiAlertCircle, FiRefreshCw } from "react-icons/fi";
import { apiUrl } from "../services/apiBase";
import HeatmapSignalCard, { FORWARD_SIGNAL_VERSION } from "./HeatmapSignalCard";

const PERIODS = [
  { key: "change1D", label: "1G" },
  { key: "change1W", label: "1S" },
  { key: "change1M", label: "1M" },
];

const RELATION_PERIODS = [
  { key: "daily", label: "Giornaliero" },
  { key: "monthly", label: "Mensile" },
  { key: "annual", label: "Annuale" },
];

const formatNumber = (value, digits = 2) => (
  Number.isFinite(Number(value))
    ? Number(value).toLocaleString("it-IT", { maximumFractionDigits: digits })
    : "—"
);

const formatMarketCap = (value) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "—";
  if (numeric >= 1e12) return `${(numeric / 1e12).toFixed(1)}T`;
  if (numeric >= 1e9) return `${(numeric / 1e9).toFixed(1)}B`;
  return `${(numeric / 1e6).toFixed(0)}M`;
};

const averageChange = (items, key) => {
  const values = items.map((row) => Number(row?.[key])).filter(Number.isFinite);
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : null;
};

const changeTone = (value) => (Number.isFinite(value) ? (value >= 0 ? "is-positive" : "is-negative") : "");

const relationTone = (value) => {
  if (value === null || value === undefined || value === "") return "is-neutral";
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "is-neutral";
  return numeric >= 0 ? "is-positive" : "is-negative";
};

const formatRelation = (value, digits = 2) => {
  if (value === null || value === undefined || value === "") return "—";
  const numeric = Number(value);
  return Number.isFinite(numeric)
    ? `${numeric.toLocaleString("it-IT", { minimumFractionDigits: digits, maximumFractionDigits: digits })}%`
    : "—";
};

const formatCorrelation = (value) => {
  if (value === null || value === undefined || value === "") return "—";
  const numeric = Number(value);
  return Number.isFinite(numeric)
    ? numeric.toLocaleString("it-IT", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : "—";
};

export const HeatmapRelationsModel = ({ ticker, sectorHint }) => {
  const [relations, setRelations] = useState(null);
  const [horizon, setHorizon] = useState("monthly");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [costInput, setCostInput] = useState("20");
  const [costBps, setCostBps] = useState(20);
  const [requestRevision, setRequestRevision] = useState(0);
  const retryRelations = () => setRequestRevision((value) => value + 1);
  const applyCosts = (event) => {
    event.preventDefault();
    const nextCost = Number(costInput);
    if (costInput.trim() !== "" && Number.isFinite(nextCost) && nextCost >= 0 && nextCost <= 500) {
      if (nextCost === costBps) retryRelations();
      else setCostBps(nextCost);
    }
  };

  useEffect(() => {
    if (!ticker) {
      setRelations(null);
      setError("");
      setLoading(false);
      return undefined;
    }
    const controller = new AbortController();
    setLoading(true);
    setError("");
    setRelations(null);
    const params = new URLSearchParams({ signalCostBps: String(costBps), signalVersion: FORWARD_SIGNAL_VERSION });
    if (sectorHint) params.set("sector", sectorHint);
    fetch(apiUrl(`/market/heatmap-relations/${encodeURIComponent(ticker)}?${params.toString()}`), { signal: controller.signal })
      .then(async (response) => {
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.error || "Relazioni non disponibili.");
        return result;
      })
      .then((result) => {
        if (!controller.signal.aborted) setRelations(result);
      })
      .catch((requestError) => {
        if (!controller.signal.aborted && requestError.name !== "AbortError") setError(requestError.message || "Relazioni non disponibili.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [ticker, sectorHint, costBps, requestRevision]);

  const target = relations?.target || {};
  const peerRows = relations?.peerCorrelations?.[horizon] || [];
  const sectorRows = relations?.sectorCorrelations?.[horizon] || [];
  const model = relations?.models?.[horizon] || {};
  const signal = relations?.signals?.[horizon];
  const scenarios = (model.scenarios || []).slice().sort((left, right) => Math.abs(Number(right.beta) || 0) - Math.abs(Number(left.beta) || 0));
  const topPeers = peerRows.slice(0, 10);
  const topSectors = sectorRows.slice(0, 10);
  const scenarioShocks = [-10, -5, 0, 5, 10];

  return (
    <section className="quant-heatmap-relations" aria-label="Modello delle relazioni tra titolo e settori">
      <div className="quant-relations-heading">
        <div>
          <span className="quant-heatmap-kicker">Cross-sectional model</span>
          <h4>Relazioni di settore e sensibilità</h4>
          <p>
            Correlazioni dei rendimenti del titolo con i peer del settore, confronto del settore con gli altri fattori
            e scenari isolati stimati con una regressione Ridge standardizzata.
          </p>
        </div>
        <div className="quant-relations-target">
          <strong>{target.symbol || ticker}</strong>
          <span>{target.sector || "Settore non classificato"}</span>
        </div>
      </div>

      <div className="quant-relations-toolbar">
        <div className="quant-heatmap-periods" role="group" aria-label="Orizzonte dei rendimenti">
          {RELATION_PERIODS.map((item) => (
            <button
              key={item.key}
              type="button"
              className={horizon === item.key ? "is-active" : ""}
              aria-pressed={horizon === item.key}
              onClick={() => setHorizon(item.key)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <span className="quant-relations-window">
          Finestra: {relations?.dataQuality?.returnWindows?.[horizon] || "—"} · storico {relations?.dataQuality?.lookback || "5y daily"} · proxy {relations?.sectorReference?.etf || "peer average"}
        </span>
      </div>

      <form className="quant-signal-cost-controls" onSubmit={applyCosts}>
        <label>
          Costo per comprare e rivendere (punti base)
          <input type="number" min="0" max="500" step="1" required value={costInput} onChange={(event) => setCostInput(event.target.value)} />
        </label>
        <button className="quant-heatmap-refresh" type="submit" disabled={loading}>Applica costi</button>
        <span>Commissioni + slippage · costo applicato: {costBps} bps = {formatRelation(costBps / 100)} complessivi. È un’ipotesi modificabile.</span>
        <button className="quant-heatmap-refresh" type="button" onClick={retryRelations} disabled={loading}>
          <FiRefreshCw aria-hidden="true" className={loading ? "is-spinning" : ""} /> Aggiorna modello
        </button>
      </form>

      {loading && <div className="quant-relations-status" role="status">Calcolo delle relazioni e verifica temporale delle previsioni… Il primo caricamento può richiedere qualche istante.</div>}
      {!loading && error && (
        <div className="quant-relations-status is-error" role="alert">
          <FiAlertCircle aria-hidden="true" /> {error}
          <button type="button" className="quant-heatmap-refresh" onClick={retryRelations}>Riprova modello</button>
        </div>
      )}
      {!loading && !error && relations && (
        <>
          <div className="quant-relations-status" role="status">
            Rendimenti e previsioni in {target.currency || "valuta non verificata"}.
            {target.quoteCurrency && target.quoteCurrency !== target.currency && ` Quotazione originale: ${target.quoteCurrency}.`}
            {target.inHeatmap === false && " Titolo esterno alla heatmap."}
            {relations.dataQuality?.fx && ` Cambio storico: ${relations.dataQuality.fx.symbol} (${relations.dataQuality.fx.units}), ultimo dato ${relations.dataQuality.fx.lastDate}.`}
            {(relations.dataQuality?.warnings || []).map((warning) => <p key={warning}>{warning}</p>)}
          </div>
          <HeatmapSignalCard signal={signal} ticker={target.symbol || ticker} horizon={horizon} onRetry={retryRelations} />
          <div className="quant-relations-summary">
            <div><span>Titolo</span><strong>{target.symbol || ticker}</strong></div>
            <div><span>Peer disponibili</span><strong>{relations.peerCount ?? topPeers.length}</strong></div>
            <div><span>R² relazioni · in-sample</span><strong>{formatCorrelation(model.rSquared)}</strong></div>
            <div><span>Osservazioni</span><strong>{model.observations ?? "—"}</strong></div>
          </div>

          <div className="quant-relations-grid">
            <div className="quant-relations-card">
              <div className="quant-relations-card-heading">
                <div><span>Peer del settore</span><strong>Correlazione con {target.symbol || ticker}</strong></div>
                <small>Top 10 · ρ · β</small>
              </div>
              {topPeers.length ? (
                <div className="quant-relations-table-wrap">
                  <table className="quant-relations-table">
                    <thead><tr><th>Titolo</th><th>ρ</th><th>β</th><th>n</th></tr></thead>
                    <tbody>
                      {topPeers.map((row) => (
                        <tr key={row.symbol}>
                          <td><strong>{row.symbol}</strong><small>{row.name || "Peer"}</small></td>
                          <td>
                            <span className="quant-relation-value"><i className={relationTone(row.correlation)} style={{ width: `${Math.min(100, Math.abs(Number(row.correlation) || 0) * 100)}%` }} />{formatCorrelation(row.correlation)}</span>
                          </td>
                          <td className={relationTone(row.beta)}>{formatCorrelation(row.beta)}</td>
                          <td>{row.observations ?? "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : <div className="quant-relations-empty">Peer insufficienti per questo orizzonte.</div>}
            </div>

            <div className="quant-relations-card">
              <div className="quant-relations-card-heading">
                <div><span>Rotazione settoriale</span><strong>{target.sector || "Settore del titolo"} vs altri settori</strong></div>
                <small>Top 10 · ρ · β</small>
              </div>
              {topSectors.length ? (
                <div className="quant-relations-table-wrap">
                  <table className="quant-relations-table">
                    <thead><tr><th>Settore</th><th>ρ</th><th>β</th><th>n</th></tr></thead>
                    <tbody>
                      {topSectors.map((row) => (
                        <tr key={`${row.etf || "sector"}-${row.sector}`}>
                          <td><strong>{row.sector}</strong><small>{row.etf || "Peer average"}</small></td>
                          <td>
                            <span className="quant-relation-value"><i className={relationTone(row.correlation)} style={{ width: `${Math.min(100, Math.abs(Number(row.correlation) || 0) * 100)}%` }} />{formatCorrelation(row.correlation)}</span>
                          </td>
                          <td className={relationTone(row.beta)}>{formatCorrelation(row.beta)}</td>
                          <td>{row.observations ?? "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : <div className="quant-relations-empty">Fattori settoriali insufficienti per questo orizzonte.</div>}
            </div>
          </div>

          <div className="quant-relations-card quant-relations-scenarios">
            <div className="quant-relations-card-heading">
              <div><span>What-if isolato</span><strong>Impatto stimato sul rendimento del titolo</strong></div>
              <small>Ridge · β parziali</small>
            </div>
            {scenarios.length ? (
              <div className="quant-relations-table-wrap">
                <table className="quant-relations-table quant-scenario-table">
                  <thead><tr><th>Fattore</th>{scenarioShocks.map((shock) => <th key={shock}>{shock > 0 ? "+" : ""}{shock}%</th>)}</tr></thead>
                  <tbody>
                    {scenarios.slice(0, 10).map((scenario) => {
                      const byShock = new Map((scenario.shocks || []).map((item) => [Number(item.shockPct), item.predictedReturnPct]));
                      return (
                        <tr key={scenario.factor}>
                          <td><strong>{scenario.factor}</strong><small>β {formatCorrelation(scenario.beta)}</small></td>
                          {scenarioShocks.map((shock) => {
                            const value = byShock.get(shock);
                            return <td key={shock} className={relationTone(value)}>{formatRelation(value)}</td>;
                          })}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : <div className="quant-relations-empty">Dati insufficienti per la regressione multifattoriale.</div>}
            <p className="quant-relations-note">Ogni scenario varia un solo fattore lasciando gli altri invariati; è una sensibilità storica, non una previsione causale. β positivo indica partecipazione al movimento del fattore, β negativo una risposta tendenzialmente opposta.</p>
          </div>
        </>
      )}
    </section>
  );
};

const TradingViewStockHeatmap = ({ darkMode, ticker, sectorHint }) => {
  const [payload, setPayload] = useState(null);
  const [period, setPeriod] = useState("change1D");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const loadHeatmap = () => {
    setLoading(true);
    setError("");
    fetch(apiUrl("/market/tradingview-heatmap"))
      .then(async (response) => {
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.error || "Dati non disponibili.");
        return result;
      })
      .then(setPayload)
      .catch((requestError) => setError(requestError.message || "Dati non disponibili."))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    loadHeatmap();
  }, []);

  const rows = useMemo(() => payload?.rows || [], [payload?.rows]);
  const visibleRows = rows;
  const groupedRows = useMemo(() => {
    const groups = new Map();
    rows.forEach((row) => {
      const key = row.sector || "Altro";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    });
    return [...groups.entries()]
      .sort(([left], [right]) => left.localeCompare(right, "it"))
      .map(([label, items]) => ({ label, items }));
  }, [rows]);
  const maxMarketCap = Math.max(...visibleRows.map((row) => Number(row.marketCap) || 0), 1);

  return (
    <div className={`quant-native-heatmap ${darkMode ? "is-dark" : "is-light"}`}>
      <div className="quant-heatmap-header">
        <div>
          <span className="quant-heatmap-kicker">Market overview</span>
          <h4>Heat map azionaria</h4>
          <p>Dimensione dei riquadri = capitalizzazione · colore = variazione</p>
        </div>
        <span className="quant-heatmap-live"><i /> Dati di mercato</span>
      </div>
      <div className="quant-heatmap-toolbar">
        <div className="quant-heatmap-periods" role="group" aria-label="Periodo variazione">
          {PERIODS.map((item) => (
            <button
              key={item.key}
              type="button"
              className={period === item.key ? "is-active" : ""}
              aria-pressed={period === item.key}
              onClick={() => setPeriod(item.key)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <button className="quant-heatmap-refresh" type="button" onClick={loadHeatmap} disabled={loading} title="Aggiorna dati">
          <FiRefreshCw aria-hidden="true" className={loading ? "is-spinning" : ""} />
          Aggiorna
        </button>
      </div>
      <div className="quant-heatmap-meta">
        <span><strong>{visibleRows.length}</strong> titoli visualizzati</span>
        <span className="quant-heatmap-source"><i /> Fonte: {payload?.source || "TradingView"}</span>
      </div>
      {loading && <div className="quant-heatmap-status" role="status">Caricamento dati TradingView…</div>}
      {!loading && error && (
        <div className="quant-heatmap-status is-error" role="alert">
          <FiAlertCircle aria-hidden="true" /> {error}
          <button type="button" onClick={loadHeatmap}>Riprova</button>
        </div>
      )}
      {!loading && !error && (
        <div className="quant-heatmap-groups" aria-label="Heat map azioni S&P 500 raggruppate per settore">
          {groupedRows.map((group) => (
            <section className="quant-heatmap-group" key={group.label}>
              <div className="quant-heatmap-group-heading">
                <h5>{group.label}</h5>
                <span className="quant-heatmap-group-stats"><b className={changeTone(averageChange(group.items, period))}>{formatNumber(averageChange(group.items, period))}%</b> · {group.items.length} titoli</span>
              </div>
              <div className="quant-heatmap-grid">
          {group.items.map((row) => {
            const change = Number(row[period]);
            const intensity = Math.min(Math.abs(change || 0) / 5, 1);
            const span = Math.max(1, Math.min(4, Math.ceil(Math.sqrt((Number(row.marketCap) || 0) / maxMarketCap) * 4)));
            return (
              <article
                className={`quant-heatmap-tile ${change >= 0 ? "is-positive" : "is-negative"}`}
                key={row.symbol}
                tabIndex={0}
                aria-label={`${row.name || row.symbol}, ${row.symbol}, variazione ${formatNumber(change)} percento, capitalizzazione ${formatMarketCap(row.marketCap)}`}
                style={{ "--tile-intensity": intensity, "--tile-span": span }}
                title={`${row.name} · ${row.symbol} · ${formatNumber(row[period])}% · Cap. ${formatMarketCap(row.marketCap)}`}
              >
                <strong>{row.symbol}</strong>
                <span>{formatNumber(change)}%</span>
                <small>{formatMarketCap(row.marketCap)}</small>
              </article>
            );
          })}
              </div>
            </section>
          ))}
        </div>
      )}
      {!loading && !error && !visibleRows.length && <div className="quant-heatmap-status" role="status">Nessun titolo disponibile.</div>}
      {ticker && <HeatmapRelationsModel ticker={ticker} sectorHint={sectorHint} />}
      <div className="quant-heatmap-legend" aria-label="Legenda variazioni">
        <span>Ribasso forte</span><i className="is-negative-strong" /><i className="is-negative-soft" /><i className="is-neutral" /><i className="is-positive-soft" /><i className="is-positive-strong" /><span>Rialzo forte</span>
      </div>
    </div>
  );
};

export default TradingViewStockHeatmap;
