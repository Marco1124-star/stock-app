// src/components/Search.js
import React, { useState, useEffect, useCallback, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import ChartWrapper from "./ChartWrapper";
import FinanceSearch from "./FinanceSearch";
import "./Search.css";
import {
  FiBarChart2,
  FiCalendar,
  FiBookOpen,
  FiClock,
  FiTrendingUp,
} from "react-icons/fi";
import { apiUrl } from "../services/apiBase";
import {
  buildFallbackTickerData,
  buildPerformanceHistoryFromOhlc,
  getNonEmptyHistory,
  mergeDailyQuoteIntoHistory,
  reconcileTickerPrice,
} from "../utils/searchFallback";

const DEFAULT_TIMEFRAME = "1d";
const TF_OPTIONS = ["1h", "4h", "1d", "1w"];
const SEARCH_CACHE_TTL_MS = 120000;
const HISTORY_CACHE_TTL_MS = 120000;
const STORAGE_CACHE_PREFIX = "search-cache:v4:";
const timeframeLabel = tf => ({ "1h":"1H","4h":"4H","1d":"1D","1w":"1W" }[tf] || tf);

const normalizeTicker = (value) =>
  (value || "").trim().toUpperCase().replace(/\s+/g, "");

const roundFinite = (value, digits = 2) => {
  if (value == null || value === "") return null;
  const numericValue = Number(value);
  return Number.isFinite(numericValue)
    ? Number(numericValue.toFixed(digits))
    : null;
};

const rememberLastTicker = (value) => {
  try {
    localStorage.setItem("lastTicker", value);
  } catch {
    // La disponibilita dei dati non deve dipendere dallo storage del browser.
  }
};

const fmtCurrency = (n, currency) => {
  if (n == null) return "-";
  const numericValue = Number(n);
  if (!Number.isFinite(numericValue)) return "-";
  const currencyCode = typeof currency === "string" ? currency.trim() : "";
  const isIsoCurrency = /^[A-Z]{3}$/.test(currencyCode);

  try {
    if (isIsoCurrency) {
      return new Intl.NumberFormat("it-IT", {
        style: "currency",
        currency: currencyCode,
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(numericValue);
    }
  } catch {
    // Alcuni strumenti usano codici non ISO (ad esempio GBp).
  }

  const formatted = new Intl.NumberFormat("it-IT", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(numericValue);
  return currencyCode ? `${formatted} ${currencyCode}` : formatted;
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
  const symbolRef = useRef(initialQuery.toUpperCase());

  const [searchInput, setSearchInput] = useState(initialQuery);
  const [ticker, setTicker] = useState(null);
  const [symbol, setSymbol] = useState(initialQuery.toUpperCase());
  const [timeframe, setTimeframe] = useState(DEFAULT_TIMEFRAME);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [chartType, setChartType] = useState("line");
  const [chartFullscreen, setChartFullscreen] = useState(false);
  const [drawingTool, setDrawingTool] = useState("select");
  const [showRiskDetails, setShowRiskDetails] = useState(false);

  // Nuove variabili per rendimento personalizzato
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [customPerformance, setCustomPerformance] = useState(null);
  const [customPerformanceError, setCustomPerformanceError] = useState("");

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "instant" });
  }, []);

  useEffect(() => {
    timeframeRef.current = timeframe;
  }, [timeframe]);

  useEffect(() => {
    symbolRef.current = normalizeTicker(symbol);
  }, [symbol]);

  useEffect(() => {
    setStartDate("");
    setEndDate("");
    setCustomPerformance(null);
    setCustomPerformanceError("");
  }, [symbol]);

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
      setTicker(reconcileTickerPrice(cached.data));
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

    const fetchJsonWithRetry = async (url, attempts = 2) => {
      let lastError = null;
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        try {
          const res = await fetch(url, { signal: controller.signal });
          if (!res.ok) {
            if (res.status >= 500 && attempt < attempts - 1) {
              await new Promise((resolve) => window.setTimeout(resolve, 250 * (attempt + 1)));
              continue;
            }
            return { ok: false, res };
          }
          const data = await res.json();
          return { ok: true, res, data };
        } catch (requestError) {
          if (requestError?.name === "AbortError") throw requestError;
          lastError = requestError;
          if (attempt < attempts - 1) {
            await new Promise((resolve) => window.setTimeout(resolve, 250 * (attempt + 1)));
          }
        }
      }
      return { ok: false, res: null, error: lastError };
    };

    const tryFetch = tfToUse => {
      const url = apiUrl(
        `/stock/${encodeURIComponent(normalized)}?timeframe=${tfToUse}`
      );
      return fetchJsonWithRetry(url);
    };
    const tryFetchHistory = tfToUse =>
      fetchJsonWithRetry(
        apiUrl(
          `/stock/${encodeURIComponent(normalized)}/history?timeframe=${tfToUse}`
        )
      );

    try {
      let result = await tryFetch(tf);
      let resolvedTimeframe = tf;
      if (!result.ok && tf !== "1d") {
        result = await tryFetch("1d");
        if (result.ok) {
          resolvedTimeframe = "1d";
          setTimeframe("1d");
        }
      }
      if (!result.ok) {
        // Prezzo e storico hanno endpoint indipendenti: un errore nelle metriche
        // avanzate non deve far sparire un grafico che è ancora disponibile.
        let [priceResult, historyResult] = await Promise.all([
          fetchJsonWithRetry(
            apiUrl(`/stock/${encodeURIComponent(normalized)}?priceOnly=true`)
          ),
          tryFetchHistory(tf),
        ]);
        let recoveredHistory = historyResult.ok
          ? getNonEmptyHistory(historyResult.data)
          : [];

        if (!recoveredHistory.length && tf !== "1d") {
          historyResult = await tryFetchHistory("1d");
          recoveredHistory = historyResult.ok
            ? getNonEmptyHistory(historyResult.data)
            : [];
          if (recoveredHistory.length) {
            resolvedTimeframe = "1d";
            setTimeframe("1d");
          }
        }

        const fallbackData = buildFallbackTickerData({
          symbol: normalized,
          cachedData: cached?.data,
          priceData: priceResult.ok ? priceResult.data : null,
          history: recoveredHistory,
        });

        if (
          priceResult.ok
          || fallbackData.ohlc.length
          || cached?.data?.info
        ) {
          if (requestId !== requestSeqRef.current) return;
          setTicker(fallbackData);
          setSymbol(normalized);
          rememberLastTicker(normalized);
          if (recoveredHistory.length) {
            writeCache(`history:${normalized}|${resolvedTimeframe}`, {
              history: recoveredHistory,
            });
          }
          setError(
            fallbackData.ohlc.length
              ? ""
              : "Storico temporaneamente non disponibile. Riprova tra poco."
          );
          return;
        }

        const errorResponse = result.res || priceResult.res || historyResult.res;
        const msg = errorResponse
          ? await parseError(errorResponse)
          : "Connessione interrotta durante il caricamento. Riprova.";
        if (requestId !== requestSeqRef.current) return;
        setError(cached?.data?.info ? "" : msg);
        return;
      }
      let data = result.data;
      if (requestId !== requestSeqRef.current) return;

      if (!Array.isArray(data.performanceHistory) && Array.isArray(data.ohlc)) {
        data.performanceHistory = buildPerformanceHistoryFromOhlc(data.ohlc);
      }

      if (data.info) {
        ["currentPrice", "previousClose", "marketCap", "dividend", "eps", "epsForward", "52WLow", "52WHigh", "dailyOpen", "dailyLow", "dailyHigh", "dailyChange"].forEach(key => {
          const roundedValue = roundFinite(data.info[key]);
          if (roundedValue != null) data.info[key] = roundedValue;
        });
      }

      data = reconcileTickerPrice(data);
      setTicker(data);
      setError("");
      writeCache(`stock:${normalized}|${resolvedTimeframe}`, data);
      setSymbol(normalized.toUpperCase());
      rememberLastTicker(normalized.toUpperCase());

    } catch(e) {
      if (e?.name === "AbortError") return;
      console.error(e);
      if (requestId !== requestSeqRef.current) return;
      setError(cached?.data?.info ? "" : "Errore nella richiesta");
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
    const cachedHistory = getNonEmptyHistory(cached?.data);
    if (cachedHistory.length) {
      setTicker((prev) =>
        prev ? reconcileTickerPrice({ ...prev, ohlc: cachedHistory }) : prev
      );
      setError("");
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
      const history = getNonEmptyHistory(data);
      if (!history.length) {
        throw new Error("La risposta non contiene candele valide");
      }
      setTicker((prev) =>
        prev ? reconcileTickerPrice({ ...prev, ohlc: history }) : prev
      );
      writeCache(cacheKey, { history });
      setError("");
    } catch (e) {
      if (e?.name === "AbortError") return;
      console.error(e);
      if (requestId !== historySeqRef.current) return;
      if (!cachedHistory.length) {
        setError("Storico temporaneamente non disponibile per questo timeframe.");
      }
    } finally {
      if (requestId === historySeqRef.current) {
        setLoading(false);
      }
    }
  }, [readCache, writeCache]);

  const fetchLivePrice = useCallback(async () => {
    if (!symbol || loading) return;
    const expectedSymbol = normalizeTicker(symbol);
    try {
      const res = await fetch(
        apiUrl(`/stock/${encodeURIComponent(expectedSymbol)}?priceOnly=true`)
      );
      if (!res.ok) return;
      const data = await res.json();
      if (data.info) {
        setTicker(prev => {
          if (!prev || symbolRef.current !== expectedSymbol) return prev;
          const previousInfo = prev.info || {};
          const liveInfo = { ...previousInfo };

          ["currentPrice", "previousClose", "dailyOpen", "dailyLow", "dailyHigh", "dailyChange"].forEach((key) => {
            const roundedValue = roundFinite(data.info[key]);
            if (roundedValue != null) liveInfo[key] = roundedValue;
          });
          ["currency", "priceDate", "priceTimestamp", "priceSource", "marketState"].forEach((key) => {
            if (data.info[key] != null && data.info[key] !== "") {
              liveInfo[key] = data.info[key];
            }
          });

          let updatedTicker = {
            ...prev,
            info: liveInfo,
          };

          if (timeframeRef.current === "1d") {
            updatedTicker.ohlc = mergeDailyQuoteIntoHistory(
              prev.ohlc,
              liveInfo
            );
          }
          return reconcileTickerPrice(updatedTicker);
        });
      }
    } catch(e){ console.error("Errore live price:", e); }
  }, [loading, symbol]);



  useEffect(() => {
    if (!initialQuery) return;
    setSearchInput(initialQuery);
    fetchTicker(initialQuery, timeframeRef.current);
  }, [initialQuery, fetchTicker]);

  useEffect(() => {
    if (!symbol) return;
    fetchLivePrice();
    const interval = setInterval(() => fetchLivePrice(), 10000);
    return () => clearInterval(interval);
  }, [fetchLivePrice, symbol]);

  const onSearch = (value = searchInput) => {
    const normalized = normalizeTicker(value);
    if (!normalized) return;
    setSearchInput(normalized);
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
    setCustomPerformance(null);
    setCustomPerformanceError("");
    if (!startDate || !endDate) {
      setCustomPerformanceError("Seleziona entrambe le date.");
      return;
    }
    if (startDate > endDate) {
      setCustomPerformanceError("La data iniziale deve precedere quella finale.");
      return;
    }

    const history = Array.isArray(ticker?.performanceHistory)
      ? ticker.performanceHistory
      : [];
    const filtered = history.filter(
      point => point.date >= startDate && point.date <= endDate && Number(point.close) > 0
    );

    if (filtered.length < 2) {
      setCustomPerformanceError("Servono almeno due sedute disponibili nell'intervallo.");
      return;
    }

    const firstPoint = filtered[0];
    const lastPoint = filtered[filtered.length - 1];
    const initialPrice = Number(firstPoint.close);
    const finalPrice = Number(lastPoint.close);

    const rendimento = ((finalPrice - initialPrice) / initialPrice) * 100;
    const startTimestamp = Date.parse(`${firstPoint.date}T00:00:00Z`);
    const endTimestamp = Date.parse(`${lastPoint.date}T00:00:00Z`);
    const days = (endTimestamp - startTimestamp) / (1000 * 60 * 60 * 24);
    if (!Number.isFinite(days) || days <= 0) {
      setCustomPerformanceError("Intervallo non valido per il calcolo.");
      return;
    }
    const years = days / 365.25;
    const cagr = Math.pow(finalPrice / initialPrice, 1 / years) - 1;

    setCustomPerformance({
      initialPrice,
      finalPrice,
      rendimento,
      cagr: cagr * 100,
      actualStartDate: firstPoint.date,
      actualEndDate: lastPoint.date,
    });
  };

  const riskInfo = ticker?.risk || { level: "N/D", index: null, metrics: {} };
  const riskMetrics = riskInfo.metrics || {};
  const riskIndexLabel = riskInfo.index != null ? `${riskInfo.index}/100` : "N/D";
  const riskClass = riskInfo.level === "N/D" ? "nd" : riskInfo.level.toLowerCase();
  const info = ticker?.info || {};
  const currency = typeof info.currency === "string" ? info.currency.trim() : "";
  const currencySuffix = currency ? ` ${currency}` : "";
  const averageTradedValue = riskMetrics.avgTradedValue ?? riskMetrics.avgDollarVolume;
  const liquidityLabel = averageTradedValue != null
    ? `${fmtLarge(averageTradedValue)}${currencySuffix}`
    : (riskMetrics.avgVolume != null ? `${fmtLarge(riskMetrics.avgVolume)} vol` : "N/D");
  const marketCapLabel = riskMetrics.marketCap != null
    ? `${fmtLarge(riskMetrics.marketCap)}${currencySuffix}`
    : "N/D";
  const volRegimeLabel = riskMetrics.volRegime != null ? `${riskMetrics.volRegime.toFixed(2)}x` : "N/D";
  const currentPrice = Number.isFinite(info.currentPrice) ? info.currentPrice : null;
  const dividendFromYield =
    currentPrice != null && Number.isFinite(info.dividendYield)
      ? info.dividendYield * currentPrice
      : null;
  const dividendYieldFromDividend =
    currentPrice != null && Number.isFinite(info.dividend) && currentPrice > 0
      ? info.dividend / currentPrice
      : null;
  const performanceHistory = Array.isArray(ticker?.performanceHistory)
    ? ticker.performanceHistory
    : [];
  const firstAvailableDate = performanceHistory[0]?.date || undefined;
  const lastAvailableDate = performanceHistory[performanceHistory.length - 1]?.date || undefined;

  const overview = {
    marketCap: info.marketCap ?? riskMetrics.marketCap ?? null,
    peRatio: info.peRatio ?? null,
    eps: info.eps ?? null,
    dividend: info.dividend ?? dividendFromYield ?? null,
    beta: info.beta ?? riskMetrics.beta ?? null,
    low52w: info["52WLow"] ?? null,
    high52w: info["52WHigh"] ?? null,
    volume: info.volume ?? null,
    averageVolume: info.averageVolume ?? riskMetrics.avgVolume ?? null,
    forwardPE: info.forwardPE ?? null,
    dividendYield: info.dividendYield ?? dividendYieldFromDividend ?? null,
    epsForward: info.epsForward ?? null,
    priceToSales: info.priceToSalesTrailing12Months ?? null,
    priceToBook: info.priceToBook ?? null,
  };

  const overviewMetrics = [
    { key: "marketCap", label: "Market Cap", raw: overview.marketCap, text: `${fmtLarge(overview.marketCap)}${currencySuffix}` },
    { key: "peRatio", label: "P/E Ratio", raw: overview.peRatio, text: isFiniteNumber(overview.peRatio) ? Number(overview.peRatio).toFixed(2) : null },
    { key: "forwardPE", label: "Forward P/E", raw: overview.forwardPE, text: isFiniteNumber(overview.forwardPE) ? Number(overview.forwardPE).toFixed(2) : null },
    { key: "eps", label: "EPS (TTM)", raw: overview.eps, text: fmtCurrency(overview.eps, currency) },
    { key: "epsForward", label: "EPS Forward", raw: overview.epsForward, text: fmtCurrency(overview.epsForward, currency) },
    { key: "beta", label: "Beta", raw: overview.beta, text: isFiniteNumber(overview.beta) ? Number(overview.beta).toFixed(2) : null },
    { key: "dividend", label: "Dividendo", raw: overview.dividend, text: fmtCurrency(overview.dividend, currency) },
    {
      key: "dividendYield",
      label: "Dividend Yield",
      raw: overview.dividendYield,
      text: isFiniteNumber(overview.dividendYield) ? `${(Number(overview.dividendYield) * 100).toFixed(2)}%` : null,
    },
    { key: "priceToSales", label: "Price/Sales", raw: overview.priceToSales, text: isFiniteNumber(overview.priceToSales) ? Number(overview.priceToSales).toFixed(2) : null },
    { key: "priceToBook", label: "Price/Book", raw: overview.priceToBook, text: isFiniteNumber(overview.priceToBook) ? Number(overview.priceToBook).toFixed(2) : null },
    { key: "low52w", label: "52W Low", raw: overview.low52w, text: fmtCurrency(overview.low52w, currency) },
    { key: "high52w", label: "52W High", raw: overview.high52w, text: fmtCurrency(overview.high52w, currency) },
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
      <div className="search-top search-hero search-hero--compact">
        <FinanceSearch value={searchInput} onChange={setSearchInput} onSelect={onSearch} />
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
        </div>

        <div
          className="info-card search-card"
          onClick={() =>
            navigate(`/bilancio?ticker=${encodeURIComponent(symbol || searchInput)}`)
          }
          style={{ cursor: "pointer" }}
        >
          <div className="icon"><FiBookOpen /></div>
          <div className="card-title">Bilancio</div>
        </div>

        <div
          className="info-card search-card"
          onClick={() =>
            navigate(`/quantitativi?ticker=${encodeURIComponent(symbol || searchInput)}`)
          }
          style={{ cursor: "pointer" }}
        >
          <div className="icon"><FiBarChart2 /></div>
          <div className="card-title">Quantitativi</div>
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
                <div className="price">{fmtCurrency(ticker.info.currentPrice, currency)}</div>
                <div className={`change ${(ticker.info.dailyChange ?? 0)>=0?"up":"down"}`}>
                  {ticker.info.dailyChange ?? "-"}%
                </div>
              </div>
            </div>

            <div className={`tf-chart-group${chartFullscreen ? " tf-chart-group--fullscreen" : ""}`}>
              {TF_OPTIONS.map(tf => (
                <button key={tf} className={`tf-btn ${tf===timeframe?"active":""}`} onClick={()=>onTfClick(tf)}>
                  {timeframeLabel(tf)}
                </button>
              ))}
              <button className={`tf-btn ${chartType==="line"?"active":""}`} onClick={()=>onChartType("line")}>Linee</button>
              <button className={`tf-btn ${chartType==="candlestick"?"active":""}`} onClick={()=>onChartType("candlestick")}>Candele</button>
              <button className="tf-btn" onClick={resetZoom}>Reset Zoom</button>
              <button className={`tf-btn ${chartFullscreen ? "active" : ""}`} onClick={() => setChartFullscreen((value) => !value)}>
                {chartFullscreen ? "Chiudi schermo intero" : "Schermo intero"}
              </button>
              {chartFullscreen && (
                <>
                  <button className={`tf-btn ${drawingTool === "pen" ? "active" : ""}`} onClick={() => setDrawingTool("pen")}>Disegno libero</button>
                  <button className={`tf-btn ${drawingTool === "line" ? "active" : ""}`} onClick={() => setDrawingTool("line")}>Linea</button>
                  <button className={`tf-btn ${drawingTool === "ray" ? "active" : ""}`} onClick={() => setDrawingTool("ray")}>Ray</button>
                  <button className={`tf-btn ${drawingTool === "horizontal" ? "active" : ""}`} onClick={() => setDrawingTool("horizontal")}>Orizzontale</button>
                  <button className={`tf-btn ${drawingTool === "vertical" ? "active" : ""}`} onClick={() => setDrawingTool("vertical")}>Verticale</button>
                  <button className={`tf-btn ${drawingTool === "rectangle" ? "active" : ""}`} onClick={() => setDrawingTool("rectangle")}>Rettangolo</button>
                  <button className={`tf-btn ${drawingTool === "fibonacci" ? "active" : ""}`} onClick={() => setDrawingTool("fibonacci")}>Fibonacci</button>
                  <button className={`tf-btn ${drawingTool === "eraser" ? "active" : ""}`} onClick={() => setDrawingTool("eraser")}>Cancella ultimo</button>
                  <button className={`tf-btn ${drawingTool === "select" ? "active" : ""}`} onClick={() => setDrawingTool("select")}>Seleziona</button>
                </>
              )}
            </div>

            {Array.isArray(ticker?.ohlc) && ticker.ohlc.length > 0 && (
              <>
                <ChartWrapper ref={chartRef} data={ticker.ohlc} darkMode={darkMode} chartType={chartType} fullscreen={chartFullscreen} drawingTool={drawingTool} />

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
                  <div className="kv"><span>Volatilita 30 sedute</span><b>{ticker.performance?.volatility30D ?? "-"}%</b></div>
                  <div className="kv"><span>Volatilita 1 anno</span><b>{ticker.performance?.volatility1Y ?? "-"}%</b></div>
                  <div className="kv"><span>Max Drawdown 1 anno</span><b>{ticker.performance?.maxDrawdown1Y ?? "-"}%</b></div>
                  <div className="kv"><span>Sharpe Ratio (1Y)</span><b>{ticker.performance?.sharpeRatio ?? "-"}</b></div>
                  <div className="kv"><span>Sortino Ratio (1Y)</span><b>{ticker.performance?.sortinoRatio ?? "-"}</b></div>
                  <div className="kv"><span>Tasso privo di rischio</span><b>{ticker.performance?.riskFreeRate ?? 0}%</b></div>
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
                <div className="risk-subtitle">
                  Stima proprietaria basata su volatilita, drawdown, beta e rendimento corretto per il rischio
                  {riskInfo.coverage != null ? ` (copertura ${riskInfo.coverage}%).` : "."}
                </div>
                <div className="risk-kpis">
                  <div className="risk-kpi">
                    <span>Vol 1Y</span>
                    <strong>{riskMetrics.vol1y != null ? `${riskMetrics.vol1y.toFixed(1)}%` : "N/D"}</strong>
                  </div>
                  <div className="risk-kpi">
                    <span>Drawdown 1Y</span>
                    <strong>{riskMetrics.drawdown != null ? `${riskMetrics.drawdown.toFixed(1)}%` : "N/D"}</strong>
                  </div>
                  <div className="risk-kpi">
                    <span>Beta</span>
                    <strong>{riskMetrics.beta != null ? riskMetrics.beta.toFixed(2) : "N/D"}</strong>
                  </div>
                  <div className="risk-kpi">
                    <span>Sharpe</span>
                    <strong>{riskMetrics.sharpe != null ? riskMetrics.sharpe.toFixed(2) : "N/D"}</strong>
                  </div>
                  {showRiskDetails && (
                    <>
                      <div className="risk-kpi">
                        <span>Vol 30 sedute</span>
                        <strong>{riskMetrics.vol30 != null ? `${riskMetrics.vol30.toFixed(1)}%` : "N/D"}</strong>
                      </div>
                      <div className="risk-kpi">
                        <span>Sortino</span>
                        <strong>{riskMetrics.sortino != null ? riskMetrics.sortino.toFixed(2) : "N/D"}</strong>
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
                      <div className="risk-kpi">
                        <span>Risk-free</span>
                        <strong>{riskMetrics.riskFreeRate != null ? `${riskMetrics.riskFreeRate}%` : "N/D"}</strong>
                      </div>
                      {riskMetrics.benchmarkSymbol && (
                        <div className="risk-kpi">
                          <span>Benchmark beta</span>
                          <strong>{riskMetrics.benchmarkSymbol}</strong>
                        </div>
                      )}
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
              <p className="custom-performance-note">
                Basato sulle chiusure giornaliere rettificate per split e dividendi.
              </p>
              <div className="date-inputs">
                <input
                  type="date"
                  value={startDate}
                  min={firstAvailableDate}
                  max={lastAvailableDate}
                  onChange={e => {
                    setStartDate(e.target.value);
                    setCustomPerformanceError("");
                  }}
                />
                <input
                  type="date"
                  value={endDate}
                  min={firstAvailableDate}
                  max={lastAvailableDate}
                  onChange={e => {
                    setEndDate(e.target.value);
                    setCustomPerformanceError("");
                  }}
                />
                <button className="btn-primary" onClick={calculateCustomPerformance}>Calcola</button>
              </div>
              {customPerformanceError && (
                <div className="custom-performance-error">{customPerformanceError}</div>
              )}
              {customPerformance && (
                <div className="custom-result">
                  <div>
                    Chiusura iniziale ({customPerformance.actualStartDate}):
                    <b>{fmtCurrency(customPerformance.initialPrice, currency)}</b>
                  </div>
                  <div>
                    Chiusura finale ({customPerformance.actualEndDate}):
                    <b>{fmtCurrency(customPerformance.finalPrice, currency)}</b>
                  </div>
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
                    <span className="range-min">{fmtCurrency(ticker.info.dailyLow, currency)}</span>
                    <span className="range-title">Daily Range</span>
                    <span className="range-max">{fmtCurrency(ticker.info.dailyHigh, currency)}</span>
                  </div>
                  <div className="range-bar range-daily">
                    <div
                      className="range-fill-daily"
                      style={{ width: `${percentInRange(ticker.info.dailyLow, ticker.info.dailyHigh, ticker.info.currentPrice)}%` }}
                    />
                    <div
                      className="range-current"
                      style={{ left: `${percentInRange(ticker.info.dailyLow, ticker.info.dailyHigh, ticker.info.currentPrice)}%` }}
                      title={`Prezzo attuale: ${fmtCurrency(ticker.info.currentPrice, currency)}`}
                    />
                  </div>
                </div>

                <div className="range-wrapper">
                  <div className="range-header">
                    <span className="range-min">{fmtCurrency(ticker.info["52WLow"], currency)}</span>
                    <span className="range-title">52W Range</span>
                    <span className="range-max">{fmtCurrency(ticker.info["52WHigh"], currency)}</span>
                  </div>
                  <div className="range-bar range-52w">
                    <div
                      className="range-fill-52w"
                      style={{ width: `${percentInRange(ticker.info["52WLow"], ticker.info["52WHigh"], ticker.info.currentPrice)}%` }}
                    />
                    <div
                      className="range-current"
                      style={{ left: `${percentInRange(ticker.info["52WLow"], ticker.info["52WHigh"], ticker.info.currentPrice)}%` }}
                      title={`Prezzo attuale: ${fmtCurrency(ticker.info.currentPrice, currency)}`}
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



