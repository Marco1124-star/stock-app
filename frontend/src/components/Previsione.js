// src/components/SupplyDemand.js
import React, { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import axios from "axios";
import { Chart } from "react-chartjs-2";
import Plot from "react-plotly.js";
import "./previsione.css";
import "./TechnicalsPage";
import zoomPlugin from "chartjs-plugin-zoom";

import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  TimeScale,
  LineController,
  PointElement,
  LineElement,
  Tooltip,
  Legend,
} from "chart.js";
import { CandlestickController, CandlestickElement } from "chartjs-chart-financial";
import "chartjs-adapter-date-fns";

import { FiSearch, FiBarChart2, FiCalendar } from "react-icons/fi";
import { computeUnifiedTradingSignal } from "../utils/tradingSignal";
import { apiUrl } from "../services/apiBase";

ChartJS.register(
  CategoryScale,
  LinearScale,
  TimeScale,
  LineController,
  PointElement,
  LineElement,
  Tooltip,
  Legend,
  CandlestickController,
  CandlestickElement,
  zoomPlugin
);

export default function SupplyDemandChart({ darkMode }) {
  const location = useLocation();
  const navigate = useNavigate();
  const normalizeTicker = (value) =>
    (value || "").trim().toUpperCase().replace(/\s+/g, "");

  const queryTicker = normalizeTicker(
    new URLSearchParams(location.search).get("ticker")
  );

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [symbol, setSymbol] = useState(queryTicker?.toUpperCase() || "");
  const [history, setHistory] = useState([]);
  const [timeframe, setTimeframe] = useState("1d");
  const [chartType, setChartType] = useState("line");
  const [zones, setZones] = useState({ support: [], resistance: [] });
  const [price, setPrice] = useState(0);
  const [sdPrice, setSdPrice] = useState(0);
  const [marketState, setMarketState] = useState({ state: "IN_NONE", strength: 0 });
  const [zones1DSignal, setZones1DSignal] = useState({ support: [], resistance: [] });
  const [zones1WSignal, setZones1WSignal] = useState({ support: [], resistance: [] });
  const [zones1M, setZones1M] = useState({ support: [], resistance: [] });
  const [techSummary, setTechSummary] = useState({
    general: "Neutral",
    totalCounts: { Buy: 0, Sell: 0, Neutral: 0 },
    strength: 0,
    strengthLabel: "Weak",
  });
  const [loadingTech, setLoadingTech] = useState(false);
  const [errorTech, setErrorTech] = useState("");
  const [seasonData, setSeasonData] = useState(null);
  const [loadingSeason, setLoadingSeason] = useState(false);
  const [errorSeason, setErrorSeason] = useState("");
  const [excludeOutliers, setExcludeOutliers] = useState(false);
  const [rawSeasonData, setRawSeasonData] = useState(null);
  const [gapHistory5Y, setGapHistory5Y] = useState([]);
  const [gapXAxisTitle, setGapXAxisTitle] = useState("Periodo (ultimi 5 anni)");
  const [minYear, setMinYear] = useState(null);
  const [maxYear, setMaxYear] = useState(null);
  const [selectedYears, setSelectedYears] = useState([]);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [strengthPct, setStrengthPct] = useState("");
  const [minDistancePct, setMinDistancePct] = useState("");
  const [gapPct, setGapPct] = useState("");
  const [draftStrength, setDraftStrength] = useState("");
  const [draftMinDistance, setDraftMinDistance] = useState("");
  const [draftGap, setDraftGap] = useState("");

  const rangeRef = useRef(null);
  const gapChartRef = useRef(null);
  const fetchSeqRef = useRef(0);
  const fetchAbortRef = useRef(null);
  const technicalCacheRef = useRef(new Map());
  const seasonalityCacheRef = useRef(new Map());
  const mainDataCacheRef = useRef(new Map());
  const monthlyZonesCacheRef = useRef(new Map());
  const gapHistoryCacheRef = useRef(new Map());

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "instant" });
  }, [queryTicker]);

  useEffect(() => {
    setSymbol(queryTicker?.toUpperCase() || "");
  }, [queryTicker]);

  useEffect(() => {
    return () => {
      if (fetchAbortRef.current) {
        fetchAbortRef.current.abort();
      }
    };
  }, []);

  

  const clampNumber = (value, min, max) => {
    if (value === "" || value === null || value === undefined) return "";
    const num = Number(value);
    if (Number.isNaN(num)) return "";
    if (num < min) return String(min);
    if (num > max) return String(max);
    return String(num);
  };

  const formatPrice = (value) => {
    if (value === null || value === undefined || Number.isNaN(value)) return "-";
    return new Intl.NumberFormat("it-IT", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value);
  };

  const formatPercent = (value, digits = 2) => {
    if (value === null || value === undefined || Number.isNaN(value)) return "-";
    return `${Number(value).toFixed(digits)}%`;
  };

  const formatSignedPercent = (value, digits = 1) => {
    if (value === null || value === undefined || Number.isNaN(value)) return "-";
    const num = Number(value);
    return `${num > 0 ? "+" : ""}${num.toFixed(digits)}%`;
  };

  const formatRiskReward = (value) => {
    if (value === null || value === undefined || Number.isNaN(value)) return "-";
    return `${Number(value).toFixed(2)}x`;
  };

  const rrTone = (value) => {
    if (!Number.isFinite(value)) return "neutral";
    if (value >= 1.5) return "strong";
    if (value >= 1) return "ok";
    return "weak";
  };

  const displayGapType = (type) => {
    const swapMap = {
      "Gap Up": "Gap Down",
      "Gap Down": "Gap Up",
      "Gap Up 3 candele": "Gap Down 3 candele",
      "Gap Down 3 candele": "Gap Up 3 candele",
    };
    return swapMap[type] || type || "Gap";
  };

  const parseHistoryDate = useCallback((value) => {
    if (!value) return null;
    const normalizedValue =
      typeof value === "string" && /^\d{4}-\d{2}$/.test(value)
        ? `${value}-01`
        : value;
    const parsed = new Date(normalizedValue);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }, []);

  const formatMonthYear = (value) => {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return "-";
    return new Intl.DateTimeFormat("it-IT", {
      month: "short",
      year: "numeric",
    }).format(date);
  };

  const normalizeGapRows = useCallback(
    (rows) =>
      (Array.isArray(rows) ? rows : [])
        .map((row, index) => {
          const open = Number(row.open);
          const high = Number(row.high);
          const low = Number(row.low);
          const close = Number(row.close);
          const dateObj = parseHistoryDate(row.date);
          return {
            index,
            date: row.date,
            dateObj,
            open,
            high,
            low,
            close,
          };
        })
        .filter(
          (row) =>
            row.dateObj &&
            Number.isFinite(row.open) &&
            Number.isFinite(row.high) &&
            Number.isFinite(row.low) &&
            Number.isFinite(row.close)
        ),
    [parseHistoryDate]
  );

  const findGapsLikePortify = useCallback((rows, thresholdPct = 0.01) => {
    const gaps = [];
    if (!Array.isArray(rows) || rows.length < 2) return gaps;

    for (let i = 1; i < rows.length; i += 1) {
      const prev = rows[i - 1];
      const curr = rows[i];

      if (curr.low > prev.high * (1 + thresholdPct)) {
        gaps.push({
          index: i,
          date: curr.date,
          dateObj: curr.dateObj,
          type: "Gap Up",
          start: prev.high,
          end: curr.low,
          direction: "up",
        });
      } else if (curr.high < prev.low * (1 - thresholdPct)) {
        gaps.push({
          index: i,
          date: curr.date,
          dateObj: curr.dateObj,
          type: "Gap Down",
          start: curr.high,
          end: prev.low,
          direction: "down",
        });
      }
    }

    for (let i = 2; i < rows.length; i += 1) {
      const c1 = rows[i - 2];
      const c2 = rows[i - 1];
      const c3 = rows[i];

      const threeGreen =
        c1.close > c1.open && c2.close > c2.open && c3.close > c3.open;
      const threeRed =
        c1.close < c1.open && c2.close < c2.open && c3.close < c3.open;

      if (threeGreen && c3.low >= c1.high) {
        gaps.push({
          index: i,
          date: c3.date,
          dateObj: c3.dateObj,
          type: "Gap Up 3 candele",
          start: c1.high,
          end: c3.low,
          direction: "up",
        });
      } else if (threeRed && c3.high <= c1.low) {
        gaps.push({
          index: i,
          date: c3.date,
          dateObj: c3.dateObj,
          type: "Gap Down 3 candele",
          start: c3.high,
          end: c1.low,
          direction: "down",
        });
      }
    }

    return gaps;
  }, []);

  const computeGapFillPct = useCallback((gap, candle) => {
    const start = Number(gap?.start);
    const end = Number(gap?.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;

    const lower = Math.min(start, end);
    const upper = Math.max(start, end);
    const size = upper - lower;
    if (!(size > 0)) return 0;

    const isGapUp = gap.type === "Gap Up" || gap.type === "Gap Up 3 candele";
    if (isGapUp) {
      const low = Number(candle?.low);
      if (!Number.isFinite(low)) return 0;
      const fillAmount = upper - Math.max(low, lower);
      return Math.max(0, Math.min(100, (fillAmount / size) * 100));
    }

    const high = Number(candle?.high);
    if (!Number.isFinite(high)) return 0;
    const fillAmount = Math.min(high, upper) - lower;
    return Math.max(0, Math.min(100, (fillAmount / size) * 100));
  }, []);

  const markClosedGapsLikePortify = useCallback(
    (rows, gaps) =>
      (Array.isArray(gaps) ? gaps : []).map((gap) => {
        const closeThresholdPct = 50;
        let closed = false;
        let maxFillPct = 0;

        for (let i = gap.index + 1; i < rows.length; i += 1) {
          const candle = rows[i];
          const fillPct = computeGapFillPct(gap, candle);
          if (fillPct > maxFillPct) maxFillPct = fillPct;
          if (maxFillPct >= closeThresholdPct) {
            closed = true;
            break;
          }
        }

        const absSize = Math.abs(gap.end - gap.start);
        const signedSize = gap.direction === "up" ? absSize : -absSize;
        const base = Math.max(Math.abs(gap.start), 1e-9);
        const signedPct = (signedSize / base) * 100;

        return {
          ...gap,
          closed,
          fillPct: maxFillPct,
          absSize,
          signedPct,
        };
      }),
    [computeGapFillPct]
  );

  const gapCloseProbability = useCallback((rows, gaps, lookaheadCandles = 10) => {
    if (!Array.isArray(gaps) || gaps.length === 0) return null;

    let closedCount = 0;
    gaps.forEach((gap) => {
      const future = rows.slice(gap.index + 1, gap.index + 1 + lookaheadCandles);
      if (future.length === 0) return;
      const maxFillPct = future.reduce(
        (maxValue, candle) => Math.max(maxValue, computeGapFillPct(gap, candle)),
        0
      );
      if (maxFillPct >= 50) closedCount += 1;
    });

    return (closedCount / gaps.length) * 100;
  }, [computeGapFillPct]);

  const gapCloseProbabilityByType = useCallback((rows, gaps, lookaheadCandles = 10) => {
    if (!Array.isArray(gaps) || gaps.length === 0) return {};
    const grouped = {};

    gaps.forEach((gap) => {
      if (!grouped[gap.type]) grouped[gap.type] = { total: 0, closed: 0 };
      grouped[gap.type].total += 1;

      const future = rows.slice(gap.index + 1, gap.index + 1 + lookaheadCandles);
      if (future.length === 0) return;
      const maxFillPct = future.reduce(
        (maxValue, candle) => Math.max(maxValue, computeGapFillPct(gap, candle)),
        0
      );
      if (maxFillPct >= 50) grouped[gap.type].closed += 1;
    });

    return Object.fromEntries(
      Object.entries(grouped).map(([type, value]) => [
        type,
        value.total > 0 ? (value.closed / value.total) * 100 : null,
      ])
    );
  }, [computeGapFillPct]);

  const computeCumulativePercentiles = (curveData, years) => {
    if (!curveData || !years || years.length === 0) return [];
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

  const computeTradeMonths = (cumulativePercentiles, months) => {
    if (!cumulativePercentiles || cumulativePercentiles.length === 0) {
      return { buyMonth: null, sellMonth: null };
    }
    const cumMedian = cumulativePercentiles.map((p) => p.median);
    const minIndex = cumMedian.indexOf(Math.min(...cumMedian));
    let maxIndex = minIndex;
    let maxValue = cumMedian[minIndex];
    for (let i = minIndex + 1; i < cumMedian.length; i++) {
      if (cumMedian[i] > maxValue) {
        maxValue = cumMedian[i];
        maxIndex = i;
      }
    }
    return {
      buyMonth: months[minIndex],
      sellMonth: months[maxIndex],
    };
  };

  const buildAdvancedParams = useCallback(
    (tfValue) => {
      const params = new URLSearchParams({ timeframe: tfValue });
      if (strengthPct !== "") params.set("strength", strengthPct);
      if (minDistancePct !== "") params.set("min_pct", minDistancePct);
      if (gapPct !== "") params.set("gap_pct", gapPct);
      return params;
    },
    [strengthPct, minDistancePct, gapPct]
  );

  const clearSymbolCaches = useCallback(() => {
    if (!symbol) return;
    const prefix = `${symbol}|`;

    Array.from(mainDataCacheRef.current.keys()).forEach((key) => {
      if (key.startsWith(prefix)) mainDataCacheRef.current.delete(key);
    });
    Array.from(monthlyZonesCacheRef.current.keys()).forEach((key) => {
      if (key.startsWith(prefix)) monthlyZonesCacheRef.current.delete(key);
    });
  }, [symbol]);

  const fetchData = useCallback(async () => {
    if (!symbol) {
      setError("Nessun ticker specificato");
      setLoading(false);
      return;
    }

    if (fetchAbortRef.current) {
      fetchAbortRef.current.abort();
    }
    const controller = new AbortController();
    fetchAbortRef.current = controller;
    const requestId = ++fetchSeqRef.current;

    const cacheKey = `${symbol}|${timeframe}|${strengthPct}|${minDistancePct}|${gapPct}`;
    const cached = mainDataCacheRef.current.get(cacheKey);
    if (cached && Date.now() - cached.ts < 60_000) {
      if (requestId !== fetchSeqRef.current) return;
      setHistory(cached.data.history || []);
      setZones(cached.data.zones || { support: [], resistance: [] });
      setSdPrice(cached.data.sdPrice ?? 0);
      setPrice(cached.data.price ?? 0);
      setMarketState(cached.data.marketState || { state: "IN_NONE", strength: 0 });
      setLoading(false);
      setError("");
      return;
    }

    setLoading(true);
    setError("");

    try {
      const params = buildAdvancedParams(timeframe);

      const [historyRes, sdRes] = await Promise.all([
        axios
          .get(
            apiUrl(`/stock/${encodeURIComponent(symbol)}/history?timeframe=${timeframe}`),
            { signal: controller.signal }
          )
          .catch(() => null),
        axios
          .get(
            apiUrl(`/stock/${encodeURIComponent(symbol)}/supply_demand?${params.toString()}`),
            { signal: controller.signal }
          )
          .catch(() => null),
      ]);

      if (requestId !== fetchSeqRef.current) return;

      const historyData = historyRes?.data?.history;
      const sdData = sdRes?.data || null;

      setHistory(Array.isArray(historyData) ? historyData : []);

      if (sdData) {
        setZones(sdData.zones || { support: [], resistance: [] });
        setSdPrice(sdData.current_price ?? 0);
        setPrice(sdData.current_price ?? 0);
        setMarketState(sdData.market_state || { state: "IN_NONE", strength: 0 });
      } else {
        setZones({ support: [], resistance: [] });
        setSdPrice(0);
        setPrice(0);
        setMarketState({ state: "IN_NONE", strength: 0 });
      }

      if (!historyRes && !sdRes) {
        setError("Errore nel caricamento dei dati");
      } else {
        setError("");
        mainDataCacheRef.current.set(cacheKey, {
          ts: Date.now(),
          data: {
            history: Array.isArray(historyData) ? historyData : [],
            zones: sdData?.zones || { support: [], resistance: [] },
            sdPrice: sdData?.current_price ?? 0,
            price: sdData?.current_price ?? 0,
            marketState: sdData?.market_state || { state: "IN_NONE", strength: 0 },
          },
        });
      }
    } catch (e) {
      if (e?.name === "CanceledError" || e?.name === "AbortError") return;
      console.error(e);
      setError("Errore nel caricamento dei dati");
    } finally {
      if (requestId === fetchSeqRef.current) {
        setLoading(false);
      }
    }
  }, [symbol, timeframe, strengthPct, minDistancePct, gapPct, buildAdvancedParams]);

  useEffect(() => {
    if (!symbol) {
      setZones1DSignal({ support: [], resistance: [] });
      setZones1WSignal({ support: [], resistance: [] });
      setZones1M({ support: [], resistance: [] });
      return;
    }

    const signalTimeframes = [
      { value: "1d", setter: setZones1DSignal },
      { value: "1w", setter: setZones1WSignal },
      { value: "1mo", setter: setZones1M },
    ];

    let cancelled = false;
    const fetchSignalZones = async () => {
      await Promise.all(
        signalTimeframes.map(async ({ value, setter }) => {
          const key = `${symbol}|${value}|${strengthPct}|${minDistancePct}|${gapPct}`;
          const cached = monthlyZonesCacheRef.current.get(key);
          if (cached && Date.now() - cached.ts < 60_000) {
            setter(cached.data || { support: [], resistance: [] });
            return;
          }

          try {
            const params = buildAdvancedParams(value);
            const res = await axios.get(
              apiUrl(`/stock/${encodeURIComponent(symbol)}/supply_demand?${params.toString()}`)
            );
            if (cancelled) return;
            const fetched = res?.data?.zones || { support: [], resistance: [] };
            monthlyZonesCacheRef.current.set(key, { ts: Date.now(), data: fetched });
            setter(fetched);
          } catch (e) {
            if (cancelled) return;
            setter({ support: [], resistance: [] });
          }
        })
      );
    };

    fetchSignalZones();
    return () => {
      cancelled = true;
    };
  }, [symbol, strengthPct, minDistancePct, gapPct, buildAdvancedParams]);

  const applyAdvanced = () => {
    clearSymbolCaches();
    setStrengthPct(draftStrength.trim());
    setMinDistancePct(draftMinDistance.trim());
    setGapPct(draftGap.trim());
  };

  const resetAdvanced = () => {
    clearSymbolCaches();
    setDraftStrength("");
    setDraftMinDistance("");
    setDraftGap("");
    setStrengthPct("");
    setMinDistancePct("");
    setGapPct("");
  };

  const handleThumbDrag = (type, e) => {
    if (!seasonData || !rangeRef.current) return;
    e.preventDefault();
    const rect = rangeRef.current.getBoundingClientRect();
    const width = rect.width;

    const move = (ev) => {
      const x = Math.min(Math.max(ev.clientX - rect.left, 0), width);
      const step = width / (seasonData.years.length - 1);
      const index = Math.round(x / step);
      const year = seasonData.years[index];
      if (type === "min" && year < maxYear) setMinYear(year);
      if (type === "max" && year > minYear) setMaxYear(year);
    };

    const stop = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", stop);
    };

    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", stop);
  };

  const handleRangeDrag = (e) => {
    if (!seasonData || !rangeRef.current) return;
    e.preventDefault();
    const rect = rangeRef.current.getBoundingClientRect();
    const width = rect.width;
    const step = width / (seasonData.years.length - 1);
    const initialMin = minYear;
    const initialMax = maxYear;
    const startX = e.clientX;

    const move = (ev) => {
      const dx = ev.clientX - startX;
      const deltaIndex = Math.round(dx / step);

      let newMinIndex = seasonData.years.indexOf(initialMin) + deltaIndex;
      let newMaxIndex = seasonData.years.indexOf(initialMax) + deltaIndex;
      const rangeSize =
        seasonData.years.indexOf(initialMax) -
        seasonData.years.indexOf(initialMin);

      if (newMinIndex < 0) {
        newMinIndex = 0;
        newMaxIndex = rangeSize;
      }

      if (newMaxIndex > seasonData.years.length - 1) {
        newMaxIndex = seasonData.years.length - 1;
        newMinIndex = newMaxIndex - rangeSize;
      }

      setMinYear(seasonData.years[newMinIndex]);
      setMaxYear(seasonData.years[newMaxIndex]);
    };

    const stop = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", stop);
    };

    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", stop);
  };

  const refreshPrice = useCallback(async () => {
    if (!symbol) return;
    try {
      const liveRes = await axios.get(
        apiUrl(`/stock/${encodeURIComponent(symbol)}/live_price`)
      );
      const livePrice = Number(liveRes.data?.current_price);
      if (!Number.isNaN(livePrice)) {
        setPrice(livePrice);
      }
    } catch (e) {
      console.error(e);
    }
  }, [symbol]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  useEffect(() => {
    if (!symbol) return;
    const intervalId = setInterval(() => {
      refreshPrice();
    }, 10000);

    return () => clearInterval(intervalId);
  }, [symbol, refreshPrice]);

  useEffect(() => {
    if (!symbol) return;
    const fetchTechnicals = async () => {
      const key = `${symbol}|${timeframe}`;
      const cached = technicalCacheRef.current.get(key);
      if (cached && Date.now() - cached.ts < 90_000) {
        const json = cached.data;
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
        setTechSummary({ general, totalCounts, strength, strengthLabel });
        setLoadingTech(false);
        setErrorTech("");
        return;
      }

      setLoadingTech(true);
      setErrorTech("");
      try {
        const res = await fetch(
          apiUrl(`/stock/${encodeURIComponent(symbol)}/technicals?timeframe=${timeframe}`)
        );
        if (!res.ok) throw new Error(`Errore API (${res.status})`);
        const json = await res.json();
        if (!json || (!json.oscillatorsSummary && !json.movingAveragesSummary))
          throw new Error("Dati tecnici non validi");

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

        const totalSignals =
          totalCounts.Buy + totalCounts.Sell + totalCounts.Neutral;

        const strength =
          totalSignals > 0
            ? Math.max(totalCounts.Buy, totalCounts.Sell) / totalSignals
            : 0;

        const strengthLabel =
          strength > 0.7
            ? "Strong"
            : strength > 0.55
            ? "Moderate"
            : "Weak";

        const general =
          totalCounts.Buy > Math.max(totalCounts.Sell, totalCounts.Neutral)
            ? "Buy"
            : totalCounts.Sell > Math.max(totalCounts.Buy, totalCounts.Neutral)
            ? "Sell"
            : "Neutral";

        technicalCacheRef.current.set(key, { ts: Date.now(), data: json });
        setTechSummary({ general, totalCounts, strength, strengthLabel });
      } catch (e) {
        console.error(e);
        setErrorTech("Errore tecnici");
      } finally {
        setLoadingTech(false);
      }
    };

    fetchTechnicals();
  }, [symbol, timeframe]);

  useEffect(() => {
    if (!symbol) return;
    const fetchSeasonality = async () => {
      const key = `${symbol}|base`;
      const cached = seasonalityCacheRef.current.get(key);
      if (cached && Date.now() - cached.ts < 5 * 60_000) {
        const json = cached.data;
        const years = json.years || [];
        setRawSeasonData(json);
        setSeasonData(json);
        setMinYear((prev) => (prev !== null && years.includes(prev) ? prev : years[0] ?? null));
        setMaxYear((prev) =>
          prev !== null && years.includes(prev) ? prev : years[years.length - 1] ?? null
        );
        setSelectedYears(years);
        setLoadingSeason(false);
        setErrorSeason("");
        return;
      }

      setLoadingSeason(true);
      setErrorSeason("");
      try {
        const res = await fetch(
          apiUrl(`/seasonality/${encodeURIComponent(symbol)}`)
        );
        if (!res.ok) throw new Error("Errore stagionalità");
        const json = await res.json();
        seasonalityCacheRef.current.set(key, { ts: Date.now(), data: json });
        const years = json.years || [];
        setRawSeasonData(json);
        setSeasonData(json);
        setMinYear((prev) => (prev !== null && years.includes(prev) ? prev : years[0] ?? null));
        setMaxYear((prev) =>
          prev !== null && years.includes(prev) ? prev : years[years.length - 1] ?? null
        );
        setSelectedYears(years);
      } catch (e) {
        console.error(e);
        setErrorSeason("Errore stagionalità");
        setSeasonData(null);
        setRawSeasonData(null);
      } finally {
        setLoadingSeason(false);
      }
    };

    fetchSeasonality();
  }, [symbol]);

  useEffect(() => {
    if (!symbol) {
      setGapHistory5Y([]);
      return;
    }

    const cacheKey = `${symbol}|gap-5y`;
    const cached = gapHistoryCacheRef.current.get(cacheKey);
    if (cached && Date.now() - cached.ts < 10 * 60_000) {
      setGapHistory5Y(cached.data);
      return;
    }

    let cancelled = false;
    const fetchGapHistory5Y = async () => {
      try {
        const res = await fetch(
          apiUrl(`/stock/${encodeURIComponent(symbol)}?timeframe=1d`)
        );
        if (!res.ok) throw new Error(`Errore API (${res.status})`);

        const json = await res.json();
        const ohlc = Array.isArray(json?.ohlc) ? json.ohlc : [];
        const cutoff = new Date();
        cutoff.setHours(0, 0, 0, 0);
        cutoff.setFullYear(cutoff.getFullYear() - 5);

        const filtered = ohlc.filter((candle) => {
          const d = parseHistoryDate(candle?.date);
          return d && d >= cutoff;
        });

        if (cancelled) return;
        gapHistoryCacheRef.current.set(cacheKey, { ts: Date.now(), data: filtered });
        setGapHistory5Y(filtered);
      } catch (e) {
        if (cancelled) return;
        console.error("Errore storico gap 5Y:", e);
        setGapHistory5Y([]);
      }
    };

    fetchGapHistory5Y();
    return () => {
      cancelled = true;
    };
  }, [symbol, parseHistoryDate]);

  useEffect(() => {
    if (!symbol) return;
    if (strengthPct === "" && minDistancePct === "" && gapPct === "") return;

    let cancelled = false;
    const timeframesToWarm = ["1w", "1mo"];

    const warmAdvancedCaches = async () => {
      await Promise.all(
        timeframesToWarm.map(async (tf) => {
          const cacheKey = `${symbol}|${tf}|${strengthPct}|${minDistancePct}|${gapPct}`;
          if (mainDataCacheRef.current.has(cacheKey)) return;

          const params = buildAdvancedParams(tf);
          const [historyRes, sdRes] = await Promise.all([
            axios
              .get(
                apiUrl(`/stock/${encodeURIComponent(symbol)}/history?timeframe=${tf}`)
              )
              .catch(() => null),
            axios
              .get(
                apiUrl(`/stock/${encodeURIComponent(symbol)}/supply_demand?${params.toString()}`)
              )
              .catch(() => null),
          ]);

          if (cancelled) return;

          const historyData = historyRes?.data?.history;
          const sdData = sdRes?.data || null;

          mainDataCacheRef.current.set(cacheKey, {
            ts: Date.now(),
            data: {
              history: Array.isArray(historyData) ? historyData : [],
              zones: sdData?.zones || { support: [], resistance: [] },
              sdPrice: sdData?.current_price ?? 0,
              price: sdData?.current_price ?? 0,
              marketState: sdData?.market_state || { state: "IN_NONE", strength: 0 },
            },
          });
        })
      );
    };

    warmAdvancedCaches();
    return () => {
      cancelled = true;
    };
  }, [symbol, strengthPct, minDistancePct, gapPct, buildAdvancedParams]);

  useEffect(() => {
    if (!rawSeasonData || !rawSeasonData.seasonalCurveByYear) return;
    if (!excludeOutliers) {
      setSeasonData(rawSeasonData);
      return;
    }

    const allValues = Object.values(rawSeasonData.seasonalCurveByYear || {})
      .flat()
      .filter((v) => Number.isFinite(v));

    if (allValues.length === 0) {
      setSeasonData(rawSeasonData);
      return;
    }

    const sorted = [...allValues].sort((a, b) => a - b);
    const minVal = sorted[Math.floor(0.05 * (sorted.length - 1))];
    const maxVal = sorted[Math.floor(0.95 * (sorted.length - 1))];

    const filteredCurve = {};
    Object.keys(rawSeasonData.seasonalCurveByYear).forEach((year) => {
      filteredCurve[year] = (rawSeasonData.seasonalCurveByYear[year] || []).map((v) =>
        Number.isFinite(v) ? Math.min(Math.max(v, minVal), maxVal) : v
      );
    });
    setSeasonData({
      ...rawSeasonData,
      seasonalCurveByYear: filteredCurve,
    });
  }, [excludeOutliers, rawSeasonData]);

  useEffect(() => {
    if (!seasonData || minYear === null || maxYear === null) return;
    setSelectedYears(seasonData.years.filter((y) => y >= minYear && y <= maxYear));
  }, [seasonData, minYear, maxYear]);


  // ---------- PUNTI GRAFICO ----------
  const hasOhlc =
    history.length > 0 &&
    history.every(
      (p) =>
        p.open !== null &&
        p.open !== undefined &&
        p.high !== null &&
        p.high !== undefined &&
        p.low !== null &&
        p.low !== undefined &&
        p.close !== null &&
        p.close !== undefined &&
        !Number.isNaN(p.open) &&
        !Number.isNaN(p.high) &&
        !Number.isNaN(p.low) &&
        !Number.isNaN(p.close)
    );

  const isCandle = chartType === "candlestick" && hasOhlc;
  const isMobile = typeof window !== "undefined" && window.innerWidth < 700;
  const maxCandlesByTimeframe = isMobile
    ? { "1d": 200, "1w": 220, "1mo": 240 }
    : { "1d": 260, "1w": 280, "1mo": 320 };
  const maxCandles = maxCandlesByTimeframe[timeframe] ?? (isMobile ? 60 : 110);
  const downsampleHistory = (data, max) => {
    if (!Array.isArray(data) || data.length <= max) return data;
    const step = Math.ceil(data.length / max);
    const sampled = data.filter((_, idx) => idx % step === 0);
    const last = data[data.length - 1];
    if (sampled[sampled.length - 1] !== last) {
      sampled.push(last);
    }
    return sampled;
  };
  const shouldDownsampleCandles = isCandle && history.length > maxCandles;
  const displayHistory = shouldDownsampleCandles
    ? downsampleHistory(history, maxCandles)
    : history;
  const candleCount = Math.max(displayHistory.length, 1);
  const approxChartWidth =
    typeof window !== "undefined" ? Math.max(window.innerWidth - 180, 320) : 900;
  const pxPerCandle = approxChartWidth / candleCount;
  const candleThickness = Math.max(1, Math.min(6, Math.floor(pxPerCandle * 0.58)));
  const candleBarPercentage = timeframe === "1d" ? 0.44 : 0.52;
  const candleCategoryPercentage = timeframe === "1d" ? 0.56 : 0.64;

  const chartPoints = displayHistory.map((d) => ({
    x: new Date(d.date),
    y: d.close,
    o: d.open,
    h: d.high,
    l: d.low,
    c: d.close,
  }));

  const gapSourceHistory = useMemo(
    () => (gapHistory5Y.length ? gapHistory5Y : history),
    [gapHistory5Y, history]
  );

  const gapDisplayHistory = gapSourceHistory;

  const gapChartPoints = gapDisplayHistory.map((d) => ({
    x: new Date(d.date),
    o: d.open,
    h: d.high,
    l: d.low,
    c: d.close,
  }));

  const gapHasOhlc =
    gapChartPoints.length > 0 &&
    gapChartPoints.every(
      (p) =>
        p.x instanceof Date &&
        !Number.isNaN(p.x.getTime()) &&
        Number.isFinite(p.o) &&
        Number.isFinite(p.h) &&
        Number.isFinite(p.l) &&
        Number.isFinite(p.c)
    );

  const updateGapXAxisTitleFromChart = useCallback((chartInstance) => {
    const xScale = chartInstance?.scales?.x;
    if (!xScale) return;
    const min = Number(xScale.min);
    const max = Number(xScale.max);
    if (!Number.isFinite(min) || !Number.isFinite(max)) return;

    const nextTitle = `Periodo: ${formatMonthYear(min)} - ${formatMonthYear(max)}`;
    setGapXAxisTitle((prev) => (prev === nextTitle ? prev : nextTitle));
  }, []);

  useEffect(() => {
    if (!gapChartPoints.length) {
      setGapXAxisTitle("Periodo (ultimi 5 anni)");
      return;
    }
    const first = gapChartPoints[0]?.x;
    const last = gapChartPoints[gapChartPoints.length - 1]?.x;
    if (!(first instanceof Date) || !(last instanceof Date)) {
      setGapXAxisTitle("Periodo (ultimi 5 anni)");
      return;
    }
    const nextTitle = `Periodo: ${formatMonthYear(first)} - ${formatMonthYear(last)}`;
    setGapXAxisTitle(nextTitle);
  }, [gapChartPoints]);

  const gapAnalysis = useMemo(() => {
    const rows = normalizeGapRows(gapSourceHistory);
    if (rows.length < 2) {
      return {
        rows,
        gaps: [],
        openGaps: [],
        closedGaps: [],
        byType: {},
        totalCloseProb10: null,
        latestOpenGap: null,
      };
    }

    const detected = findGapsLikePortify(rows, 0.01);
    const withStatus = markClosedGapsLikePortify(rows, detected);
    const openGaps = withStatus.filter((gap) => gap.closed === false);
    const closedGaps = withStatus.filter((gap) => gap.closed);
    const byType = gapCloseProbabilityByType(rows, withStatus, 10);
    const totalCloseProb10 = gapCloseProbability(rows, withStatus, 10);
    const latestOpenGap =
      openGaps.length > 0
        ? [...openGaps].sort((a, b) => b.dateObj.getTime() - a.dateObj.getTime())[0]
        : null;

    return {
      rows,
      gaps: withStatus,
      openGaps,
      closedGaps,
      byType,
      totalCloseProb10,
      latestOpenGap,
    };
  }, [
    gapSourceHistory,
    normalizeGapRows,
    findGapsLikePortify,
    markClosedGapsLikePortify,
    gapCloseProbabilityByType,
    gapCloseProbability,
  ]);

  const timeframeGapAnalysisForSignal = useMemo(() => {
    const rows = normalizeGapRows(history);
    if (rows.length < 2) {
      return {
        openGaps: [],
        totalCloseProb10: null,
      };
    }

    const detected = findGapsLikePortify(rows, 0.01);
    const withStatus = markClosedGapsLikePortify(rows, detected);
    return {
      openGaps: withStatus.filter((gap) => gap.closed === false),
      totalCloseProb10: gapCloseProbability(rows, withStatus, 10),
    };
  }, [
    history,
    normalizeGapRows,
    findGapsLikePortify,
    markClosedGapsLikePortify,
    gapCloseProbability,
  ]);

  const gapYDomain = useMemo(() => {
    const values = [];

    gapChartPoints.forEach((point) => {
      if (Number.isFinite(point.l)) values.push(Number(point.l));
      if (Number.isFinite(point.h)) values.push(Number(point.h));
    });

    gapAnalysis.openGaps.forEach((gap) => {
      if (Number.isFinite(gap.start)) values.push(Number(gap.start));
      if (Number.isFinite(gap.end)) values.push(Number(gap.end));
    });

    if (!values.length) return null;
    const rawMin = Math.min(...values);
    const rawMax = Math.max(...values);
    if (!Number.isFinite(rawMin) || !Number.isFinite(rawMax)) return null;

    const range = rawMax - rawMin;
    const pad = Math.max(range * 0.04, Math.abs(rawMax || 1) * 0.02, 0.25);

    return {
      min: rawMin - pad,
      max: rawMax + pad,
    };
  }, [gapChartPoints, gapAnalysis.openGaps]);

  // ---------- TROVA 3 SUPPORTI E 3 RESISTENZE PIU' VICINI ----------
  const sortedSupports = [...zones.support]
    .map((s) => s.price)
    .filter((p) => p <= sdPrice)
    .sort((a, b) => b - a)
    .slice(0, 3);

  const sortedResistances = [...zones.resistance]
    .map((r) => r.price)
    .filter((p) => p >= sdPrice)
    .sort((a, b) => a - b)
    .slice(0, 3);

  const timeframes = [
    { value: "1d", label: "1D" },
    { value: "1w", label: "1W" },
    { value: "1mo", label: "1M" },
  ];

  // ---------- LINEE SUPPORTO / RESISTENZA ----------
  const supportLines = sortedSupports.map((support) =>
    chartPoints.map((p) => ({ x: p.x, y: support }))
  );
  const resistanceLines = sortedResistances.map((resistance) =>
    chartPoints.map((p) => ({ x: p.x, y: resistance }))
  );

  const supportDatasets = supportLines.map((line, i) => ({
    label: `Supporto ${i + 1}`,
    data: line,
    type: "line",
    borderColor: `rgba(34,197,94,${(isCandle ? 0.28 : 0.5) - i * 0.08})`,
    borderWidth: isCandle ? 1.6 : 2.4,
    borderDash: [6, 4],
    pointRadius: 0,
    pointHoverRadius: 2,
    tension: 0.2,
    fill: false,
    order: 1,
  }));

  const resistanceDatasets = resistanceLines.map((line, i) => ({
    label: `Resistenza ${i + 1}`,
    data: line,
    type: "line",
    borderColor: `rgba(239,68,68,${(isCandle ? 0.22 : 0.35) + i * 0.08})`,
    borderWidth: isCandle ? 1.6 : 2.4,
    borderDash: [6, 4],
    pointRadius: 0,
    pointHoverRadius: 2,
    tension: 0.2,
    fill: false,
    order: 1,
  }));

  const priceDataset = {
    label: "Prezzo",
    data: chartPoints.map((p) => ({ x: p.x, y: p.y })),
    type: "line",
    borderColor: darkMode ? "#8ab4f8" : "#2f3162",
    backgroundColor: darkMode ? "rgba(138,180,248,0.12)" : "rgba(47,49,98,0.12)",
    borderWidth: 2.8,
    pointRadius: 0,
    pointHoverRadius: 3,
    pointHitRadius: 8,
    tension: 0.2,
    fill: true,
    order: 2,
  };

  const candleDataset = {
    label: "Candele",
    data: chartPoints.map((p) => ({ x: p.x, o: p.o, h: p.h, l: p.l, c: p.c })),
    type: "candlestick",
    parsing: false,
    color: {
      up: "#22ab94",
      down: "#f23645",
      unchanged: darkMode ? "#9ca3af" : "#6b7280",
    },
    borderColor: darkMode ? "rgba(255,255,255,0.7)" : "rgba(15,23,42,0.5)",
    borderWidth: 1.2,
    barThickness: candleThickness,
    maxBarThickness: candleThickness,
    barPercentage: candleBarPercentage,
    categoryPercentage: candleCategoryPercentage,
    order: 3,
  };

  const effectiveChartType = isCandle ? "candlestick" : "line";

  const chartData = {
    datasets:
      effectiveChartType === "candlestick"
        ? [candleDataset, ...supportDatasets, ...resistanceDatasets]
        : [...supportDatasets, ...resistanceDatasets, priceDataset],
  };

  const tvPalette = darkMode
    ? {
        bg: "#131722",
        grid: "rgba(255,255,255,0.06)",
        text: "#d1d4dc",
        axis: "rgba(255,255,255,0.18)",
      }
    : {
        bg: "#ffffff",
        grid: "rgba(15,23,42,0.08)",
        text: "#111827",
        axis: "rgba(15,23,42,0.2)",
      };

  const chartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: "nearest", intersect: false },
    layout: {
      padding: { top: 8, right: 16, bottom: 6, left: 6 },
    },
    plugins: {
      legend: {
        display: !isCandle,
        position: "top",
        labels: {
          color: tvPalette.text,
          boxWidth: 10,
          boxHeight: 10,
          usePointStyle: true,
          pointStyle: "line",
          font: { size: 12, weight: "600" },
        },
      },
      tooltip: {
        backgroundColor: darkMode ? "rgba(19,23,32,0.96)" : "rgba(255,255,255,0.98)",
        titleColor: tvPalette.text,
        bodyColor: tvPalette.text,
        borderColor: darkMode ? "rgba(148,163,184,0.35)" : "rgba(15,23,42,0.12)",
        borderWidth: 1,
        callbacks: {
          label: (ctx) => {
            if (ctx.dataset.type === "candlestick" && ctx.raw) {
              const { o, h, l, c } = ctx.raw;
              return `${ctx.dataset.label}: O ${formatPrice(o)} H ${formatPrice(h)} L ${formatPrice(l)} C ${formatPrice(c)}`;
            }
            return `${ctx.dataset.label}: ${formatPrice(ctx.parsed.y)}`;
          },
        },
      },
    },
    scales: {
      x: {
        type: "time",
        offset: true,
        bounds: "ticks",
        afterBuildTicks: (axis) => {
          const ticks = axis.ticks;
          if (!ticks || ticks.length === 0) return;
          const last = ticks[ticks.length - 1].value;
          let next;
          if (ticks.length > 1) {
            const prev = ticks[ticks.length - 2].value;
            next = last + (last - prev);
          } else {
            const d = new Date(last);
            if (timeframe === "1w") d.setDate(d.getDate() + 7);
            else if (timeframe === "1mo") d.setMonth(d.getMonth() + 1);
            else d.setDate(d.getDate() + 1);
            next = d.getTime();
          }
          ticks.push({ value: next });
        },
        time: {
          unit: timeframe === "1d" ? "day" : timeframe === "1w" ? "week" : "month",
          tooltipFormat: "dd MMM yyyy",
        },
        ticks: {
          autoSkip: true,
          maxTicksLimit: 8,
          color: tvPalette.text,
          font: { size: 11, weight: "600" },
          padding: 6,
        },
        grid: {
          color: tvPalette.grid,
          drawTicks: false,
        },
        border: {
          color: tvPalette.axis,
        },
      },
      y: {
        ticks: {
          callback: (val) => formatPrice(val),
          maxTicksLimit: 6,
          color: tvPalette.text,
          font: { size: 11, weight: "600" },
          padding: 6,
        },
        grid: {
          color: tvPalette.grid,
        },
        border: {
          color: tvPalette.axis,
        },
      },
    },
  };

  const gapCandleData = {
    datasets: [
      {
        label: "Prezzo",
        data: gapChartPoints.map((p) => ({ x: p.x, o: p.o, h: p.h, l: p.l, c: p.c })),
        type: "candlestick",
        parsing: false,
        color: {
          up: "#22ab94",
          down: "#f23645",
          unchanged: darkMode ? "#9ca3af" : "#6b7280",
        },
        borderColor: darkMode ? "rgba(255,255,255,0.72)" : "rgba(15,23,42,0.5)",
        borderWidth: 1.1,
        barThickness: candleThickness,
        maxBarThickness: candleThickness,
        barPercentage: candleBarPercentage,
        categoryPercentage: candleCategoryPercentage,
      },
    ],
  };

  const gapCandleOptions = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: "nearest", intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: darkMode ? "rgba(19,23,32,0.96)" : "rgba(255,255,255,0.98)",
        titleColor: tvPalette.text,
        bodyColor: tvPalette.text,
        borderColor: darkMode ? "rgba(148,163,184,0.35)" : "rgba(15,23,42,0.12)",
        borderWidth: 1,
        callbacks: {
          label: (ctx) => {
            if (ctx.raw) {
              const { o, h, l, c } = ctx.raw;
              return `O ${formatPrice(o)} H ${formatPrice(h)} L ${formatPrice(l)} C ${formatPrice(c)}`;
            }
            return "";
          },
        },
      },
      zoom: {
        limits: {
          x: { min: "original", max: "original" },
          y: { min: "original", max: "original" },
        },
        pan: {
          enabled: true,
          mode: "x",
          threshold: 6,
        },
        zoom: {
          wheel: {
            enabled: true,
            speed: 0.08,
          },
          pinch: {
            enabled: true,
          },
          drag: {
            enabled: false,
          },
          mode: "x",
        },
        onZoomComplete: ({ chart }) => updateGapXAxisTitleFromChart(chart),
        onPanComplete: ({ chart }) => updateGapXAxisTitleFromChart(chart),
      },
    },
    scales: {
      x: {
        type: "time",
        offset: true,
        bounds: "ticks",
        time: {
          displayFormats: {
            day: "dd MMM yyyy",
            week: "dd MMM yyyy",
            month: "MMM yyyy",
            year: "yyyy",
          },
          tooltipFormat: "dd MMM yyyy",
        },
        title: {
          display: true,
          text: gapXAxisTitle,
          color: tvPalette.text,
          font: { size: 11, weight: "700" },
          padding: { top: 8 },
        },
        ticks: {
          autoSkip: true,
          maxTicksLimit: 10,
          color: tvPalette.text,
          font: { size: 11, weight: "600" },
          maxRotation: 0,
          minRotation: 0,
          callback: (value) => {
            const date = new Date(value);
            if (Number.isNaN(date.getTime())) return "";
            return new Intl.DateTimeFormat("it-IT", {
              day: "2-digit",
              month: "short",
              year: "numeric",
            }).format(date);
          },
        },
        grid: {
          color: tvPalette.grid,
          drawTicks: false,
        },
        border: {
          color: tvPalette.axis,
        },
      },
      y: {
        suggestedMin:
          gapYDomain && Number.isFinite(gapYDomain.min) ? gapYDomain.min : undefined,
        suggestedMax:
          gapYDomain && Number.isFinite(gapYDomain.max) ? gapYDomain.max : undefined,
        ticks: {
          callback: (val) => formatPrice(val),
          maxTicksLimit: 6,
          color: tvPalette.text,
          font: { size: 11, weight: "600" },
          padding: 6,
        },
        grid: {
          color: tvPalette.grid,
        },
        border: {
          color: tvPalette.axis,
        },
      },
    },
  };

  const openGapOverlayPlugins = useMemo(
    () => [
      {
        id: "open-gap-overlay",
        afterDatasetsDraw: (chart) => {
          const openOnlyGaps = (gapAnalysis.openGaps || []).filter(
            (gap) => gap?.closed === false
          );
          if (!openOnlyGaps.length || !gapChartPoints.length) return;
          const xScale = chart.scales?.x;
          const yScale = chart.scales?.y;
          const chartArea = chart.chartArea;
          if (!xScale || !yScale || !chartArea) return;

          const lastVisible = gapChartPoints[gapChartPoints.length - 1]?.x;
          const lastVisibleTs =
            lastVisible instanceof Date ? lastVisible.getTime() : Number.NaN;
          if (!Number.isFinite(lastVisibleTs)) return;

          const getColors = (type) => {
            if (type === "Gap Up") {
              return { fill: "rgba(255,165,0,0.34)", stroke: "rgba(255,165,0,0.9)" };
            }
            if (type === "Gap Down") {
              return { fill: "rgba(0,128,255,0.34)", stroke: "rgba(0,128,255,0.88)" };
            }
            if (type === "Gap Up 3 candele") {
              return { fill: "rgba(50,205,50,0.3)", stroke: "rgba(50,205,50,0.86)" };
            }
            if (type === "Gap Down 3 candele") {
              return { fill: "rgba(220,20,60,0.3)", stroke: "rgba(220,20,60,0.86)" };
            }
            return { fill: "rgba(148,163,184,0.28)", stroke: "rgba(148,163,184,0.8)" };
          };

          const sampleWidth =
            gapChartPoints.length > 1
              ? Math.abs(
                  xScale.getPixelForValue(gapChartPoints[1].x.getTime()) -
                    xScale.getPixelForValue(gapChartPoints[0].x.getTime())
                )
              : 10;

          const rightAnchorPx = xScale.getPixelForValue(lastVisibleTs);
          const xRight = Math.min(
            chartArea.right,
            (Number.isFinite(rightAnchorPx) ? rightAnchorPx : chartArea.right) + sampleWidth * 0.65
          );

          const ctx = chart.ctx;
          ctx.save();
          ctx.beginPath();
          ctx.rect(
            chartArea.left,
            chartArea.top,
            chartArea.right - chartArea.left,
            chartArea.bottom - chartArea.top
          );
          ctx.clip();

          openOnlyGaps.forEach((gap) => {
            if (!(gap.dateObj instanceof Date)) return;
            const ts = gap.dateObj.getTime();
            if (!Number.isFinite(ts)) return;

            const rawLeft = xScale.getPixelForValue(ts);
            const xLeft = Number.isFinite(rawLeft) ? rawLeft : chartArea.left;
            const left = Math.max(chartArea.left, xLeft);
            const right = Math.max(left + 1, xRight);
            if (left >= right) return;

            const yA = yScale.getPixelForValue(gap.start);
            const yB = yScale.getPixelForValue(gap.end);
            if (!Number.isFinite(yA) || !Number.isFinite(yB)) return;

            let top = Math.max(chartArea.top, Math.min(yA, yB));
            let bottom = Math.min(chartArea.bottom, Math.max(yA, yB));
            if (bottom <= top) return;

            const minGapPx = 4;
            if (bottom - top < minGapPx) {
              const mid = (top + bottom) / 2;
              top = Math.max(chartArea.top, mid - minGapPx / 2);
              bottom = Math.min(chartArea.bottom, mid + minGapPx / 2);
              if (bottom <= top) return;
            }

            const colors = getColors(gap.type);
            ctx.fillStyle = colors.fill;
            ctx.strokeStyle = colors.stroke;
            ctx.lineWidth = 1.1;
            ctx.fillRect(left, top, right - left, bottom - top);
            ctx.strokeRect(left, top, right - left, bottom - top);
          });

          ctx.restore();
        },
      },
    ],
    [gapAnalysis.openGaps, gapChartPoints]
  );

  // ---------- COLORE SEGNALE ----------
  const stateColor =
    marketState.state === "IN_DEMAND"
      ? "green"
      : marketState.state === "IN_SUPPLY"
      ? "red"
      : "gray";

  // ---------- SUPPORTO E RESISTENZA PIU' VICINI PER IL MARKER UNICO ----------
  const nearestSupport = Math.max(...zones.support.map((s) => s.price).filter((p) => p <= sdPrice), 0);
  const nearestResistance = Math.min(...zones.resistance.map((r) => r.price).filter((p) => p >= sdPrice), sdPrice * 1.05);
  const supportDist = nearestResistance - nearestSupport === 0
    ? 0
    : ((sdPrice - nearestSupport) / (nearestResistance - nearestSupport)) * 100;

  const gapTypeLabels = [
    "Gap Up",
    "Gap Down",
    "Gap Up 3 candele",
    "Gap Down 3 candele",
  ];

  const openGapRanges = useMemo(
    () =>
      [...gapAnalysis.openGaps].sort(
        (a, b) => b.dateObj.getTime() - a.dateObj.getTime()
      ),
    [gapAnalysis.openGaps]
  );

  const cumulativePercentiles = useMemo(() => {
    if (!seasonData || selectedYears.length === 0) return [];
    return computeCumulativePercentiles(seasonData.seasonalCurveByYear, selectedYears);
  }, [seasonData, selectedYears]);

  const winsorizedSeasonCurveByYear = useMemo(() => {
    const sourceCurve = rawSeasonData?.seasonalCurveByYear;
    if (!sourceCurve) return null;

    const allValues = Object.values(sourceCurve)
      .flat()
      .filter((v) => Number.isFinite(v));

    if (allValues.length === 0) return sourceCurve;

    const sorted = [...allValues].sort((a, b) => a - b);
    const minVal = sorted[Math.floor(0.05 * (sorted.length - 1))];
    const maxVal = sorted[Math.floor(0.95 * (sorted.length - 1))];

    const capped = {};
    Object.keys(sourceCurve).forEach((year) => {
      capped[year] = (sourceCurve[year] || []).map((v) =>
        Number.isFinite(v) ? Math.min(Math.max(v, minVal), maxVal) : v
      );
    });

    return capped;
  }, [rawSeasonData]);

  const cumulativePercentilesMiniWinsorized = useMemo(() => {
    if (!winsorizedSeasonCurveByYear) return [];
    const yearsForMini =
      selectedYears.length > 0 ? selectedYears : rawSeasonData?.years || [];
    if (yearsForMini.length === 0) return [];
    return computeCumulativePercentiles(winsorizedSeasonCurveByYear, yearsForMini);
  }, [winsorizedSeasonCurveByYear, selectedYears, rawSeasonData]);

  const tradeMonths = useMemo(() => {
    if (!seasonData) return { buyMonth: null, sellMonth: null };
    return computeTradeMonths(cumulativePercentiles, seasonData.months || []);
  }, [cumulativePercentiles, seasonData]);

  const currentMonthIndex = new Date().getMonth();
  const currentMonthStats = useMemo(() => {
    if (!seasonData || !seasonData.seasonalCurveByYear || selectedYears.length === 0) {
      return { month: null, avg: null, winRate: null };
    }
    const monthLabel = seasonData.months?.[currentMonthIndex] ?? null;
    const values = selectedYears
      .map((y) => seasonData.seasonalCurveByYear[y]?.[currentMonthIndex])
      .filter((v) => v !== null && v !== undefined);
    if (values.length === 0) {
      return { month: monthLabel, avg: null, winRate: null };
    }
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    const wins = values.filter((v) => v > 0).length;
    const winRate = (wins / values.length) * 100;
    return { month: monthLabel, avg, winRate };
  }, [seasonData, selectedYears, currentMonthIndex]);

  const cumulativeMiniChart = useMemo(() => {
    if (
      !seasonData ||
      !Array.isArray(cumulativePercentilesMiniWinsorized) ||
      cumulativePercentilesMiniWinsorized.length < 12
    ) {
      return null;
    }

    const nextMonthIndex = (currentMonthIndex + 1) % 12;
    const monthLabels = rawSeasonData?.months || seasonData.months || [];
    const labels = [
      monthLabels[currentMonthIndex] || "Corrente",
      monthLabels[nextMonthIndex] || "Successivo",
    ];

    const current = cumulativePercentilesMiniWinsorized[currentMonthIndex] || {};
    const next = cumulativePercentilesMiniWinsorized[nextMonthIndex] || {};

    const safe = (v) => (Number.isFinite(v) ? Number(v.toFixed(2)) : null);

    return {
      data: [
        {
          x: labels,
          y: [safe(current.p10), safe(next.p10)],
          type: "bar",
          name: "10° Percentile (Cumulativo)",
          marker: { color: "#ff4d4f" },
        },
        {
          x: labels,
          y: [safe(current.median), safe(next.median)],
          type: "bar",
          name: "Mediana (Cumulativo)",
          marker: { color: "#1890ff" },
        },
        {
          x: labels,
          y: [safe(current.p90), safe(next.p90)],
          type: "bar",
          name: "90° Percentile (Cumulativo)",
          marker: { color: "#52c41a" },
        },
      ],
      layout: {
        autosize: true,
        barmode: "group",
        bargap: 0.28,
        paper_bgcolor: darkMode ? "#121212" : "#ffffff",
        plot_bgcolor: darkMode ? "#121212" : "#ffffff",
        font: { color: darkMode ? "#ffffff" : "#000000" },
        legend: {
          orientation: "h",
          x: 0,
          xanchor: "left",
          y: 1.18,
          yanchor: "bottom",
          font: { size: 12, color: darkMode ? "#ffffff" : "#000000" },
        },
        xaxis: { automargin: true },
        yaxis: { title: "Variazione % cumulativa", ticksuffix: "%", automargin: true },
        margin: { t: 64, l: 55, r: 20, b: 44 },
      },
      config: { responsive: true, displayModeBar: false },
    };
  }, [
    seasonData,
    rawSeasonData,
    cumulativePercentilesMiniWinsorized,
    currentMonthIndex,
    darkMode,
  ]);

  const zonesBySelectedTimeframe = useMemo(() => {
    if (timeframe === "1w") return zones1WSignal;
    if (timeframe === "1mo") return zones1M;
    return zones1DSignal;
  }, [timeframe, zones1DSignal, zones1WSignal, zones1M]);

  const selectedSignalHorizon =
    timeframe === "1d" ? "oggi" : timeframe === "1w" ? "fine settimana" : "fine mese";

  const signalGapContext = useMemo(
    () =>
      timeframe === "1mo"
        ? {
            openGaps: gapAnalysis.openGaps,
            totalCloseProb10: gapAnalysis.totalCloseProb10,
          }
        : timeframeGapAnalysisForSignal,
    [
      timeframe,
      gapAnalysis.openGaps,
      gapAnalysis.totalCloseProb10,
      timeframeGapAnalysisForSignal,
    ]
  );

  const tradingSignal = useMemo(() => {
    const safeNum = (v) => (Number.isFinite(v) ? Number(v) : null);

    const nextMonthIndex = (currentMonthIndex + 1) % 12;
    const monthlyCurrentMedian = safeNum(
      cumulativePercentilesMiniWinsorized?.[currentMonthIndex]?.median
    );
    const monthlyNextMedian = safeNum(
      cumulativePercentilesMiniWinsorized?.[nextMonthIndex]?.median
    );

    const useMonthlyContext = timeframe === "1mo";
    const currentMedian = useMonthlyContext ? monthlyCurrentMedian : null;
    const nextMedian = useMonthlyContext ? monthlyNextMedian : null;

    const rawSignal = computeUnifiedTradingSignal({
      currentPrice: safeNum(sdPrice) && sdPrice > 0 ? Number(sdPrice) : safeNum(price),
      zones1M: zonesBySelectedTimeframe,
      openGaps: signalGapContext.openGaps,
      currentMedian,
      nextMedian,
      techSummary: {
        general: techSummary?.general,
        strength: techSummary?.strength,
        totalCounts: techSummary?.totalCounts,
      },
      marketState: {
        state: marketState?.state,
        strength: marketState?.strength,
      },
      gapCloseProbability10: signalGapContext.totalCloseProb10,
      useTechFilter: true,
      minTechStrengthForEntry: 55,
    });

    const baseLabel =
      rawSignal.tone === "buy" ? "Compra" : rawSignal.tone === "sell" ? "Vendi" : "Neutro";

    if (timeframe === "1d") {
      return {
        ...rawSignal,
        label: baseLabel,
        displayLabel: baseLabel,
      };
    }

    if (timeframe === "1w") {
      if (rawSignal.tone === "neutral") {
        return {
          ...rawSignal,
          label: baseLabel,
          displayLabel: baseLabel,
        };
      }

      const day = new Date().getDay();
      const nearWeekEnd = day >= 4;
      const shouldDelayToWeekEnd = !nearWeekEnd && Number(rawSignal.confidencePct) < 72;
      return {
        ...rawSignal,
        label: baseLabel,
        displayLabel: shouldDelayToWeekEnd
          ? rawSignal.tone === "buy"
            ? "Compra a fine settimana"
            : "Vendi a fine settimana"
          : baseLabel,
      };
    }

    return rawSignal;
  }, [
    timeframe,
    currentMonthIndex,
    cumulativePercentilesMiniWinsorized,
    signalGapContext.openGaps,
    signalGapContext.totalCloseProb10,
    marketState.state,
    marketState.strength,
    techSummary.general,
    techSummary.strength,
    techSummary.totalCounts,
    zonesBySelectedTimeframe,
    sdPrice,
    price,
  ]);

  const srSignalPrice =
    Number.isFinite(sdPrice) && Number(sdPrice) > 0
      ? Number(sdPrice)
      : Number.isFinite(price) && Number(price) > 0
      ? Number(price)
      : null;

  const computeSrOnlySignal = useCallback(
    (zoneSet) => {
      if (!Number.isFinite(srSignalPrice) || srSignalPrice <= 0) {
        return {
          tone: "neutral",
          action: "Neutrale",
          scorePct: 0,
          support: null,
          resistance: null,
          distSupportPct: null,
          distResistancePct: null,
        };
      }

      const extractPrices = (levels) =>
        (Array.isArray(levels) ? levels : [])
          .map((level) => Number(level?.price))
          .filter((value) => Number.isFinite(value));

      const supports = extractPrices(zoneSet?.support)
        .filter((value) => value <= srSignalPrice)
        .sort((a, b) => b - a);

      const resistances = extractPrices(zoneSet?.resistance)
        .filter((value) => value >= srSignalPrice)
        .sort((a, b) => a - b);

      const support = supports.length > 0 ? supports[0] : null;
      const resistance = resistances.length > 0 ? resistances[0] : null;

      const distSupportPct =
        Number.isFinite(support) && srSignalPrice > 0
          ? ((srSignalPrice - support) / srSignalPrice) * 100
          : null;
      const distResistancePct =
        Number.isFinite(resistance) && srSignalPrice > 0
          ? ((resistance - srSignalPrice) / srSignalPrice) * 100
          : null;

      let normalizedScore = 0;
      if (
        Number.isFinite(support) &&
        Number.isFinite(resistance) &&
        resistance > support
      ) {
        const range = resistance - support;
        const position = (srSignalPrice - support) / range;
        const clampedPosition = Math.min(1, Math.max(0, position));
        const rangeScore = (0.5 - clampedPosition) * 2;

        if (
          Number.isFinite(distSupportPct) &&
          Number.isFinite(distResistancePct) &&
          distSupportPct + distResistancePct > 0
        ) {
          const distanceScore =
            (distResistancePct - distSupportPct) /
            (distSupportPct + distResistancePct);
          normalizedScore = rangeScore * 0.6 + distanceScore * 0.4;
        } else {
          normalizedScore = rangeScore;
        }
      } else if (Number.isFinite(support) && !Number.isFinite(resistance)) {
        normalizedScore = 0.2;
      } else if (!Number.isFinite(support) && Number.isFinite(resistance)) {
        normalizedScore = -0.2;
      }

      const scorePct = Math.max(-100, Math.min(100, normalizedScore * 100));
      let tone = "neutral";
      let action = "Neutrale";

      if (scorePct >= 20) {
        tone = "buy";
        action = "Compra";
      } else if (scorePct <= -20) {
        tone = "sell";
        action = "Vendi";
      }

      return {
        tone,
        action,
        scorePct,
        support,
        resistance,
        distSupportPct,
        distResistancePct,
      };
    },
    [srSignalPrice]
  );

  const srHorizonSignals = useMemo(
    () => [
      {
        key: "1d",
        title: "S/R 1D",
        horizonLabel: "oggi",
        ...computeSrOnlySignal(zones1DSignal),
      },
      {
        key: "1w",
        title: "S/R 1W",
        horizonLabel: "fine settimana",
        ...computeSrOnlySignal(zones1WSignal),
      },
      {
        key: "1m",
        title: "S/R 1M",
        horizonLabel: "fine mese",
        ...computeSrOnlySignal(zones1M),
      },
    ],
    [zones1DSignal, zones1WSignal, zones1M, computeSrOnlySignal]
  );

  const seasonReady =
    seasonData &&
    Array.isArray(seasonData.years) &&
    seasonData.years.length > 1 &&
    minYear !== null &&
    maxYear !== null;

  const minPos = seasonReady
    ? (seasonData.years.indexOf(minYear) / (seasonData.years.length - 1)) * 100
    : 0;
  const maxPos = seasonReady
    ? (seasonData.years.indexOf(maxYear) / (seasonData.years.length - 1)) * 100
    : 0;
  const executionPlan = tradingSignal.executionPlan;
  const rr1Value = Number(executionPlan?.riskReward1);
  const rr2Value = Number(executionPlan?.riskReward2);
  const overviewHelpTexts = {
    "Score modello":
      "Punteggio 0-100 del modello. Alto = bias rialzista, basso = bias ribassista. Da solo non basta: conta anche la confidenza.",
    Prezzo:
      "Prezzo corrente usato nei calcoli di distanza da supporti/resistenze e nel piano operativo.",
    Forza:
      "Forza del market state (0-100). Piu alto indica una lettura di mercato piu marcata.",
    Supporti:
      "Numero di livelli di supporto rilevati nel timeframe attivo.",
    Resistenze:
      "Numero di livelli di resistenza rilevati nel timeframe attivo.",
    "Gap aperti":
      "Numero di gap ancora aperti (non riempiti almeno al 50%).",
    "Prob. chiusura gap":
      "Probabilita storica di chiusura gap (>=50%) entro 10 candele. Piu alta = maggiore tendenza a chiudersi.",
    Stagionalita:
      "Contributo stagionale al segnale (-100 a +100). Positivo aiuta buy, negativo aiuta sell. Disponibile solo su 1M.",
    "Timeframe segnale":
      "Orizzonte operativo del segnale: 1D oggi, 1W fine settimana, 1M fine mese.",
    "S/R trend":
      "Contributo di supporti/resistenze (-100 a +100). Positivo se il prezzo e piu vicino ai supporti, negativo se e piu vicino alle resistenze.",
    Tecnici:
      "Contributo degli indicatori tecnici (-100 a +100). Positivo = pressione buy, negativo = pressione sell.",
    Consenso:
      "Accordo tra i blocchi del modello (-100 a +100). Valori estremi indicano convergenza forte nella stessa direzione.",
    "Market state":
      "Contributo della lettura di stato mercato (-100 a +100), derivato da direzione e forza del regime.",
    Confidenza:
      "Affidabilita del segnale (0-100). In genere serve una soglia minima per attivare Compra/Vendi.",
    Regime:
      "Contesto di mercato stimato dal modello: Range, Trend moderato o Trend forte.",
    "Gap target":
      "Direzione del gap obiettivo piu rilevante per il segnale: Up, Down o nessuno.",
    "Gap score":
      "Impatto dei gap aperti sul segnale (-100 a +100). Positivo favorisce buy, negativo favorisce sell.",
    "Bonus timing":
      "Aggiustamento temporale del segnale (es. logica fine settimana/fine mese). Spesso vale 0 fuori dalle finestre utili.",
  };

  const renderOverviewHelp = (labelKey) => (
    <button
      type="button"
      className="help-tip overview-help-tip"
      title={overviewHelpTexts[labelKey] || "Informazione disponibile."}
      aria-label={`Info ${labelKey}`}
    >
      ?
    </button>
  );

  if (loading && history.length === 0) {
    return (
      <div className={`supply-demand-page ${darkMode ? "dark" : "light"}`}>
        <div className={`page-loading ${darkMode ? "dark" : "light"} page-loading--previsione`}>
          <div className="loading-title">Caricamento dati</div>
          <div className="skeleton-shell previsione-skeleton">
            <div className="skeleton-cards">
              <div className="skeleton-block" style={{ height: 280 }} />
              <div className="skeleton-block" style={{ height: 280 }} />
              <div className="skeleton-block" style={{ height: 280 }} />
            </div>
            <div className="skeleton-block skeleton-chart" style={{ height: 420 }} />
          </div>
        </div>
      </div>
    );
  }
  if (error && history.length === 0) {
    return <div className="status error status--previsione">{error}</div>;
  }
