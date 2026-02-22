// src/components/Search.js
import React, { useState, useEffect, useCallback, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import ChartWrapper from "./ChartWrapper";
import "./Search.css";
import { FiTrendingUp, FiClock, FiCalendar } from "react-icons/fi";
import { apiUrl } from "../services/apiBase";

const DEFAULT_TIMEFRAME = "1d";
const TF_OPTIONS = ["1h", "4h", "1d", "1w"];
const SEARCH_CACHE_TTL_MS = 120000;
const HISTORY_CACHE_TTL_MS = 120000;
const STORAGE_CACHE_PREFIX = "search-cache:";
const timeframeLabel = tf => ({ "1h":"1H","4h":"4H","1d":"1D","1w":"1W" }[tf] || tf);

const normalizeTicker = (value) =>
  (value || "").trim().toUpperCase().replace(/\s+/g, "");

const fmtEuro = n => {
  if (n == null) return "-";
  return new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2 }).format(n);
};

const fmtLarge = n => {
  if (n == null) return "-";
  if (Math.abs(n) >= 1e12) return (n/1e12).toFixed(2)+"T";
  if (Math.abs(n) >= 1e9) return (n/1e9).toFixed(2)+"B";
  if (Math.abs(n) >= 1e6) return (n/1e6).toFixed(2)+"M";
  if (Math.abs(n) >= 1e3) return (n/1e3).toFixed(0)+"k";
  return n.toString();
};

const clampPercent = (value) => {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
};

const percentInRange = (min, max, value) => {
  if (min == null || max == null || value == null) return 0;
  const denom = max - min;
  if (!Number.isFinite(denom) || denom <= 0) return 0;
  return clampPercent(((value - min) / denom) * 100);
};

const isFiniteNumber = (v) => Number.isFinite(v);