return (
    <div className={`supply-demand-page ${darkMode ? "dark" : "light"}`}>
      <div className="supply-demand-main">

        <div className="overview-strip-card">
          <div className="overview-strip-head">
            <div className="overview-strip-symbol">{symbol || "Ticker"}</div>
            <span className={`overview-signal-badge overview-signal-badge--hero ${tradingSignal.tone}`}>
              {tradingSignal.displayLabel || tradingSignal.label}
            </span>
          </div>
          <div className="timeframe-selector overview-timeframe-selector">
            {timeframes.map((tf) => (
              <button
                key={`overview-tf-${tf.value}`}
                className={timeframe === tf.value ? "active" : ""}
                onClick={() => setTimeframe(tf.value)}
              >
                {tf.label}
              </button>
            ))}
          </div>
          <div className="overview-horizon-grid">
            {srHorizonSignals.map((signal) => (
              <div className={`overview-horizon-card ${signal.tone}`} key={signal.key}>
                <div className="overview-horizon-head">
                  <span className="overview-horizon-title">{signal.title}</span>
                  <span className="overview-horizon-ref">Target: {signal.horizonLabel}</span>
                </div>
                <span className={`overview-horizon-badge ${signal.tone}`}>
                  {signal.action}
                </span>
                <div className="overview-horizon-main">
                  <span>Score S/R</span>
                  <strong>{formatSignedPercent(signal.scorePct, 1)}</strong>
                </div>
                <div className="overview-horizon-levels">
                  <span>S: {formatPrice(signal.support)}</span>
                  <span>R: {formatPrice(signal.resistance)}</span>
                </div>
                <div className="overview-horizon-levels">
                  <span>Dist. S: {formatPercent(signal.distSupportPct, 2)}</span>
                  <span>Dist. R: {formatPercent(signal.distResistancePct, 2)}</span>
                </div>
              </div>
            ))}
          </div>
          <div className="overview-strip-metrics">
            <div className={`overview-metric overview-metric-signal ${tradingSignal.tone}`}>
              <span className="overview-label overview-label-with-tip">
                Score modello
                {renderOverviewHelp("Score modello")}
              </span>
              <strong className={`overview-value signal-${tradingSignal.tone}`}>
                {formatPercent(tradingSignal.scorePct, 1)}
              </strong>
            </div>
            <div className="overview-metric">
              <span className="overview-label overview-label-with-tip">
                Prezzo
                {renderOverviewHelp("Prezzo")}
              </span>
              <strong className="overview-value">{formatPrice(price)}</strong>
            </div>
            <div className="overview-metric">
              <span className="overview-label overview-label-with-tip">
                Forza
                {renderOverviewHelp("Forza")}
              </span>
              <strong className="overview-value">{marketState.strength}%</strong>
            </div>
            <div className="overview-metric">
              <span className="overview-label overview-label-with-tip">
                Supporti
                {renderOverviewHelp("Supporti")}
              </span>
              <strong className="overview-value">{sortedSupports.length}</strong>
            </div>
            <div className="overview-metric">
              <span className="overview-label overview-label-with-tip">
                Resistenze
                {renderOverviewHelp("Resistenze")}
              </span>
              <strong className="overview-value">{sortedResistances.length}</strong>
            </div>
            <div className="overview-metric">
              <span className="overview-label overview-label-with-tip">
                Gap aperti
                {renderOverviewHelp("Gap aperti")}
              </span>
              <strong className="overview-value">{signalGapContext.openGaps.length}</strong>
            </div>
            <div className="overview-metric">
              <span className="overview-label overview-label-with-tip">
                Prob. chiusura gap
                {renderOverviewHelp("Prob. chiusura gap")}
              </span>
              <strong className="overview-value">{formatPercent(signalGapContext.totalCloseProb10, 1)}</strong>
            </div>
          </div>
          <div className="overview-signal-breakdown">
            <span className="overview-breakdown-item">
              <span className="overview-breakdown-label">
                Stagionalita
                {renderOverviewHelp("Stagionalita")}:
              </span>{" "}
              {timeframe === "1mo"
                ? formatSignedPercent(tradingSignal.components.season, 0)
                : "N/A (solo 1M)"}
            </span>
            <span className="overview-breakdown-item">
              <span className="overview-breakdown-label">
                Timeframe segnale
                {renderOverviewHelp("Timeframe segnale")}:
              </span>{" "}
              {timeframe.toUpperCase()} ({selectedSignalHorizon})
            </span>
            <span className="overview-breakdown-item">
              <span className="overview-breakdown-label">
                S/R {timeframe.toUpperCase()} trend
                {renderOverviewHelp("S/R trend")}:
              </span>{" "}
              {formatSignedPercent(tradingSignal.components.sr, 0)}
            </span>
            <span className="overview-breakdown-item">
              <span className="overview-breakdown-label">
                Tecnici
                {renderOverviewHelp("Tecnici")}:
              </span>{" "}
              {formatSignedPercent(tradingSignal.components.tech, 0)}
            </span>
            <span className="overview-breakdown-item">
              <span className="overview-breakdown-label">
                Consenso
                {renderOverviewHelp("Consenso")}:
              </span>{" "}
              {formatSignedPercent(tradingSignal.components.consensus, 0)}
            </span>
            <span className="overview-breakdown-item">
              <span className="overview-breakdown-label">
                Market state
                {renderOverviewHelp("Market state")}:
              </span>{" "}
              {formatSignedPercent(tradingSignal.components.market, 0)}
            </span>
            <span className="overview-breakdown-item">
              <span className="overview-breakdown-label">
                Confidenza
                {renderOverviewHelp("Confidenza")}:
              </span>{" "}
              {formatPercent(tradingSignal.confidencePct, 0)}
            </span>
            <span className="overview-breakdown-item">
              <span className="overview-breakdown-label">
                Regime
                {renderOverviewHelp("Regime")}:
              </span>{" "}
              {tradingSignal.regime || "-"}
            </span>
            <span className="overview-breakdown-item">
              <span className="overview-breakdown-label">
                Gap target
                {renderOverviewHelp("Gap target")}:
              </span>{" "}
              {tradingSignal.targetDirection === "up" ? "Up" : tradingSignal.targetDirection === "down" ? "Down" : "-"}
            </span>
            <span className="overview-breakdown-item">
              <span className="overview-breakdown-label">
                Gap score
                {renderOverviewHelp("Gap score")}:
              </span>{" "}
              {formatSignedPercent(tradingSignal.components.gap, 0)}
            </span>
            <span className="overview-breakdown-item">
              <span className="overview-breakdown-label">
                Bonus timing
                {renderOverviewHelp("Bonus timing")}:
              </span>{" "}
              {formatSignedPercent(tradingSignal.components.bonus, 0)}
            </span>
          </div>
          <div className="overview-strategy-plan">
            {executionPlan ? (
              <>
                <div className="overview-plan-item overview-plan-item-entry">
                  <span className="overview-plan-label">Entry</span>
                  <strong className="overview-plan-value">
                    {formatPrice(executionPlan.entryMin)} - {formatPrice(executionPlan.entryMax)}
                  </strong>
                </div>
                <div className="overview-plan-item overview-plan-item-stop">
                  <span className="overview-plan-label">Stop</span>
                  <strong className="overview-plan-value">
                    {formatPrice(executionPlan.stop)}
                  </strong>
                </div>
                <div className="overview-plan-item overview-plan-item-target1">
                  <span className="overview-plan-label">Target 1</span>
                  <strong className="overview-plan-value">
                    {formatPrice(executionPlan.target1)}
                  </strong>
                </div>
                <div className="overview-plan-item overview-plan-item-target2">
                  <span className="overview-plan-label">Target 2</span>
                  <strong className="overview-plan-value">
                    {formatPrice(executionPlan.target2)}
                  </strong>
                </div>
                <div
                  className={`overview-plan-item overview-plan-item-rr overview-plan-item-rr-${rrTone(
                    rr1Value
                  )}`}
                >
                  <span className="overview-plan-label">R/R 1</span>
                  <strong className="overview-plan-value">{formatRiskReward(rr1Value)}</strong>
                </div>
                <div
                  className={`overview-plan-item overview-plan-item-rr overview-plan-item-rr-${rrTone(
                    rr2Value
                  )}`}
                >
                  <span className="overview-plan-label">R/R 2</span>
                  <strong className="overview-plan-value">{formatRiskReward(rr2Value)}</strong>
                </div>
              </>
            ) : (
              <div className="overview-plan-empty">
                Setup operativo: neutrale, nessuna entrata ad alta probabilita.
              </div>
            )}
          </div>
        </div>

        {/* ================= CARD INFORMAZIONI ================= */}
        <div className="cards-row">
          <div className="action-panel seasonality-panel">
            <div className="panel-title">Stagionalità</div>
            <div className="seasonality-body">
              {loadingSeason && <div className="tech-status">Caricamento…</div>}
              {errorSeason && !loadingSeason && <div className="tech-status">{errorSeason}</div>}
              {!loadingSeason && !errorSeason && seasonReady && (
                <>
                  <div className="seasonality-controls">
                    <button
                      type="button"
                      className={`seasonality-toggle ${excludeOutliers ? "active" : ""}`}
                      onClick={() => setExcludeOutliers((v) => !v)}
                    >
                      Winsorizzazione
                    </button>
                  </div>

                  <div className="seasonality-kpi-row">
                    <div className="seasonality-kpi trade-month buy">
                      <span className="kpi-label">Compra</span>
                      <span className="kpi-value">{tradeMonths.buyMonth || "-"}</span>
                    </div>
                    <div className="seasonality-kpi trade-month sell">
                      <span className="kpi-label">Vendi</span>
                      <span className="kpi-value">{tradeMonths.sellMonth || "-"}</span>
                    </div>
                  </div>

                  <div className="seasonality-current">
                    <div className="current-label">Mese corrente</div>
                    <div className="current-month">{currentMonthStats.month || "-"}</div>
                    <div className="current-metrics">
                      <span>Media: {formatPercent(currentMonthStats.avg, 2)}</span>
                      <span>Win rate: {formatPercent(currentMonthStats.winRate, 0)}</span>
                    </div>
                  </div>

                  <div className="year-range-container" ref={rangeRef}>
                    <div className="year-labels">
                      {seasonData.years.map((y, i) => (i % 5 === 0 ? <span key={y}>{y}</span> : null))}
                    </div>

                    <div className="slider-track" />
                    <div
                      className="slider-range"
                      style={{ left: `${minPos}%`, width: `${maxPos - minPos}%` }}
                    />

                    {seasonData.years.map((y) =>
                      y >= minYear && y <= maxYear ? (
                        <div
                          key={y}
                          className="year-indicator"
                          style={{ left: `${(seasonData.years.indexOf(y) / (seasonData.years.length - 1)) * 100}%` }}
                        />
                      ) : null
                    )}

                    <div
                      className="slider-middle"
                      style={{ left: `${minPos + (maxPos - minPos) / 2}%` }}
                      onMouseDown={handleRangeDrag}
                    />

                    <div
                      className="slider-thumb"
                      style={{ left: `${minPos}%` }}
                      onMouseDown={(e) => handleThumbDrag("min", e)}
                    >
                      <span>{minYear}</span>
                    </div>
                    <div
                      className="slider-thumb"
                      style={{ left: `${maxPos}%` }}
                      onMouseDown={(e) => handleThumbDrag("max", e)}
                    >
                      <span>{maxYear}</span>
                    </div>
                  </div>
                </>
              )}
              {!loadingSeason && !errorSeason && !seasonReady && (
                <div className="tech-status">N/D</div>
              )}
            </div>
          </div>

          <div className="supply-demand-card">
            <div className="info-card-container">
              <div className="left-card">
                <h2>Supply & Demand - {symbol}</h2>
                <span className={`badge ${stateColor}`}>{marketState.state.replace("_", " ")}</span>
                <span className="strength">Forza: {marketState.strength}%</span>
                <span className="price">Prezzo: {formatPrice(price)}</span>
                <div className="levels">
                  <div className="levels-col">
                    <div className="levels-title support">Supporti</div>
                    {sortedSupports.length === 0 && (
                      <div className="level-empty">N/D</div>
                    )}
                    {sortedSupports.map((p, i) => (
                      <div className="level-row" key={`support-${i}`}>
                        <span className="level-label">S{i + 1}</span>
                        <span className="level-value">{formatPrice(p)}</span>
                      </div>
                    ))}
                  </div>

                  <div className="levels-col">
                    <div className="levels-title resistance">Resistenze</div>
                    {sortedResistances.length === 0 && (
                      <div className="level-empty">N/D</div>
                    )}
                    {sortedResistances.map((p, i) => (
                      <div className="level-row" key={`resistance-${i}`}>
                        <span className="level-label">R{i + 1}</span>
                        <span className="level-value">{formatPrice(p)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              <div className="right-cards">
                <div
                  className="right-card"
                  onClick={() =>
                    navigate(`/search?query=${encodeURIComponent(symbol)}`)
                  }
                >
                  <div className="card-icon"><FiSearch /></div>
                  <div className="card-text">
                    <div className="card-title">Cerca</div>
                    <div className="card-sub">{symbol || "Ticker"}</div>
                  </div>
                </div>
                <div
                  className="right-card"
                  onClick={() =>
                    navigate(`/technicals?ticker=${encodeURIComponent(symbol)}`)
                  }
                >
                  <div className="card-icon"><FiBarChart2 /></div>
                  <div className="card-text">
                    <div className="card-title">Tecnici</div>
                    <div className="card-sub">Indicatori e segnali</div>
                  </div>
                </div>
                <div
                  className="right-card"
                  onClick={() =>
                    navigate(`/Stagionalità?ticker=${encodeURIComponent(symbol)}`)
                  }
                >
                  <div className="card-icon"><FiCalendar /></div>
                  <div className="card-text">
                    <div className="card-title">Stagionalità</div>
                    <div className="card-sub">Pattern annuali</div>
                  </div>
                </div>
              </div>

            </div>

            <div className="price-bar">
              <span>Supporto</span>
              <div className="bar-container">
                <div className="price-marker" style={{ left: `${supportDist}%` }} />
              </div>
              <span>Resistenza</span>
            </div>

            <div className="advanced-panel">
              <button
                className={`advanced-toggle ${showAdvanced ? "open" : ""}`}
                onClick={() => setShowAdvanced((v) => !v)}
              >
                Parametri avanzati
              </button>
              {showAdvanced && (
                <div className="advanced-grid">
                  <label>
                    <span className="label-row">
                      Forza zone (percentile)
                      <button
                        type="button"
                        className="help-tip"
                        data-tooltip="Pi? alto = meno zone ma pi? forti. Pi? basso = pi? zone."
                        aria-label="Info forza zone"
                      >
                        ?
                      </button>
                    </span>
                    <input
                      type="number"
                      min="1"
                      max="99"
                      step="1"
                      value={draftStrength}
                      onChange={(e) =>
                        setDraftStrength(clampNumber(e.target.value, 1, 99))
                      }
                      placeholder="auto"
                    />
                  </label>
                  <label>
                    <span className="label-row">
                      Distanza minima (%)
                      <button
                        type="button"
                        className="help-tip"
                        data-tooltip="Pi? alto = elimina livelli vicini al prezzo. Pi? basso = livelli pi? vicini."
                        aria-label="Info distanza minima"
                      >
                        ?
                      </button>
                    </span>
                    <input
                      type="number"
                      min="0.1"
                      max="10"
                      step="0.1"
                      value={draftMinDistance}
                      onChange={(e) =>
                        setDraftMinDistance(clampNumber(e.target.value, 0.1, 10))
                      }
                      placeholder="auto"
                    />
                  </label>
                  <label>
                    <span className="label-row">
                      Gap tra zone (%)
                      <button
                        type="button"
                        className="help-tip"
                        data-tooltip="Pi? alto = unisce livelli vicini. Pi? basso = livelli separati."
                        aria-label="Info gap tra zone"
                      >
                        ?
                      </button>
                    </span>
                    <input
                      type="number"
                      min="0.1"
                      max="10"
                      step="0.1"
                      value={draftGap}
                      onChange={(e) =>
                        setDraftGap(clampNumber(e.target.value, 0.1, 10))
                      }
                      placeholder="auto"
                    />
                  </label>
                  <div className="advanced-actions">
                    <button className="apply-btn" type="button" onClick={applyAdvanced}>
                      Applica
                    </button>
                    <button className="reset-btn" type="button" onClick={resetAdvanced}>
                      Reset
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="action-panel tech-panel">
            <div className="panel-title">Tecnici</div>
            <div className="tech-body">
              <div className="tech-timeframe-selector">
                {timeframes.map((tf) => (
                  <button
                    key={tf.value}
                    className={timeframe === tf.value ? "active" : ""}
                    onClick={() => setTimeframe(tf.value)}
                  >
                    {tf.label}
                  </button>
                ))}
              </div>
              {loadingTech && <div className="tech-status">Caricamento?</div>}
              {errorTech && !loadingTech && <div className="tech-status">{errorTech}</div>}
              {!loadingTech && !errorTech && (
                <>
                  <div className={`tech-main ${techSummary.general.toLowerCase()}`}>
                    {techSummary.general}
                  </div>
                <div className="tech-strength">
                  Forza del segnale:{" "}
                  <strong>{techSummary.strengthLabel}</strong> (
                  <span className="tech-pct">{Math.round(techSummary.strength * 100)}%</span>)
                </div>
                  <div className="tech-counts">
                    <span className="buy">Buy: {techSummary.totalCounts.Buy}</span>
                    <span className="neutral">Neutral: {techSummary.totalCounts.Neutral}</span>
                    <span className="sell">Sell: {techSummary.totalCounts.Sell}</span>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>

{/* ================= CARD GRAFICO ================= */}
        <div className="chart-card">
          <div className="supply-chart-panel">
            <div className="chart-controls">
              <div className="timeframe-selector">
                {timeframes.map((tf) => (
                  <button
                    key={tf.value}
                    className={timeframe === tf.value ? "active" : ""}
                    onClick={() => setTimeframe(tf.value)}
                  >
                    {tf.label}
                  </button>
                ))}
              </div>
              <div className="chart-type-selector">
                <button
                  className={effectiveChartType === "line" ? "active" : ""}
                  onClick={() => setChartType("line")}
                >
                  Linee
                </button>
                <button
                  className={effectiveChartType === "candlestick" ? "active" : ""}
                  onClick={() => setChartType("candlestick")}
                  disabled={!hasOhlc}
                  title={!hasOhlc ? "Dati OHLC non disponibili" : undefined}
                >
                  Candele
                </button>
              </div>
            </div>
            {loading && <div className="chart-status">Aggiornamento dati�</div>}
            {error && !loading && <div className="chart-status error">{error}</div>}
            <Chart type={effectiveChartType} data={chartData} options={chartOptions} />
          </div>

          <div className="supply-chart-panel gap-chart-panel">
            <div className="gap-panel-header">
              <h3>Analisi Gap</h3>
              <span className="gap-panel-subtitle">
                Ultimi 5 anni (logica Portify: gap classici + gap 3 candele)
              </span>
            </div>

            <div className="gap-kpi-grid">
              <div className="gap-kpi">
                <span>Gap totali</span>
                <strong>{gapAnalysis.gaps.length}</strong>
              </div>
              <div className="gap-kpi">
                <span>Gap aperti</span>
                <strong>{gapAnalysis.openGaps.length}</strong>
              </div>
              <div className="gap-kpi">
                <span>Gap chiusi</span>
                <strong>{gapAnalysis.closedGaps.length}</strong>
              </div>
              <div className="gap-kpi">
                <span>Prob. chiusura (10 candele)</span>
                <strong>{formatPercent(gapAnalysis.totalCloseProb10, 2)}</strong>
              </div>
            </div>

            <div className="gap-prob-row">
              {gapTypeLabels.map((type) => (
                <div key={type} className="gap-prob-item">
                  <span>{displayGapType(type)}</span>
                  <strong>{formatPercent(gapAnalysis.byType[type], 2)}</strong>
                </div>
              ))}
            </div>

            <div className="gap-latest-row">
              {gapAnalysis.latestOpenGap ? (
                <span>
                  Ultimo gap aperto: <strong>{displayGapType(gapAnalysis.latestOpenGap.type)}</strong> (
                  {gapAnalysis.latestOpenGap.dateObj.toLocaleDateString("it-IT")}) - range{" "}
                  <strong>
                    {formatPrice(gapAnalysis.latestOpenGap.start)} ->{" "}
                    {formatPrice(gapAnalysis.latestOpenGap.end)}
                  </strong>
                </span>
              ) : (
                <span>Nessun gap aperto nel timeframe attuale.</span>
              )}
            </div>

            <div className="gap-open-list">
              <div className="gap-open-list-title">Range gap aperti</div>
              {openGapRanges.length > 0 ? (
                <div className="gap-open-list-body">
                  {openGapRanges.map((gap, idx) => (
                    <div key={`${gap.date}-${gap.type}-${idx}`} className="gap-open-item">
                      <span className="gap-open-item-type">{displayGapType(gap.type)}</span>
                      <span className="gap-open-item-date">
                        {gap.dateObj.toLocaleDateString("it-IT")}
                      </span>
                      <span className="gap-open-item-range">
                        {formatPrice(gap.start)} -> {formatPrice(gap.end)}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="gap-open-item empty">Nessun gap aperto.</div>
              )}
            </div>

            <div className="gap-chart-toolbar">
              <button
                type="button"
                className="gap-reset-zoom-btn"
                onClick={() => gapChartRef.current?.resetZoom?.()}
              >
                Reset Zoom
              </button>
              <span className="gap-chart-hint">
                Zoom: rotella/pinch - Sposta: trascina orizzontalmente
              </span>
            </div>

            <div className="gap-chart-wrap">
              {gapAnalysis.gaps.length > 0 && gapHasOhlc ? (
                <Chart
                  ref={gapChartRef}
                  type="candlestick"
                  data={gapCandleData}
                  options={gapCandleOptions}
                  plugins={openGapOverlayPlugins}
                />
              ) : (
                <div className="chart-status">
                  {gapAnalysis.gaps.length === 0
                    ? "Nessun gap rilevato per questo timeframe."
                    : "Dati candlestick non disponibili per mostrare i gap."}
                </div>
              )}
            </div>

            <div className="seasonality-mini-chart">
              <div className="seasonality-mini-chart-title">
                Percentili cumulativi winsorizzati (mese corrente + prossimo)
              </div>
              {loadingSeason ? (
                <div className="tech-status">Caricamento…</div>
              ) : errorSeason ? (
                <div className="tech-status">{errorSeason}</div>
              ) : cumulativeMiniChart ? (
                <div className="seasonality-mini-chart-wrap">
                  <Plot
                    data={cumulativeMiniChart.data}
                    layout={cumulativeMiniChart.layout}
                    config={cumulativeMiniChart.config}
                    useResizeHandler
                    style={{ width: "100%", height: "100%" }}
                  />
                </div>
              ) : (
                <div className="tech-status">N/D</div>
              )}
            </div>
          </div>
        </div>

      </div>
    </div>
  );
}