export default function Search({ darkMode, watchlist = [], onAddToWatchlist }) {
  const location = useLocation();
  const navigate = useNavigate();
  const chartRef = useRef(null);
  const cacheRef = useRef(new Map());
  const requestSeqRef = useRef(0);
  const fetchAbortRef = useRef(null);
  const historySeqRef = useRef(0);
  const historyAbortRef = useRef(null);
  const timeframeRef = useRef(DEFAULT_TIMEFRAME);
  const initialQuery = normalizeTicker(new URLSearchParams(location.search).get("query") || "");

  const [searchInput, setSearchInput] = useState(initialQuery);
  const [ticker, setTicker] = useState(null);
  const [symbol, setSymbol] = useState(initialQuery.toUpperCase());
  const [timeframe, setTimeframe] = useState(DEFAULT_TIMEFRAME);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [chartType, setChartType] = useState("line");
  const [showRiskDetails, setShowRiskDetails] = useState(false);

  // Nuove variabili per rendimento personalizzato
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [customPerformance, setCustomPerformance] = useState(null);

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "instant" });
  }, []);

  useEffect(() => {
    timeframeRef.current = timeframe;
  }, [timeframe]);

  useEffect(() => {
    return () => {
      if (fetchAbortRef.current) {
        fetchAbortRef.current.abort();
      }
      if (historyAbortRef.current) {
        historyAbortRef.current.abort();
      }
    };
  }, []);

  const readCache = useCallback((key, ttlMs, allowStale = false) => {
    const now = Date.now();
    const inMemory = cacheRef.current.get(key);
    if (inMemory) {
      const age = now - inMemory.ts;
      if (age <= ttlMs || allowStale) {
        return { data: inMemory.data, fresh: age <= ttlMs };
      }
    }

    try {
      const raw = localStorage.getItem(`${STORAGE_CACHE_PREFIX}${key}`);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || !parsed.ts) return null;
      const age = now - Number(parsed.ts);
      if (age <= ttlMs || allowStale) {
        cacheRef.current.set(key, { ts: Number(parsed.ts), data: parsed.data });
        return { data: parsed.data, fresh: age <= ttlMs };
      }
    } catch (e) {
      // ignore local cache parsing errors
    }
    return null;
  }, []);

  const writeCache = useCallback((key, data) => {
    const entry = { ts: Date.now(), data };
    cacheRef.current.set(key, entry);
    try {
      localStorage.setItem(`${STORAGE_CACHE_PREFIX}${key}`, JSON.stringify(entry));
    } catch (e) {
      // ignore quota errors
    }
  }, []);

  const fetchTicker = useCallback(async (t, tfParam) => {
    const tf = tfParam || timeframeRef.current || DEFAULT_TIMEFRAME;
    const normalized = normalizeTicker(t);
    if (!normalized) return;
    const cacheKey = `stock:${normalized}|${tf}`;
    const cached = readCache(cacheKey, SEARCH_CACHE_TTL_MS, true);
    if (cached?.data) {
      setTicker(cached.data);
      setSymbol(normalized.toUpperCase());
      setError("");
      if (cached.fresh) return;
    }

    if (fetchAbortRef.current) {
      fetchAbortRef.current.abort();
    }
    const controller = new AbortController();
    fetchAbortRef.current = controller;
    const requestId = ++requestSeqRef.current;

    setLoading(true);
    setError("");
    const parseError = async (res) => {
      let msg = "Ticker non trovato.";
      try {
        const err = await res.json();
        if (err?.error) {
          msg = err.error.includes("Nessun dato")
            ? "Dati non disponibili o ticker errato."
            : err.error;
        }
      } catch (e) {
        // ignore parse error
      }
      return msg;
    };

    const tryFetch = async (tfToUse) => {
      const res = await fetch(
        apiUrl(`/stock/${encodeURIComponent(normalized)}?timeframe=${tfToUse}`),
        { signal: controller.signal }
      );
      if (!res.ok) {
        return { ok: false, res };
      }
      const data = await res.json();
      return { ok: true, data };
    };

    try {
      let result = await tryFetch(tf);
      if (!result.ok && tf !== "1d") {
        result = await tryFetch("1d");
        if (result.ok) setTimeframe("1d");
      }
      if (!result.ok) {
        // fallback: prova priceOnly per mostrare almeno il prezzo
        const priceRes = await fetch(
          apiUrl(`/stock/${encodeURIComponent(normalized)}?priceOnly=true`),
          { signal: controller.signal }
        );
        if (priceRes.ok) {
          const priceData = await priceRes.json();
          if (requestId !== requestSeqRef.current) return;
          setTicker({
            info: priceData.info || {},
            ohlc: [],
            performance: {},
            risk: { level: "N/D", index: null, metrics: {} },
          });
          setSymbol(normalized.toUpperCase());
          localStorage.setItem("lastTicker", normalized.toUpperCase());
          setError("Dati parziali disponibili. Storico non disponibile.");
          return;
        }

        const msg = await parseError(result.res);
        if (requestId !== requestSeqRef.current) return;
        setError(msg);
        return;
      }
      const data = result.data;
      if (requestId !== requestSeqRef.current) return;

      if (data.info) {
        ["currentPrice", "marketCap", "dividend", "eps", "epsForward", "52WLow", "52WHigh", "dailyLow", "dailyHigh"].forEach(key => {
          if (data.info[key] != null) data.info[key] = Number(data.info[key].toFixed(2));
        });
      }

      setTicker(data);
      writeCache(cacheKey, data);
      setSymbol(normalized.toUpperCase());
      localStorage.setItem("lastTicker", normalized.toUpperCase());

    } catch(e) {
      if (e?.name === "AbortError") return;
      console.error(e);
      if (requestId !== requestSeqRef.current) return;
      setError("Errore nella richiesta");
    } finally {
      if (requestId === requestSeqRef.current) {
        setLoading(false);
      }
    }
  }, [readCache, writeCache]);

  const fetchHistoryOnly = useCallback(async (t, tfParam) => {
    const tf = tfParam || timeframeRef.current || DEFAULT_TIMEFRAME;
    const normalized = normalizeTicker(t);
    if (!normalized) return;

    const cacheKey = `history:${normalized}|${tf}`;
    const cached = readCache(cacheKey, HISTORY_CACHE_TTL_MS, true);
    if (cached?.data?.history) {
      setTicker((prev) => (prev ? { ...prev, ohlc: cached.data.history } : prev));
      if (cached.fresh) return;
    }

    if (historyAbortRef.current) {
      historyAbortRef.current.abort();
    }
    const controller = new AbortController();
    historyAbortRef.current = controller;
    const requestId = ++historySeqRef.current;

    setLoading(true);
    try {
      const res = await fetch(
        apiUrl(`/stock/${encodeURIComponent(normalized)}/history?timeframe=${tf}`),
        { signal: controller.signal }
      );
      if (!res.ok) throw new Error(`Errore API (${res.status})`);
      const data = await res.json();
      if (requestId !== historySeqRef.current) return;
      const history = Array.isArray(data?.history) ? data.history : [];
      setTicker((prev) => (prev ? { ...prev, ohlc: history } : prev));
      writeCache(cacheKey, { history });
      setError("");
    } catch (e) {
      if (e?.name === "AbortError") return;
      console.error(e);
      if (requestId !== historySeqRef.current) return;
      setError("Storico non disponibile per questo timeframe.");
    } finally {
      if (requestId === historySeqRef.current) {
        setLoading(false);
      }
    }
  }, [readCache, writeCache]);

  const fetchLivePrice = useCallback(async () => {
    if (!symbol) return;
    try {
      const res = await fetch(
        apiUrl(`/stock/${encodeURIComponent(symbol)}?priceOnly=true`)
      );
      if (!res.ok) return;
      const data = await res.json();
      if (data.info) {
        setTicker(prev => {
          if (!prev) return prev;
          const updatedTicker = {
            ...prev,
            info: {
              ...prev.info,
              currentPrice: Number(data.info.currentPrice.toFixed(2)),
              dailyLow: Number(data.info.dailyLow.toFixed(2)),
              dailyHigh: Number(data.info.dailyHigh.toFixed(2)),
              dailyChange: Number(data.info.dailyChange.toFixed(2))
            }
          };
          if (prev.ohlc && prev.ohlc.length) {
            const lastCandle = prev.ohlc[prev.ohlc.length - 1];
            const newCandle = {
              ...lastCandle,
              close: data.info.currentPrice,
              high: Math.max(lastCandle.high, data.info.currentPrice),
              low: Math.min(lastCandle.low, data.info.currentPrice)
            };
            updatedTicker.ohlc = [...prev.ohlc.slice(0, -1), newCandle];
          }
          return updatedTicker;
        });
      }
    } catch(e){ console.error("Errore live price:", e); }
  }, [symbol]);



  useEffect(() => {
    if (!initialQuery) return;
    setSearchInput(initialQuery);
    fetchTicker(initialQuery, timeframeRef.current);
  }, [initialQuery, fetchTicker]);

  useEffect(() => {
    if (!symbol) return;
    const interval = setInterval(() => fetchLivePrice(), 10000);
    return () => clearInterval(interval);
  }, [fetchLivePrice, symbol]);

  const onSearch = () => {
    const normalized = normalizeTicker(searchInput);
    if (!normalized) return;
    if (normalized === initialQuery) {
      fetchTicker(normalized.trim(), timeframe);
      return;
    }
    navigate(`/search?query=${encodeURIComponent(normalized)}`);
  };

  const onTfClick = tf => {
    setTimeframe(tf);
    const target = normalizeTicker(symbol || searchInput);
    if (!target) return;
    if (ticker?.info) {
      fetchHistoryOnly(target, tf);
    } else {
      fetchTicker(target, tf);
    }
  };
  const onChartType = type => setChartType(type);
  const resetZoom = () => { if(chartRef.current) chartRef.current.resetZoom(); };

  const addToWatchlist = async () => {
    if (!symbol) return;
    if (watchlist.includes(symbol)) {
      alert(`${symbol} gia nella watchlist`);
      return;
    }
    try {
      const success = await onAddToWatchlist?.(symbol);
      if (success === false) {
        alert("Errore durante il salvataggio della watchlist.");
        return;
      }
      alert(`${symbol} aggiunto alla watchlist!`);
    } catch {
      alert("Errore durante il salvataggio della watchlist.");
    }
  };
  // --- Nuova funzione per calcolare rendimento + CAGR ---
  const calculateCustomPerformance = () => {
    if (!ticker?.ohlc || !startDate || !endDate) return;

    const start = new Date(startDate);
    const end = new Date(endDate);

    const filtered = ticker.ohlc.filter(candle => {
      const d = new Date(candle.date);
      return d >= start && d <= end;
    });

    if (filtered.length < 2) {
      setCustomPerformance(null);
      return;
    }

    const initialPrice = filtered[0].close;
    const finalPrice = filtered[filtered.length - 1].close;

    const rendimento = ((finalPrice - initialPrice) / initialPrice) * 100;

    const days = (end - start) / (1000 * 60 * 60 * 24);
    const years = days / 365.25;
    const cagr = Math.pow(finalPrice / initialPrice, 1 / years) - 1;

    setCustomPerformance({
      initialPrice,
      finalPrice,
      rendimento,
      cagr: cagr * 100
    });
  };

  const riskInfo = ticker?.risk || { level: "N/D", index: null, metrics: {} };
  const riskIndexLabel = riskInfo.index != null ? `${riskInfo.index}/100` : "N/D";
  const riskClass = riskInfo.level === "N/D" ? "nd" : riskInfo.level.toLowerCase();
  const liquidityLabel = riskInfo.metrics?.avgDollarVolume != null
    ? `${fmtLarge(riskInfo.metrics.avgDollarVolume)} EUR`
    : (riskInfo.metrics?.avgVolume != null ? `${fmtLarge(riskInfo.metrics.avgVolume)} vol` : "N/D");
  const marketCapLabel = riskInfo.metrics?.marketCap != null ? fmtLarge(riskInfo.metrics.marketCap) : "N/D";
  const volRegimeLabel = riskInfo.metrics?.volRegime != null ? `${riskInfo.metrics.volRegime.toFixed(2)}x` : "N/D";
  const info = ticker?.info || {};
  const currentPrice = Number.isFinite(info.currentPrice) ? info.currentPrice : null;
  const epsFromPe =
    currentPrice != null && Number.isFinite(info.peRatio) && info.peRatio !== 0
      ? currentPrice / info.peRatio
      : null;
  const dividendFromYield =
    currentPrice != null && Number.isFinite(info.dividendYield)
      ? info.dividendYield * currentPrice
      : null;
  const dividendYieldFromDividend =
    currentPrice != null && Number.isFinite(info.dividend) && currentPrice > 0
      ? info.dividend / currentPrice
      : null;
  const peFromEps =
    currentPrice != null && Number.isFinite(info.eps) && info.eps !== 0
      ? currentPrice / info.eps
      : null;

  const overview = {
    marketCap: info.marketCap ?? riskInfo.metrics?.marketCap ?? null,
    peRatio: info.peRatio ?? peFromEps ?? info.forwardPE ?? null,
    eps: info.eps ?? epsFromPe ?? null,
    dividend: info.dividend ?? dividendFromYield ?? null,
    beta: info.beta ?? riskInfo.metrics?.beta ?? null,
    low52w: info["52WLow"] ?? null,
    high52w: info["52WHigh"] ?? null,
    volume: info.volume ?? null,
    averageVolume: info.averageVolume ?? riskInfo.metrics?.avgVolume ?? null,
    forwardPE: info.forwardPE ?? info.peRatio ?? peFromEps ?? null,
    dividendYield: info.dividendYield ?? dividendYieldFromDividend ?? null,
    epsForward: info.epsForward ?? info.eps ?? epsFromPe ?? null,
    priceToSales: info.priceToSalesTrailing12Months ?? null,
    priceToBook: info.priceToBook ?? null,
  };

  const overviewMetrics = [
    { key: "marketCap", label: "Market Cap", raw: overview.marketCap, text: fmtLarge(overview.marketCap) },
    { key: "peRatio", label: "P/E Ratio", raw: overview.peRatio, text: isFiniteNumber(overview.peRatio) ? Number(overview.peRatio).toFixed(2) : null },
    { key: "forwardPE", label: "Forward P/E", raw: overview.forwardPE, text: isFiniteNumber(overview.forwardPE) ? Number(overview.forwardPE).toFixed(2) : null },
    { key: "eps", label: "EPS", raw: overview.eps, text: fmtEuro(overview.eps) },
    { key: "epsForward", label: "EPS Next 5Y", raw: overview.epsForward, text: fmtEuro(overview.epsForward) },
    { key: "beta", label: "Beta", raw: overview.beta, text: isFiniteNumber(overview.beta) ? Number(overview.beta).toFixed(2) : null },
    { key: "dividend", label: "Dividendo", raw: overview.dividend, text: fmtEuro(overview.dividend) },
    {
      key: "dividendYield",
      label: "Dividend Yield",
      raw: overview.dividendYield,
      text: isFiniteNumber(overview.dividendYield) ? `${(Number(overview.dividendYield) * 100).toFixed(2)}%` : null,
    },
    { key: "priceToSales", label: "Price/Sales", raw: overview.priceToSales, text: isFiniteNumber(overview.priceToSales) ? Number(overview.priceToSales).toFixed(2) : null },
    { key: "priceToBook", label: "Price/Book", raw: overview.priceToBook, text: isFiniteNumber(overview.priceToBook) ? Number(overview.priceToBook).toFixed(2) : null },
    { key: "low52w", label: "52W Low", raw: overview.low52w, text: fmtEuro(overview.low52w) },
    { key: "high52w", label: "52W High", raw: overview.high52w, text: fmtEuro(overview.high52w) },
    { key: "volume", label: "Volume", raw: overview.volume, text: fmtLarge(overview.volume) },
    { key: "averageVolume", label: "Volume medio giornaliero", raw: overview.averageVolume, text: fmtLarge(overview.averageVolume) },
  ];


  if (loading && !ticker?.info) {
    return (
      <div className={`search-page ${darkMode ? "dark" : "light"}`}>
        <div className={`page-loading ${darkMode ? "dark" : "light"} page-loading--search`}>
          <div className="loading-title">Caricamento dati</div>
          <div className="skeleton-shell search-skeleton">
            <div className="skeleton-block" style={{ height: 32, width: 220 }} />
            <div className="search-skeleton-controls">
              <div className="skeleton-block" style={{ height: 48, flex: 1 }} />
              <div className="skeleton-block" style={{ height: 48, width: 140 }} />
            </div>
            <div className="search-skeleton-cards">
              <div className="skeleton-block skeleton-card" style={{ height: 90 }} />
              <div className="skeleton-block skeleton-card" style={{ height: 90 }} />
              <div className="skeleton-block skeleton-card" style={{ height: 90 }} />
            </div>
            <div className="search-skeleton-main">
              <div className="skeleton-block" style={{ height: 520 }} />
              <div className="search-skeleton-side">
                <div className="skeleton-block" style={{ height: 300 }} />
                <div className="skeleton-block" style={{ height: 220 }} />
              </div>
            </div>
            <div className="skeleton-block" style={{ height: 220 }} />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`search-page ${darkMode ? "dark" : "light"}`}>
      <div className="search-top">
        <h1 className="title">Cerca un titolo</h1>
        <div className="search-controls">
          <input
            placeholder={loading ? "Sto cercando..." : "Inserisci ticker (es: AAPL)"}
            value={searchInput}
            onChange={e => setSearchInput(e.target.value)}
            onKeyDown={e => e.key==="Enter" && onSearch()}
          />
          <button className="btn-primary" onClick={onSearch}>Cerca</button>
        </div>
      </div>

      {ticker?.info && (
      <div className="info-cards info-cards--top">
        <div
          className="info-card search-card"
          onClick={() =>
            navigate(`/technicals?ticker=${encodeURIComponent(symbol || searchInput)}`)
          }
          style={{ cursor: "pointer" }}
        >
          <div className="icon"><FiTrendingUp /></div>
          <div className="card-title">Tecnici</div>
          <div className="card-desc">Analisi tecnica basata su indicatori e trend.</div>
        </div>

        <div
          className="info-card search-card"
          onClick={() =>
            navigate(`/Previsione?ticker=${encodeURIComponent(symbol || searchInput)}`)
          }
          style={{ cursor: "pointer" }}
        >
          <div className="icon"><FiClock /></div>
          <div className="card-title">Previsioni</div>
          <div className="card-desc">Stime di rendimento future basate su modelli statistici.</div>
        </div>

        <div
          className="info-card search-card"
          onClick={() =>
            navigate(`/Stagionalita?ticker=${encodeURIComponent(symbol || searchInput)}`)
          }
          style={{ cursor: "pointer" }}
        >
          <div className="icon"><FiCalendar /></div>
          <div className="card-title">Stagionalita</div>
          <div className="card-desc">Trend storici e stagionali per il titolo selezionato.</div>
        </div>
      </div>
      )}

      {error && <div className="status error status--search">{error}</div>}

      {ticker?.info && (
        <div className="info-panels">
          <div className="main-info search-card">
            <div className="ticker-row">
              <div className="avatar">{symbol.charAt(0)}</div>
              <div className="titles">
                <div className="ticker-name">
                  {symbol} <span className="shortname">{ticker.info.shortName}</span>
                  <button 
                    className={`watchlist-btn ${watchlist.includes(symbol) ? "added" : ""}`}
                    onClick={addToWatchlist}
                    title={watchlist.includes(symbol) ? "Gia nella watchlist" : "Aggiungi alla watchlist"}
                  >
                    <span className="icon">{watchlist.includes(symbol) ? "OK" : "+"}</span>
                    <span className="text">
                      {watchlist.includes(symbol) ? "Gia nella watchlist" : "Aggiungi alla watchlist"}
                    </span>
                  </button>
                </div>
                <div className="sector">{ticker.info.sector || "-"}</div>
              </div>
              <div className="price-block">
                <div className="price">{fmtEuro(ticker.info.currentPrice)}</div>
                <div className={`change ${(ticker.info.dailyChange ?? 0)>=0?"up":"down"}`}>
                  {ticker.info.dailyChange ?? "-"}%
                </div>
              </div>
            </div>

            <div className="tf-chart-group">
              {TF_OPTIONS.map(tf => (
                <button key={tf} className={`tf-btn ${tf===timeframe?"active":""}`} onClick={()=>onTfClick(tf)}>
                  {timeframeLabel(tf)}
                </button>
              ))}
              <button className={`tf-btn ${chartType==="line"?"active":""}`} onClick={()=>onChartType("line")}>Linee</button>
              <button className={`tf-btn ${chartType==="candlestick"?"active":""}`} onClick={()=>onChartType("candlestick")}>Candele</button>
              <button className="tf-btn" onClick={resetZoom}>Reset Zoom</button>
            </div>

            {ticker?.ohlc && (
              <>
                <ChartWrapper ref={chartRef} data={ticker.ohlc} darkMode={darkMode} chartType={chartType} />

                <div className="performance-trend">
                  <h4 className="performance-title">
                    <span className="line-blue-vertical" />
                    <span className="title-text">Performance passata e trend</span>
                    <span className="line-blue-horizontal" />
                  </h4>

                  <div className="kv"><span>Rendimento 1Y</span><b>{ticker.performance?.return1Y ?? "-"}%</b></div>
                  <div className="kv"><span>Rendimento 3Y</span><b>{ticker.performance?.return3Y ?? "-"}%</b></div>
                  <div className="kv"><span>Rendimento 5Y</span><b>{ticker.performance?.return5Y ?? "-"}%</b></div>
                  <div className="kv"><span>Volatilita storica</span><b>{ticker.performance?.volatility ?? "-"}%</b></div>
                  <div className="kv"><span>Momentum (1M)</span><b>{ticker.performance?.momentum1M ?? "-"}%</b></div>
                  <div className="kv"><span>Momentum (3M)</span><b>{ticker.performance?.momentum3M ?? "-"}%</b></div>
                  <div className="kv"><span>Volatilita 30 giorni</span><b>{ticker.performance?.volatility30D ?? "-"}%</b></div>
                  <div className="kv"><span>Volatilita 1 anno</span><b>{ticker.performance?.volatility1Y ?? "-"}%</b></div>
                  <div className="kv"><span>Max Drawdown 1 anno</span><b>{ticker.performance?.maxDrawdown1Y ?? "-"}%</b></div>
                  <div className="kv"><span>Sharpe Ratio</span><b>{ticker.performance?.sharpeRatio ?? "-"}</b></div>
                  <div className="kv"><span>Sortino Ratio</span><b>{ticker.performance?.sortinoRatio ?? "-"}</b></div>
                </div>
              </>
            )}
          </div>

          <div className="side-panels">
            <div className="panel overview search-card overview-card">
              <div className="overview-card-header">
                <h4>Panoramica</h4>
                <span className="overview-card-ticker">{symbol || "-"}</span>
              </div>
              <div className="overview-grid">
                {overviewMetrics.map((metric) => {
                  const hasValue = metric.raw !== null && metric.raw !== undefined && (typeof metric.raw !== "number" || Number.isFinite(metric.raw));
                  return (
                    <div key={metric.key} className={`overview-item ${hasValue ? "" : "missing"}`}>
                      <span className="overview-label">{metric.label}</span>
                      <strong className="overview-value">{hasValue ? metric.text : "N/D"}</strong>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="panel risk-card search-card">
              <div className="risk-header">
                <h4>Rischio titolo</h4>
                <span className={`risk-badge risk-${riskClass}`}>{riskInfo.level}</span>
              </div>
              <div className="risk-body">
                <div className="risk-index">
                  <span>Indice rischio</span>
                  <strong>{riskIndexLabel}</strong>
                </div>
                <div className="risk-subtitle">Indice composito basato su volatilita, drawdown, beta e rendimento/rischio.</div>
                <div className="risk-kpis">
                  <div className="risk-kpi">
                    <span>Vol 1Y</span>
                    <strong>{riskInfo.metrics.vol1y != null ? `${riskInfo.metrics.vol1y.toFixed(1)}%` : "N/D"}</strong>
                  </div>
                  <div className="risk-kpi">
                    <span>Drawdown 1Y</span>
                    <strong>{riskInfo.metrics.drawdown != null ? `${riskInfo.metrics.drawdown.toFixed(1)}%` : "N/D"}</strong>
                  </div>
                  <div className="risk-kpi">
                    <span>Beta</span>
                    <strong>{riskInfo.metrics.beta != null ? riskInfo.metrics.beta.toFixed(2) : "N/D"}</strong>
                  </div>
                  <div className="risk-kpi">
                    <span>Sharpe</span>
                    <strong>{riskInfo.metrics.sharpe != null ? riskInfo.metrics.sharpe.toFixed(2) : "N/D"}</strong>
                  </div>
                  {showRiskDetails && (
                    <>
                      <div className="risk-kpi">
                        <span>Vol 30g</span>
                        <strong>{riskInfo.metrics.vol30 != null ? `${riskInfo.metrics.vol30.toFixed(1)}%` : "N/D"}</strong>
                      </div>
                      <div className="risk-kpi">
                        <span>Sortino</span>
                        <strong>{riskInfo.metrics.sortino != null ? riskInfo.metrics.sortino.toFixed(2) : "N/D"}</strong>
                      </div>
                      <div className="risk-kpi">
                        <span>Liquidita</span>
                        <strong>{liquidityLabel}</strong>
                      </div>
                      <div className="risk-kpi">
                        <span>Market Cap</span>
                        <strong>{marketCapLabel}</strong>
                      </div>
                      <div className="risk-kpi">
                        <span>Regime Vol</span>
                        <strong>{volRegimeLabel}</strong>
                      </div>
                    </>
                  )}
                </div>
                <button
                  className="risk-toggle"
                  type="button"
                  onClick={() => setShowRiskDetails((v) => !v)}
                >
                  {showRiskDetails ? "Meno" : "Altro"}
                </button>
              </div>
            </div>

            </div>

          <div className="range-row">
            {/* --- Nuova card Rendimento personalizzato --- */}
            <div className="panel custom-performance search-card">
              <h5 className="performance-title">
                    <span className="line-blue-vertical" />
                    <span className="title-text">Rendimento personalizzato</span>
                    <span className="line-blue-horizontal" />
                  </h5>
              <div className="date-inputs">
                <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} />
                <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} />
                <button className="btn-primary" onClick={calculateCustomPerformance}>Calcola</button>
              </div>
              {customPerformance && (
                <div className="custom-result">
                  <div>Prezzo iniziale: <b>{fmtEuro(customPerformance.initialPrice)}</b></div>
                  <div>Prezzo finale: <b>{fmtEuro(customPerformance.finalPrice)}</b></div>
                  <div className={customPerformance.rendimento >= 0 ? "up" : "down"}>
                    Rendimento: <b>{customPerformance.rendimento.toFixed(2)}%</b>
                  </div>
                  <div className={customPerformance.cagr >= 0 ? "up" : "down"}>
                    CAGR: <b>{customPerformance.cagr.toFixed(2)}%</b>
                  </div>
                </div>
              )}
            </div>

            <div className="panel range-overview search-card">
              <h4>Range dei prezzi</h4>
              <div className="range-combined">
                <div className="range-wrapper">
                  <div className="range-header">
                    <span className="range-min">{fmtEuro(ticker.info.dailyLow)}</span>
                    <span className="range-title">Daily Range</span>
                    <span className="range-max">{fmtEuro(ticker.info.dailyHigh)}</span>
                  </div>
                  <div className="range-bar range-daily">
                    <div
                      className="range-fill-daily"
                      style={{ width: `${percentInRange(ticker.info.dailyLow, ticker.info.dailyHigh, ticker.info.currentPrice)}%` }}
                    />
                    <div
                      className="range-current"
                      style={{ left: `${percentInRange(ticker.info.dailyLow, ticker.info.dailyHigh, ticker.info.currentPrice)}%` }}
                      title={`Prezzo attuale: ${fmtEuro(ticker.info.currentPrice)}`}
                    />
                  </div>
                </div>

                <div className="range-wrapper">
                  <div className="range-header">
                    <span className="range-min">{fmtEuro(ticker.info["52WLow"])}</span>
                    <span className="range-title">52W Range</span>
                    <span className="range-max">{fmtEuro(ticker.info["52WHigh"])}</span>
                  </div>
                  <div className="range-bar range-52w">
                    <div
                      className="range-fill-52w"
                      style={{ width: `${percentInRange(ticker.info["52WLow"], ticker.info["52WHigh"], ticker.info.currentPrice)}%` }}
                    />
                    <div
                      className="range-current"
                      style={{ left: `${percentInRange(ticker.info["52WLow"], ticker.info["52WHigh"], ticker.info.currentPrice)}%` }}
                      title={`Prezzo attuale: ${fmtEuro(ticker.info.currentPrice)}`}
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>

        </div>
      )}

    </div>
  );
}



