import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Doughnut, Line } from "react-chartjs-2";
import {
  ArcElement,
  CategoryScale,
  Chart as ChartJS,
  Filler,
  Legend,
  LinearScale,
  LineElement,
  PointElement,
  Tooltip,
} from "chart.js";
import {
  computePortfolioTradingSignal,
  TRADING_SIGNAL_VERSION,
} from "../utils/tradingSignal";
import { fetchSavedSocialPortfolios, syncSocialPortfolios } from "../services/api";
import { apiUrl } from "../services/apiBase";
import "./Home.css";
const PORTFOLIO_STORAGE_PREFIX = "portfolio-tickers:v1:";
const HOME_SNAPSHOT_PREFIX = "home-snapshot:v1:";
const PORTFOLIO_SIGNAL_TTL_MS = 3 * 60 * 1000;
const HOME_SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1000;
const SOCIAL_SYNC_DEBOUNCE_MS = 1200;
const SAVED_SOCIAL_REFRESH_MS = 45 * 1000;
const DEFAULT_PORTFOLIO_ID = "portfolio-1";
const MAX_PORTFOLIO_NAME_LEN = 40;
const CHART_COLORS = [
  "#4e5dcc",
  "#16a34a",
  "#f59e0b",
  "#dc2626",
  "#0891b2",
  "#7c3aed",
  "#475569",
  "#be123c",
];
const WATCHLIST_SIGNAL_TIMEFRAME_OPTIONS = [
  { value: "1d", label: "1D" },
  { value: "1w", label: "1W" },
  { value: "1mo", label: "1M" },
];

const normalizeSignalTimeframe = (value) => {
  if (value === "1w" || value === "1mo") return value;
  return "1d";
};

const buildWatchlistSignalCacheKey = (ticker, timeframe) => {
  const normalizedTicker = normalizeTicker(ticker);
  const normalizedTimeframe = normalizeSignalTimeframe(timeframe);
  return `${normalizedTicker}|watchlist|${normalizedTimeframe}|${normalizedTimeframe}`;
};

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  ArcElement,
  Tooltip,
  Legend,
  Filler
);

const normalizeTicker = (value) =>
  (value || "").trim().toUpperCase().replace(/\s+/g, "");

const uniqueTickers = (list) =>
  (Array.isArray(list) ? list : [])
    .map(normalizeTicker)
    .filter(Boolean)
    .filter((item, idx, arr) => arr.indexOf(item) === idx);

const parseHistoryDate = (value) => {
  if (!value) return null;
  const normalizedValue =
    typeof value === "string" && /^\d{4}-\d{2}$/.test(value) ? `${value}-01` : value;
  const parsed = new Date(normalizedValue);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const createPortfolioEntryId = (ticker) => {
  const normalized = normalizeTicker(ticker) || "ROW";
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${normalized}-${crypto.randomUUID()}`;
  }
  return `${normalized}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
};

const createPortfolioBucketId = () => {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `portfolio-${crypto.randomUUID()}`;
  }
  return `portfolio-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
};

const normalizePortfolioName = (value, fallback = "Portafoglio") => {
  const raw =
    typeof value === "string" && value.trim() ? value.trim() : fallback;
  return raw.slice(0, MAX_PORTFOLIO_NAME_LEN);
};

const normalizePortfolioVisibility = (value, fallback = "public") => {
  if (value === "private" || value === false) return "private";
  if (value === "public" || value === true) return "public";
  return fallback === "private" ? "private" : "public";
};

const createDefaultPortfolioCollection = () => ({
  activeId: DEFAULT_PORTFOLIO_ID,
  items: [
    { id: DEFAULT_PORTFOLIO_ID, name: "Portafoglio 1", visibility: "private", entries: [] },
  ],
});

const resolveActivePortfolioId = (collection) => {
  const items = Array.isArray(collection?.items) ? collection.items : [];
  if (!items.length) return DEFAULT_PORTFOLIO_ID;
  const activeId =
    typeof collection?.activeId === "string" && collection.activeId.trim()
      ? collection.activeId.trim()
      : items[0].id;
  return items.some((item) => item.id === activeId) ? activeId : items[0].id;
};

const normalizePortfolioEntries = (raw) => {
  const source = Array.isArray(raw) ? raw : [];
  const out = [];

  source.forEach((item, index) => {
    const ticker =
      typeof item === "string"
        ? normalizeTicker(item)
        : normalizeTicker(item?.ticker);
    if (!ticker) return;

    const status = item?.status === "sold" ? "sold" : "bought";
    const initialPriceNum = Number(item?.initialPrice);
    const addedAtNum = Number(item?.addedAt);
    const soldAtNum = Number(item?.soldAt);
    const soldPriceNum = Number(item?.soldPrice);
    const lockedReturnPctNum = Number(item?.lockedReturnPct);
    const addedAt =
      Number.isFinite(addedAtNum) && addedAtNum > 0
        ? Math.round(addedAtNum)
        : Date.now();
    const storedId =
      typeof item?.id === "string" && item.id.trim() ? item.id.trim() : null;
    const id = storedId || `${ticker}-${addedAt}-${index}`;
    const shortNameSnapshot =
      typeof item?.shortNameSnapshot === "string" && item.shortNameSnapshot.trim()
        ? item.shortNameSnapshot.trim()
        : null;

    out.push({
      id,
      ticker,
      initialPrice:
        Number.isFinite(initialPriceNum) && initialPriceNum > 0
          ? Number(initialPriceNum)
          : null,
      addedAt,
      status,
      soldAt:
        status === "sold" && Number.isFinite(soldAtNum) && soldAtNum > 0
          ? Math.round(soldAtNum)
          : null,
      soldPrice:
        status === "sold" && Number.isFinite(soldPriceNum) && soldPriceNum > 0
          ? Number(soldPriceNum)
          : null,
      lockedReturnPct:
        status === "sold" && Number.isFinite(lockedReturnPctNum)
          ? Number(lockedReturnPctNum)
          : null,
      shortNameSnapshot,
    });
  });

  return out;
};

const normalizePortfolioCollection = (raw) => {
  const fallback = createDefaultPortfolioCollection();

  if (Array.isArray(raw)) {
    const looksLikeLegacyEntries = raw.some(
      (item) => typeof item === "string" || (item && typeof item === "object" && "ticker" in item)
    );
    if (looksLikeLegacyEntries) {
      const legacyEntries = normalizePortfolioEntries(raw);
      if (!legacyEntries.length) return fallback;
      return {
        activeId: DEFAULT_PORTFOLIO_ID,
        items: [
          {
            id: DEFAULT_PORTFOLIO_ID,
            name: "Portafoglio 1",
            visibility: "public",
            entries: legacyEntries,
          },
        ],
      };
    }
  }

  const sourceItems = Array.isArray(raw?.items)
    ? raw.items
    : Array.isArray(raw)
    ? raw
    : [];

  const normalizedItems = [];
  const usedIds = new Set();

  sourceItems.forEach((item, index) => {
    const fallbackId = `portfolio-${index + 1}`;
    let id =
      typeof item?.id === "string" && item.id.trim() ? item.id.trim() : fallbackId;
    if (usedIds.has(id)) {
      let suffix = 2;
      while (usedIds.has(`${id}-${suffix}`)) suffix += 1;
      id = `${id}-${suffix}`;
    }
    usedIds.add(id);

    normalizedItems.push({
      id,
      name: normalizePortfolioName(item?.name, `Portafoglio ${index + 1}`),
      visibility: normalizePortfolioVisibility(item?.visibility, "public"),
      entries: normalizePortfolioEntries(item?.entries),
    });
  });

  if (!normalizedItems.length) return fallback;

  const requestedActiveId =
    typeof raw?.activeId === "string" && raw.activeId.trim()
      ? raw.activeId.trim()
      : normalizedItems[0].id;
  const activeId = normalizedItems.some((item) => item.id === requestedActiveId)
    ? requestedActiveId
    : normalizedItems[0].id;

  return {
    activeId,
    items: normalizedItems,
  };
};

const readJsonFromStorage = (key) => {
  try {
    return JSON.parse(localStorage.getItem(key) || "null");
  } catch {
    return null;
  }
};

const normalizeTickerMap = (raw) => {
  const source = raw && typeof raw === "object" ? raw : {};
  const out = {};

  Object.entries(source).forEach(([key, value]) => {
    const ticker = normalizeTicker(key);
    if (!ticker || value == null || typeof value !== "object") return;
    out[ticker] = value;
  });

  return out;
};

const isSignalVersionValid = (signal) =>
  signal &&
  typeof signal === "object" &&
  signal.strategyVersion === TRADING_SIGNAL_VERSION;

const filterSignalMapByVersion = (raw) => {
  const source = normalizeTickerMap(raw);
  const out = {};
  Object.entries(source).forEach(([ticker, signal]) => {
    if (isSignalVersionValid(signal)) out[ticker] = signal;
  });
  return out;
};

const summarizeTechnicals = (payload) => {
  const countAction = (list = []) => {
    const counts = { Buy: 0, Sell: 0, Neutral: 0 };
    list.forEach((row) => {
      const action = row?.action ?? "Neutral";
      if (counts[action] !== undefined) counts[action] += 1;
    });
    return counts;
  };

  const oscCounts = countAction(payload?.oscillatorsSummary);
  const maCounts = countAction(payload?.movingAveragesSummary);
  const totalCounts = {
    Buy: oscCounts.Buy + maCounts.Buy,
    Sell: oscCounts.Sell + maCounts.Sell,
    Neutral: oscCounts.Neutral + maCounts.Neutral,
  };
  const totalSignals = totalCounts.Buy + totalCounts.Sell + totalCounts.Neutral;
  const strength =
    totalSignals > 0 ? Math.max(totalCounts.Buy, totalCounts.Sell) / totalSignals : 0;
  const strengthLabel = strength > 0.7 ? "Strong" : strength > 0.55 ? "Moderate" : "Weak";
  const general =
    totalCounts.Buy > Math.max(totalCounts.Sell, totalCounts.Neutral)
      ? "Buy"
      : totalCounts.Sell > Math.max(totalCounts.Buy, totalCounts.Neutral)
      ? "Sell"
      : "Neutral";

  return { general, totalCounts, strength, strengthLabel };
};

const fmtEuro = (n) => {
  if (n == null) return "-";
  return new Intl.NumberFormat("de-DE", {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: 2,
  }).format(n);
};

const fmtSignedPct = (value) => {
  if (!Number.isFinite(value)) return "-";
  if (Math.abs(value) < 0.005) return "0%";
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
};

const fmtShortDateTime = (value) => {
  if (!value) return "";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "";
  return new Intl.DateTimeFormat("it-IT", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(parsed);
};

const isMeaningfulLabel = (value) => {
  if (typeof value !== "string") return false;
  const cleaned = value.trim();
  if (!cleaned) return false;
  const normalized = cleaned.toUpperCase();
  return ![
    "N/A",
    "NA",
    "N.D.",
    "N/D",
    "NULL",
    "NONE",
    "UNKNOWN",
    "-",
    "--",
  ].includes(normalized);
};

const pickBestLabel = (...values) => {
  for (const value of values) {
    if (isMeaningfulLabel(value)) return String(value).trim();
  }
  return null;
};

const sumBy = (list, selector) =>
  list.reduce((acc, item) => {
    const value = selector(item);
    return Number.isFinite(value) ? acc + Number(value) : acc;
  }, 0);

const computeReturnSummary = (items) => {
  const invested = sumBy(items, (item) => item.initialPrice);
  const current = sumBy(items, (item) => item.currentValue);
  const returnPct = sumBy(items, (item) => item.returnPct);

  return {
    invested,
    current,
    returnPct,
    count: items.length,
  };
};

const toFiniteNumber = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Number(parsed) : null;
};

const computeEntryClosedReturnPct = (entry) => {
  const status = entry?.status === "sold" ? "sold" : "bought";
  if (status !== "sold") return 0;

  const locked = toFiniteNumber(entry?.lockedReturnPct);
  if (locked != null) return locked;

  const initialPrice = toFiniteNumber(entry?.initialPrice);
  const soldPrice = toFiniteNumber(entry?.soldPrice);
  if (initialPrice != null && initialPrice > 0 && soldPrice != null) {
    return ((soldPrice - initialPrice) / initialPrice) * 100;
  }
  return 0;
};

const buildSocialPortfoliosPayload = (collection) => {
  const items = Array.isArray(collection?.items) ? collection.items : [];

  return items
    .filter((portfolio) => normalizePortfolioVisibility(portfolio?.visibility, "public") === "public")
    .map((portfolio, index) => {
      const clientId =
        typeof portfolio?.id === "string" && portfolio.id.trim()
          ? portfolio.id.trim()
          : `portfolio-${index + 1}`;
      const name = normalizePortfolioName(portfolio?.name, `Portafoglio ${index + 1}`);
      const entries = Array.isArray(portfolio?.entries) ? portfolio.entries : [];
      const tickers = uniqueTickers(entries.map((entry) => entry?.ticker)).slice(0, 12);
      const closedCount = entries.filter((entry) => entry?.status === "sold").length;
      const openCount = entries.length - closedCount;
      const returnPct = entries.reduce(
        (acc, entry) => acc + computeEntryClosedReturnPct(entry),
        0
      );

      return {
        clientId,
        name,
        returnPct: Number(returnPct.toFixed(2)),
        entriesCount: entries.length,
        openCount,
        closedCount,
        tickers,
      };
    })
    .filter((item) => item.clientId);
};

const Home = ({
  darkMode,
  user,
  token,
  watchlist = [],
  onSaveWatchlist,
  watchlistLoading,
  watchlistError,
}) => {
  const navigate = useNavigate();
  const normalizedWatchlist = useMemo(() => uniqueTickers(watchlist), [watchlist]);
  const storageScope = useMemo(
    () => (user?.username || "guest").toLowerCase(),
    [user?.username]
  );
  const portfolioStorageKey = useMemo(
    () => `${PORTFOLIO_STORAGE_PREFIX}${storageScope}`,
    [storageScope]
  );
  const homeSnapshotKey = useMemo(
    () => `${HOME_SNAPSHOT_PREFIX}${storageScope}`,
    [storageScope]
  );

  const [showAddBox, setShowAddBox] = useState(false);
  const [searchInput, setSearchInput] = useState("");
  const [searchResult, setSearchResult] = useState(null);
  const [searchError, setSearchError] = useState("");
  const [watchlistData, setWatchlistData] = useState({});
  const [draggedTicker, setDraggedTicker] = useState(null);
  const [dragOverTicker, setDragOverTicker] = useState(null);

  const [portfolioInput, setPortfolioInput] = useState("");
  const [portfolioCollection, setPortfolioCollection] = useState(() =>
    createDefaultPortfolioCollection()
  );
  const [showCreatePortfolioCard, setShowCreatePortfolioCard] = useState(false);
  const [newPortfolioVisibility, setNewPortfolioVisibility] = useState("private");
  const [editingPortfolioId, setEditingPortfolioId] = useState(null);
  const [editingPortfolioNameDraft, setEditingPortfolioNameDraft] = useState("");
  const [showDeletePortfolioConfirm, setShowDeletePortfolioConfirm] = useState(false);
  const [portfolioQuotes, setPortfolioQuotes] = useState({});
  const [watchlistSignals, setWatchlistSignals] = useState({});
  const [watchlistSignalTimeframe, setWatchlistSignalTimeframe] = useState("1d");
  const [portfolioView, setPortfolioView] = useState("bought");
  const [portfolioError, setPortfolioError] = useState("");
  const [savedSocialPortfolios, setSavedSocialPortfolios] = useState([]);
  const [savedSocialLoading, setSavedSocialLoading] = useState(false);
  const [savedSocialError, setSavedSocialError] = useState("");
  const [homeSnapshotReady, setHomeSnapshotReady] = useState(false);

  const activePortfolioId = useMemo(
    () => resolveActivePortfolioId(portfolioCollection),
    [portfolioCollection]
  );
  const activePortfolio = useMemo(
    () =>
      portfolioCollection.items.find((portfolio) => portfolio.id === activePortfolioId) ||
      portfolioCollection.items[0] ||
      null,
    [portfolioCollection.items, activePortfolioId]
  );
  const activePortfolioVisibility = useMemo(
    () => normalizePortfolioVisibility(activePortfolio?.visibility, "public"),
    [activePortfolio?.visibility]
  );
  const portfolioEntries = useMemo(
    () => (Array.isArray(activePortfolio?.entries) ? activePortfolio.entries : []),
    [activePortfolio]
  );
  const socialPortfoliosPayload = useMemo(
    () => buildSocialPortfoliosPayload(portfolioCollection),
    [portfolioCollection]
  );

  const portfolioTickers = useMemo(
    () => portfolioEntries.map((entry) => entry.ticker),
    [portfolioEntries]
  );
  const portfolioSignalTickers = useMemo(
    () => uniqueTickers(portfolioTickers),
    [portfolioTickers]
  );

  const suppressClickRef = useRef(false);
  const portfolioSignalCacheRef = useRef(new Map());
  const portfolioStorageSyncRef = useRef(true);
  const watchlistPriceFetchInFlightRef = useRef(false);
  const watchlistSignalFetchInFlightRef = useRef(false);
  const portfolioQuoteFetchInFlightRef = useRef(false);
  const socialSyncSignatureRef = useRef("");
  const clearSignalCacheForTicker = useCallback((ticker) => {
    const normalized = normalizeTicker(ticker);
    if (!normalized) return;
    Array.from(portfolioSignalCacheRef.current.keys()).forEach((key) => {
      if (key === normalized || key.startsWith(`${normalized}|`)) {
        portfolioSignalCacheRef.current.delete(key);
      }
    });
  }, []);
  const updatePortfolioEntriesById = useCallback((portfolioId, updater) => {
    setPortfolioCollection((prevCollection) => {
      const normalizedCollection = normalizePortfolioCollection(prevCollection);
      const resolvedId =
        typeof portfolioId === "string" && portfolioId.trim()
          ? portfolioId.trim()
          : resolveActivePortfolioId(normalizedCollection);

      const nextItems = normalizedCollection.items.map((portfolio) => {
        if (portfolio.id !== resolvedId) return portfolio;
        const currentEntries = Array.isArray(portfolio.entries) ? portfolio.entries : [];
        const updatedEntries =
          typeof updater === "function" ? updater(currentEntries) : updater;
        return {
          ...portfolio,
          entries: normalizePortfolioEntries(updatedEntries),
        };
      });

      return {
        ...normalizedCollection,
        activeId: resolveActivePortfolioId({
          ...normalizedCollection,
          items: nextItems,
        }),
        items: nextItems,
      };
    });
  }, []);

  useEffect(() => {
    setHomeSnapshotReady(false);
    portfolioSignalCacheRef.current = new Map();

    const snapshot = readJsonFromStorage(homeSnapshotKey);
    const snapshotTs = Number(snapshot?.ts);
    const snapshotIsFresh =
      Number.isFinite(snapshotTs) && Date.now() - snapshotTs <= HOME_SNAPSHOT_TTL_MS;
    const snapshotWatchlistData = normalizeTickerMap(snapshot?.watchlistData);
    const snapshotWatchlistSignals = filterSignalMapByVersion(snapshot?.watchlistSignals);
    const snapshotPortfolioQuotes = normalizeTickerMap(snapshot?.portfolioQuotes);
    const snapshotWatchlistSignalTimeframe = normalizeSignalTimeframe(
      snapshot?.watchlistSignalTimeframe
    );

    setWatchlistData(snapshotWatchlistData);
    setWatchlistSignals(snapshotWatchlistSignals);
    setPortfolioQuotes(snapshotPortfolioQuotes);
    setWatchlistSignalTimeframe(snapshotWatchlistSignalTimeframe);

    if (snapshotIsFresh) {
      Object.entries(snapshotWatchlistSignals).forEach(([ticker, data]) => {
        const updatedAt = Number(data?.updatedAt);
        const cacheTs = Number.isFinite(updatedAt) ? updatedAt : snapshotTs;
        const signalTimeframe = normalizeSignalTimeframe(
          data?.signalTimeframe || snapshotWatchlistSignalTimeframe
        );
        if (!Number.isFinite(cacheTs)) return;
        portfolioSignalCacheRef.current.set(buildWatchlistSignalCacheKey(ticker, signalTimeframe), {
          ts: cacheTs,
          data,
        });
      });

    }

    setHomeSnapshotReady(true);
  }, [homeSnapshotKey]);

  useEffect(() => {
    if (!normalizedWatchlist.length) return;
    setWatchlistData((prev) => {
      const next = {};
      normalizedWatchlist.forEach((ticker) => {
        if (prev[ticker]) next[ticker] = prev[ticker];
      });
      return next;
    });
  }, [homeSnapshotReady, normalizedWatchlist]);

  const saveWatchlist = (list) => {
    if (typeof onSaveWatchlist === "function") {
      onSaveWatchlist(uniqueTickers(list));
    }
  };

  const addToWatchlist = (ticker) => {
    const normalized = normalizeTicker(ticker);
    if (!normalized || normalizedWatchlist.includes(normalized)) return;
    saveWatchlist([...normalizedWatchlist, normalized]);
  };

  const removeFromWatchlist = (ticker) => {
    saveWatchlist(normalizedWatchlist.filter((t) => t !== ticker));
    setWatchlistData((prev) => {
      const next = { ...prev };
      delete next[ticker];
      return next;
    });
    setWatchlistSignals((prev) => {
      const next = { ...prev };
      delete next[ticker];
      return next;
    });
    clearSignalCacheForTicker(ticker);
  };

  const reorderWatchlist = (sourceTicker, targetTicker) => {
    if (!sourceTicker || !targetTicker || sourceTicker === targetTicker) return;
    const sourceIndex = normalizedWatchlist.indexOf(sourceTicker);
    const targetIndex = normalizedWatchlist.indexOf(targetTicker);
    if (sourceIndex < 0 || targetIndex < 0) return;

    const next = [...normalizedWatchlist];
    next.splice(sourceIndex, 1);
    next.splice(targetIndex, 0, sourceTicker);
    saveWatchlist(next);
  };

  const handleDragStart = (ticker, event) => {
    suppressClickRef.current = true;
    setDraggedTicker(ticker);
    setDragOverTicker(ticker);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", ticker);
  };

  const handleDragOver = (ticker, event) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    if (dragOverTicker !== ticker) {
      setDragOverTicker(ticker);
    }
  };

  const handleDrop = (ticker, event) => {
    event.preventDefault();
    const source = draggedTicker || event.dataTransfer.getData("text/plain");
    reorderWatchlist(source, ticker);
    setDraggedTicker(null);
    setDragOverTicker(null);
  };

  const handleDragEnd = () => {
    setDraggedTicker(null);
    setDragOverTicker(null);
    window.setTimeout(() => {
      suppressClickRef.current = false;
    }, 0);
  };

  useEffect(() => {
    if (!normalizedWatchlist.length) {
      setWatchlistData((prev) => (Object.keys(prev).length > 0 ? {} : prev));
      return undefined;
    }

    let active = true;

    const fetchData = async () => {
      if (watchlistPriceFetchInFlightRef.current) {
        return;
      }
      watchlistPriceFetchInFlightRef.current = true;

      try {
        const results = await Promise.all(
          normalizedWatchlist.map(async (ticker) => {
            try {
              const response = await fetch(
                apiUrl(`/stock/${encodeURIComponent(ticker)}?priceOnly=true`)
              );
              if (!response.ok) return [ticker, null];
              const data = await response.json();
              return [ticker, data];
            } catch {
              return [ticker, null];
            }
          })
        );

        if (!active) return;
        const freshData = {};
        results.forEach(([ticker, data]) => {
          if (data) freshData[ticker] = data;
        });

        setWatchlistData((prev) => {
          const next = {};
          normalizedWatchlist.forEach((ticker) => {
            if (freshData[ticker]) next[ticker] = freshData[ticker];
            else if (prev[ticker]) next[ticker] = prev[ticker];
          });
          return next;
        });
      } finally {
        watchlistPriceFetchInFlightRef.current = false;
      }
    };

    fetchData();
    const interval = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      fetchData();
    }, 10000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [normalizedWatchlist]);

  useEffect(() => {
    portfolioStorageSyncRef.current = true;
    const stored = normalizePortfolioCollection(readJsonFromStorage(portfolioStorageKey));
    setPortfolioCollection(stored);
    setPortfolioError("");
  }, [portfolioStorageKey]);

  useEffect(() => {
    if (portfolioStorageSyncRef.current) {
      portfolioStorageSyncRef.current = false;
      return;
    }

    try {
      localStorage.setItem(portfolioStorageKey, JSON.stringify(portfolioCollection));
    } catch {
      // ignore storage errors
    }
  }, [portfolioStorageKey, portfolioCollection]);

  useEffect(() => {
    if (!homeSnapshotReady) return;

    try {
      localStorage.setItem(
        homeSnapshotKey,
        JSON.stringify({
          ts: Date.now(),
          watchlistData: normalizeTickerMap(watchlistData),
          watchlistSignals: normalizeTickerMap(watchlistSignals),
          watchlistSignalTimeframe,
          portfolioQuotes: normalizeTickerMap(portfolioQuotes),
        })
      );
    } catch {
      // ignore storage errors
    }
  }, [
    homeSnapshotKey,
    homeSnapshotReady,
    watchlistData,
    watchlistSignals,
    watchlistSignalTimeframe,
    portfolioQuotes,
  ]);

  useEffect(() => {
    if (!token) {
      socialSyncSignatureRef.current = "";
      return undefined;
    }

    let active = true;
    const signature = JSON.stringify(socialPortfoliosPayload);

    const syncToSocial = async (force = false) => {
      if (!force && socialSyncSignatureRef.current === signature) return;
      try {
        await syncSocialPortfolios(token, socialPortfoliosPayload);
        if (active) {
          socialSyncSignatureRef.current = signature;
        }
      } catch {
        // ignore sync errors, retry on next scheduled cycle
      }
    };

    const timeout = setTimeout(() => {
      syncToSocial(false);
    }, SOCIAL_SYNC_DEBOUNCE_MS);
    const interval = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      syncToSocial(true);
    }, SAVED_SOCIAL_REFRESH_MS * 2);

    return () => {
      active = false;
      clearTimeout(timeout);
      clearInterval(interval);
    };
  }, [token, socialPortfoliosPayload]);

  useEffect(() => {
    if (!token) {
      setSavedSocialPortfolios([]);
      setSavedSocialError("");
      setSavedSocialLoading(false);
      return undefined;
    }

    let active = true;
    const guardedLoad = async () => {
      if (!active) return;
      setSavedSocialLoading(true);
      setSavedSocialError("");
      try {
        const list = await fetchSavedSocialPortfolios(token);
        if (!active) return;
        setSavedSocialPortfolios(Array.isArray(list) ? list : []);
      } catch (err) {
        if (!active) return;
        setSavedSocialError(
          err.message || "Errore durante il caricamento dei portafogli salvati."
        );
      } finally {
        if (active) {
          setSavedSocialLoading(false);
        }
      }
    };

    guardedLoad();
    const interval = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      guardedLoad();
    }, SAVED_SOCIAL_REFRESH_MS);

    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [token]);

  const fetchSignalForTicker = useCallback(async (ticker, options = {}) => {
    const signalTimeframe = normalizeSignalTimeframe(options?.timeframe);
    const shouldUseSeasonality = signalTimeframe === "1mo";
    const cacheKey = buildWatchlistSignalCacheKey(ticker, signalTimeframe);
    const cacheEntry = portfolioSignalCacheRef.current.get(cacheKey);
    if (
      cacheEntry &&
      isSignalVersionValid(cacheEntry.data) &&
      Date.now() - cacheEntry.ts < PORTFOLIO_SIGNAL_TTL_MS
    ) {
      return cacheEntry.data;
    }

    const [seasonRes, supplyDemandRes, stockRes, technicalRes, historyRes, gapDailyRes] =
      await Promise.all([
        shouldUseSeasonality
          ? fetch(apiUrl(`/seasonality/${encodeURIComponent(ticker)}`)).catch(
              () => null
            )
          : Promise.resolve(null),
        fetch(
          apiUrl(
            `/stock/${encodeURIComponent(ticker)}/supply_demand?timeframe=${signalTimeframe}`
          )
        ).catch(() => null),
        fetch(
          apiUrl(`/stock/${encodeURIComponent(ticker)}?timeframe=${signalTimeframe}`)
        ).catch(() => null),
        fetch(
          apiUrl(`/stock/${encodeURIComponent(ticker)}/technicals?timeframe=${signalTimeframe}`)
        ).catch(() => null),
        fetch(
          apiUrl(`/stock/${encodeURIComponent(ticker)}/history?timeframe=${signalTimeframe}`)
        ).catch(() => null),
        shouldUseSeasonality
          ? fetch(apiUrl(`/stock/${encodeURIComponent(ticker)}?timeframe=1d`)).catch(
              () => null
            )
          : Promise.resolve(null),
      ]);

    let seasonData = null;
    let supplyDemandData = null;
    let stockData = null;
    let technicalData = null;
    let historyData = null;
    let gapDailyData = null;

    try {
      if (seasonRes?.ok) seasonData = await seasonRes.json();
    } catch {
      seasonData = null;
    }
    try {
      if (supplyDemandRes?.ok) supplyDemandData = await supplyDemandRes.json();
    } catch {
      supplyDemandData = null;
    }
    try {
      if (stockRes?.ok) stockData = await stockRes.json();
    } catch {
      stockData = null;
    }
    try {
      if (technicalRes?.ok) technicalData = await technicalRes.json();
    } catch {
      technicalData = null;
    }
    try {
      if (historyRes?.ok) historyData = await historyRes.json();
    } catch {
      historyData = null;
    }
    try {
      if (gapDailyRes?.ok) gapDailyData = await gapDailyRes.json();
    } catch {
      gapDailyData = null;
    }

    const techSummary = summarizeTechnicals(technicalData);
    const signalPrice = Number(supplyDemandData?.current_price);
    const stockPrice = Number(stockData?.info?.currentPrice);
    const resolvedPrice =
      Number.isFinite(signalPrice) && signalPrice > 0
        ? Number(signalPrice)
        : Number.isFinite(stockPrice) && stockPrice > 0
        ? Number(stockPrice)
        : null;

    const timeframeHistory = Array.isArray(historyData?.history) ? historyData.history : [];
    let signalOhlc = timeframeHistory;
    if (shouldUseSeasonality) {
      const dailyOhlc = Array.isArray(gapDailyData?.ohlc) ? gapDailyData.ohlc : [];
      if (dailyOhlc.length > 0) {
        const cutoff = new Date();
        cutoff.setHours(0, 0, 0, 0);
        cutoff.setFullYear(cutoff.getFullYear() - 5);
        signalOhlc = dailyOhlc.filter((candle) => {
          const d = parseHistoryDate(candle?.date);
          return d && d >= cutoff;
        });
      }
    }
    if (!signalOhlc.length && Array.isArray(stockData?.ohlc)) {
      signalOhlc = stockData.ohlc;
    }

    const rawSignal = computePortfolioTradingSignal({
      seasonData: shouldUseSeasonality ? seasonData : null,
      monthlyZones: supplyDemandData?.zones || { support: [], resistance: [] },
      currentPrice: resolvedPrice ?? supplyDemandData?.current_price,
      ohlc: signalOhlc,
      marketState: supplyDemandData?.market_state || null,
      techSummary,
    });
    const applyPrevisioneLabelRules = (baseSignal) => {
      const signal =
        baseSignal && typeof baseSignal === "object"
          ? baseSignal
          : {
              label: "Neutro",
              displayLabel: "Neutro",
              tone: "neutral",
              confidencePct: 0,
            };

      const baseLabel =
        signal.tone === "buy" ? "Compra" : signal.tone === "sell" ? "Vendi" : "Neutro";

      if (signalTimeframe === "1d") {
        return {
          ...signal,
          label: baseLabel,
          displayLabel: baseLabel,
        };
      }

      if (signalTimeframe === "1w") {
        if (signal.tone === "neutral") {
          return {
            ...signal,
            label: baseLabel,
            displayLabel: baseLabel,
          };
        }

        const day = new Date().getDay();
        const nearWeekEnd = day >= 4;
        const shouldDelayToWeekEnd = !nearWeekEnd && Number(signal.confidencePct) < 72;
        return {
          ...signal,
          label: baseLabel,
          displayLabel: shouldDelayToWeekEnd
            ? signal.tone === "buy"
              ? "Compra a fine settimana"
              : "Vendi a fine settimana"
            : baseLabel,
        };
      }

      return signal;
    };

    const signal = applyPrevisioneLabelRules(rawSignal);

    const payload = {
      ...signal,
      ticker,
      shortName: pickBestLabel(
        stockData?.info?.shortName,
        stockData?.info?.longName,
        stockData?.info?.sector
      ),
      sector: pickBestLabel(stockData?.info?.sector, stockData?.info?.industry),
      industry: pickBestLabel(stockData?.info?.industry),
      quoteType: pickBestLabel(stockData?.info?.quoteType),
      category: pickBestLabel(
        stockData?.info?.sector,
        stockData?.info?.industry,
        stockData?.info?.quoteType
      ),
      currentPrice: Number.isFinite(stockData?.info?.currentPrice)
        ? Number(stockData.info.currentPrice)
        : resolvedPrice,
      signalTimeframe,
      updatedAt: Date.now(),
    };
    portfolioSignalCacheRef.current.set(cacheKey, { ts: Date.now(), data: payload });
    return payload;
  }, []);

  const fetchPortfolioQuoteForTicker = useCallback(async (ticker) => {
    try {
      const response = await fetch(
        apiUrl(`/stock/${encodeURIComponent(ticker)}?priceOnly=true`)
      );
      if (!response.ok) return null;
      const data = await response.json();
      const info = data?.info || {};
      const currentPrice = Number(info.currentPrice);
      return {
        ticker,
        shortName: pickBestLabel(info.shortName, info.longName),
        sector: pickBestLabel(info.sector, info.industry),
        industry: pickBestLabel(info.industry),
        quoteType: pickBestLabel(info.quoteType),
        category: pickBestLabel(info.sector, info.industry, info.quoteType),
        currentPrice: Number.isFinite(currentPrice) && currentPrice > 0 ? Number(currentPrice) : null,
        updatedAt: Date.now(),
      };
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    if (!portfolioSignalTickers.length) {
      setPortfolioQuotes((prev) => (Object.keys(prev).length > 0 ? {} : prev));
      return undefined;
    }

    let active = true;
    const effectPortfolioId = activePortfolioId;

    const loadPortfolioQuotes = async () => {
      if (portfolioQuoteFetchInFlightRef.current) return;
      portfolioQuoteFetchInFlightRef.current = true;

      try {
        const results = await Promise.all(
          portfolioSignalTickers.map(async (ticker) => {
            const quote = await fetchPortfolioQuoteForTicker(ticker);
            return [ticker, quote];
          })
        );

        if (!active) return;
        const freshQuotes = {};
        results.forEach(([ticker, quote]) => {
          if (quote) freshQuotes[ticker] = quote;
        });

        setPortfolioQuotes((prev) => {
          const next = {};
          portfolioSignalTickers.forEach((ticker) => {
            if (freshQuotes[ticker]) next[ticker] = freshQuotes[ticker];
            else if (prev[ticker]) next[ticker] = prev[ticker];
          });
          return next;
        });

        updatePortfolioEntriesById(effectPortfolioId, (prevEntries) => {
          let changed = false;
          const next = prevEntries.map((entry) => {
            const quote = freshQuotes[entry.ticker];
            const livePrice =
              Number.isFinite(quote?.currentPrice) && quote.currentPrice > 0
                ? Number(quote.currentPrice)
                : null;
            const nextShortName = quote?.shortName || entry.shortNameSnapshot || null;
            const shouldSetInitialPrice = !(
              Number.isFinite(entry.initialPrice) && entry.initialPrice > 0
            );
            const shouldUpdateShortName = nextShortName !== entry.shortNameSnapshot;

            if (!shouldSetInitialPrice && !shouldUpdateShortName) return entry;

            changed = true;
            return {
              ...entry,
              initialPrice:
                shouldSetInitialPrice && livePrice != null ? Number(livePrice) : entry.initialPrice,
              addedAt: shouldSetInitialPrice ? entry.addedAt || Date.now() : entry.addedAt,
              shortNameSnapshot: shouldUpdateShortName ? nextShortName : entry.shortNameSnapshot,
            };
          });
          return changed ? next : prevEntries;
        });
      } finally {
        portfolioQuoteFetchInFlightRef.current = false;
      }
    };

    loadPortfolioQuotes();
    const interval = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      loadPortfolioQuotes();
    }, 15000);

    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [activePortfolioId, portfolioSignalTickers, fetchPortfolioQuoteForTicker, updatePortfolioEntriesById]);

  useEffect(() => {
    if (!homeSnapshotReady) return undefined;
    if (!normalizedWatchlist.length) {
      setWatchlistSignals((prev) => (Object.keys(prev).length > 0 ? {} : prev));
      return undefined;
    }
    let active = true;

    const loadWatchlistSignals = async () => {
      if (watchlistSignalFetchInFlightRef.current) return;
      watchlistSignalFetchInFlightRef.current = true;

      try {
        setWatchlistSignals((prev) => {
          const next = {};
          normalizedWatchlist.forEach((ticker) => {
            const previousSignal = prev[ticker];
            if (previousSignal?.signalTimeframe === watchlistSignalTimeframe) {
              next[ticker] = previousSignal;
            } else {
              const cacheKey = buildWatchlistSignalCacheKey(ticker, watchlistSignalTimeframe);
              const cacheEntry = portfolioSignalCacheRef.current.get(cacheKey);
              if (
                cacheEntry &&
                isSignalVersionValid(cacheEntry.data) &&
                Date.now() - cacheEntry.ts < PORTFOLIO_SIGNAL_TTL_MS
              ) {
                next[ticker] = cacheEntry.data;
              } else {
                next[ticker] = {
                  displayLabel: "Calcolo...",
                  tone: "neutral",
                  scorePct: null,
                  hasData: false,
                  signalTimeframe: watchlistSignalTimeframe,
                };
              }
            }
          });
          return next;
        });

        const results = await Promise.all(
          normalizedWatchlist.map(async (ticker) => {
            try {
              const signal = await fetchSignalForTicker(ticker, {
                timeframe: watchlistSignalTimeframe,
              });
              return [ticker, signal];
            } catch {
              return [
                ticker,
                {
                  displayLabel: "Neutro",
                  tone: "neutral",
                  scorePct: null,
                  hasData: false,
                  signalTimeframe: watchlistSignalTimeframe,
                },
              ];
            }
          })
        );

        if (!active) return;
        const nextSignals = {};
        results.forEach(([ticker, signal]) => {
          nextSignals[ticker] = signal;
        });
        setWatchlistSignals(nextSignals);
      } finally {
        watchlistSignalFetchInFlightRef.current = false;
      }
    };

    loadWatchlistSignals();
    const interval = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      normalizedWatchlist.forEach((ticker) => {
        clearSignalCacheForTicker(ticker);
      });
      loadWatchlistSignals();
    }, PORTFOLIO_SIGNAL_TTL_MS);

    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [
    homeSnapshotReady,
    normalizedWatchlist,
    fetchSignalForTicker,
    watchlistSignalTimeframe,
    clearSignalCacheForTicker,
  ]);

  const selectActivePortfolio = (portfolioId) => {
    setPortfolioCollection((prevCollection) => {
      const normalizedCollection = normalizePortfolioCollection(prevCollection);
      if (!normalizedCollection.items.some((portfolio) => portfolio.id === portfolioId)) {
        return normalizedCollection;
      }
      return {
        ...normalizedCollection,
        activeId: portfolioId,
      };
    });
    setPortfolioView("bought");
    setPortfolioError("");
    setShowDeletePortfolioConfirm(false);
    if (editingPortfolioId && editingPortfolioId !== portfolioId) {
      setEditingPortfolioId(null);
      setEditingPortfolioNameDraft("");
    }
  };

  const createPortfolio = () => {
    setPortfolioCollection((prevCollection) => {
      const normalizedCollection = normalizePortfolioCollection(prevCollection);
      const nextIndex = normalizedCollection.items.length + 1;
      const nextName = normalizePortfolioName("", `Portafoglio ${nextIndex}`);
      const id = createPortfolioBucketId();
      const visibility = normalizePortfolioVisibility(newPortfolioVisibility, "private");
      return {
        activeId: id,
        items: [...normalizedCollection.items, { id, name: nextName, visibility, entries: [] }],
      };
    });
    setPortfolioView("bought");
    setPortfolioError("");
    setEditingPortfolioId(null);
    setEditingPortfolioNameDraft("");
    setShowDeletePortfolioConfirm(false);
    setShowCreatePortfolioCard(false);
  };

  const setPortfolioVisibility = useCallback((portfolioId, visibilityValue) => {
    const normalizedVisibility = normalizePortfolioVisibility(visibilityValue, "public");
    setPortfolioCollection((prevCollection) => {
      const normalizedCollection = normalizePortfolioCollection(prevCollection);
      const nextItems = normalizedCollection.items.map((portfolio) =>
        portfolio.id === portfolioId
          ? { ...portfolio, visibility: normalizedVisibility }
          : portfolio
      );
      return {
        ...normalizedCollection,
        items: nextItems,
      };
    });
  }, []);

  const toggleActivePortfolioVisibility = useCallback(() => {
    if (!activePortfolioId) return;
    setPortfolioVisibility(
      activePortfolioId,
      activePortfolioVisibility === "public" ? "private" : "public"
    );
  }, [activePortfolioId, activePortfolioVisibility, setPortfolioVisibility]);

  const startInlinePortfolioRename = (portfolioId, currentName) => {
    selectActivePortfolio(portfolioId);
    setEditingPortfolioId(portfolioId);
    setEditingPortfolioNameDraft(currentName || "");
  };

  const cancelInlinePortfolioRename = () => {
    setEditingPortfolioId(null);
    setEditingPortfolioNameDraft("");
  };

  const commitInlinePortfolioRename = (portfolioId) => {
    if (!portfolioId || editingPortfolioId !== portfolioId) {
      cancelInlinePortfolioRename();
      return;
    }

    setPortfolioCollection((prevCollection) => {
      const normalizedCollection = normalizePortfolioCollection(prevCollection);
      const targetPortfolio = normalizedCollection.items.find(
        (portfolio) => portfolio.id === portfolioId
      );
      if (!targetPortfolio) return normalizedCollection;

      const nextName = normalizePortfolioName(
        editingPortfolioNameDraft,
        targetPortfolio.name || "Portafoglio"
      );
      const nextItems = normalizedCollection.items.map((portfolio) =>
        portfolio.id === portfolioId
          ? { ...portfolio, name: nextName }
          : portfolio
      );
      return {
        ...normalizedCollection,
        items: nextItems,
      };
    });
    setEditingPortfolioId(null);
    setEditingPortfolioNameDraft("");
    setPortfolioError("");
  };

  const requestDeleteActivePortfolio = () => {
    if (!activePortfolio) return;
    if (portfolioCollection.items.length <= 1) {
      setPortfolioError("Devi mantenere almeno un portafoglio.");
      return;
    }
    setShowDeletePortfolioConfirm(true);
    setEditingPortfolioId(null);
    setEditingPortfolioNameDraft("");
  };

  const cancelDeleteActivePortfolio = () => {
    setShowDeletePortfolioConfirm(false);
  };

  const confirmDeleteActivePortfolio = () => {
    if (!activePortfolio) return;
    setPortfolioCollection((prevCollection) => {
      const normalizedCollection = normalizePortfolioCollection(prevCollection);
      if (normalizedCollection.items.length <= 1) return normalizedCollection;

      const remaining = normalizedCollection.items.filter(
        (portfolio) => portfolio.id !== activePortfolio.id
      );
      const nextActiveId =
        remaining.find((portfolio) => portfolio.id === normalizedCollection.activeId)?.id ||
        remaining[0]?.id ||
        DEFAULT_PORTFOLIO_ID;

      return {
        ...normalizedCollection,
        activeId: nextActiveId,
        items: remaining,
      };
    });
    setShowDeletePortfolioConfirm(false);
    setPortfolioView("bought");
    setPortfolioError("");
    setEditingPortfolioId(null);
    setEditingPortfolioNameDraft("");
  };

  const addToPortfolio = async () => {
    const ticker = normalizeTicker(portfolioInput);
    if (!ticker) return;
    const targetPortfolioId = activePortfolioId;
    const quoteSnapshot = portfolioQuotes[ticker] || null;
    const snapshotPrice = Number(quoteSnapshot?.currentPrice);
    const entryId = createPortfolioEntryId(ticker);
    const addedAt = Date.now();

    updatePortfolioEntriesById(targetPortfolioId, (prevEntries) => [
      ...prevEntries,
      {
        id: entryId,
        ticker,
        initialPrice:
          Number.isFinite(snapshotPrice) && snapshotPrice > 0 ? Number(snapshotPrice) : null,
        addedAt,
        status: "bought",
        soldAt: null,
        soldPrice: null,
        lockedReturnPct: null,
        shortNameSnapshot: quoteSnapshot?.shortName || null,
      },
    ]);
    setPortfolioError("");
    setPortfolioInput("");

    try {
      const quote = await fetchPortfolioQuoteForTicker(ticker);
      if (!quote) {
        updatePortfolioEntriesById(targetPortfolioId, (prevEntries) =>
          prevEntries.filter((entry) => entry.id !== entryId)
        );
        setPortfolioError("Ticker non trovato.");
        return;
      }

      setPortfolioQuotes((prev) => ({
        ...prev,
        [ticker]:
          Number(prev?.[ticker]?.updatedAt) > Number(quote?.updatedAt || 0)
            ? prev[ticker]
            : quote,
      }));

      updatePortfolioEntriesById(targetPortfolioId, (prevEntries) => {
        let changed = false;
        const nextEntries = prevEntries.map((entry) => {
          if (entry.id !== entryId) return entry;

          const livePrice =
            Number.isFinite(quote?.currentPrice) && quote.currentPrice > 0
              ? Number(quote.currentPrice)
              : null;
          const nextShortName = quote?.shortName || entry.shortNameSnapshot || null;
          const shouldSetInitialPrice = !(
            Number.isFinite(entry.initialPrice) && entry.initialPrice > 0
          );
          const shouldUpdateShortName = nextShortName !== entry.shortNameSnapshot;

          if (!shouldSetInitialPrice && !shouldUpdateShortName) return entry;
          changed = true;
          return {
            ...entry,
            initialPrice:
              shouldSetInitialPrice && livePrice != null ? Number(livePrice) : entry.initialPrice,
            shortNameSnapshot: shouldUpdateShortName ? nextShortName : entry.shortNameSnapshot,
          };
        });
        return changed ? nextEntries : prevEntries;
      });
    } catch {
      updatePortfolioEntriesById(targetPortfolioId, (prevEntries) =>
        prevEntries.filter((entry) => entry.id !== entryId)
      );
      setPortfolioError("Errore durante l'aggiunta del ticker.");
    }
  };

  const handleSellPortfolioTicker = (entryId) => {
    updatePortfolioEntriesById(activePortfolioId, (prevEntries) => {
      let changed = false;
      const soldAt = Date.now();
      const next = prevEntries.map((entry) => {
        if (entry.id !== entryId || entry.status === "sold") return entry;

        const quote = portfolioQuotes[entry.ticker] || null;
        const currentPrice =
          Number.isFinite(quote?.currentPrice) && quote.currentPrice > 0
            ? Number(quote.currentPrice)
            : null;

        const initialPrice =
          Number.isFinite(entry.initialPrice) && entry.initialPrice > 0
            ? Number(entry.initialPrice)
            : null;
        const resolvedCurrentPrice = currentPrice ?? initialPrice;
        const lockedReturnPct =
          initialPrice != null && resolvedCurrentPrice != null
            ? ((resolvedCurrentPrice - initialPrice) / initialPrice) * 100
            : null;

        changed = true;
        return {
          ...entry,
          status: "sold",
          soldAt,
          soldPrice: resolvedCurrentPrice,
          lockedReturnPct:
            Number.isFinite(lockedReturnPct) ? Number(lockedReturnPct) : null,
          shortNameSnapshot: quote?.shortName || entry.shortNameSnapshot || null,
        };
      });

      return changed ? next : prevEntries;
    });
  };

  const handleDeletePortfolioEntry = (entryId) => {
    updatePortfolioEntriesById(activePortfolioId, (prevEntries) =>
      prevEntries.filter((entry) => entry.id !== entryId)
    );
  };

  const searchTickerForWatchlist = async () => {
    const normalized = normalizeTicker(searchInput);
    if (!normalized) return;

    setSearchError("");
    setSearchResult(null);

    try {
      const response = await fetch(
        apiUrl(`/stock/${encodeURIComponent(normalized)}?priceOnly=true`)
      );

      if (!response.ok) {
        setSearchError("Ticker non trovato");
        return;
      }

      const data = await response.json();
      setSearchResult({
        ticker: normalized,
        info: data.info,
      });
    } catch {
      setSearchError("Errore nella ricerca");
    }
  };

  const handleSelectSearchResult = () => {
    if (!searchResult?.ticker) return;
    addToWatchlist(searchResult.ticker);
    setShowAddBox(false);
    setSearchInput("");
    setSearchResult(null);
    setSearchError("");
  };

  const renderWatchlistCard = (ticker) => {
    const data = watchlistData[ticker];
    const info = data?.info || {};
    const signal = watchlistSignals[ticker];
    const price = info.currentPrice ?? null;
    const change = info.dailyChange ?? null;
    const isUp = Number(change) >= 0;
    const signalTone = signal?.tone || "neutral";
    const signalLabel = signal?.displayLabel || "Calcolo...";
    const signalScore =
      Number.isFinite(signal?.scorePct) ? `${Math.round(signal.scorePct)}%` : "-";

    return (
      <article
        key={ticker}
        className={`watchlist-card ${darkMode ? "dark" : "light"} ${draggedTicker === ticker ? "dragging" : ""} ${
          dragOverTicker === ticker && draggedTicker !== ticker ? "drag-over" : ""
        }`}
        draggable
        onDragStart={(e) => handleDragStart(ticker, e)}
        onDragOver={(e) => handleDragOver(ticker, e)}
        onDrop={(e) => handleDrop(ticker, e)}
        onDragEnd={handleDragEnd}
        onClick={() => {
          if (suppressClickRef.current) return;
          navigate(`/search?query=${encodeURIComponent(ticker)}`);
        }}
      >
        <button
          className="remove-chip"
          onClick={(e) => {
            e.stopPropagation();
            removeFromWatchlist(ticker);
          }}
        >
          Rimuovi
        </button>

        <div className="watchlist-card-head">
          <div className="watchlist-symbol">{ticker}</div>
          <div className={`watchlist-change ${isUp ? "up" : "down"}`}>
            {change != null ? `${isUp ? "+" : ""}${Number(change).toFixed(2)}%` : "N/D"}
          </div>
        </div>

        <div className="watchlist-price">{fmtEuro(price)}</div>
        <div className="watchlist-signal-row">
          <div className={`watchlist-signal-badge ${signalTone}`}>{signalLabel}</div>
          <div className="watchlist-signal-score">{signalScore}</div>
        </div>

        <div className="watchlist-metrics">
          <div className="metric">
            <span>Low</span>
            <strong>{fmtEuro(info.dailyLow)}</strong>
          </div>
          <div className="metric">
            <span>High</span>
            <strong>{fmtEuro(info.dailyHigh)}</strong>
          </div>
        </div>

        <div className="watchlist-open">Apri analisi</div>
      </article>
    );
  };

  const portfolioAnalytics = useMemo(() => {
    const now = Date.now();
    const detailedEntries = portfolioEntries.map((entry, index) => {
      const quote = portfolioQuotes[entry.ticker] || {};
      const status = entry.status === "sold" ? "sold" : "bought";
      const initialPrice =
        Number.isFinite(entry.initialPrice) && entry.initialPrice > 0
          ? Number(entry.initialPrice)
          : null;
      const livePrice =
        Number.isFinite(quote.currentPrice) && quote.currentPrice > 0
          ? Number(quote.currentPrice)
          : null;
      const soldPrice =
        Number.isFinite(entry.soldPrice) && entry.soldPrice > 0
          ? Number(entry.soldPrice)
          : null;
      const lockedReturnPct =
        Number.isFinite(entry.lockedReturnPct) ? Number(entry.lockedReturnPct) : null;
      const currentValue =
        status === "sold"
          ? soldPrice ??
            (initialPrice != null && Number.isFinite(lockedReturnPct)
              ? initialPrice * (1 + lockedReturnPct / 100)
              : initialPrice)
          : livePrice ?? initialPrice;
      const returnPct =
        initialPrice != null && currentValue != null
          ? ((currentValue - initialPrice) / initialPrice) * 100
          : null;
      const category =
        pickBestLabel(
          quote.category,
          quote.sector,
          quote.industry,
          quote.quoteType,
          entry.shortNameSnapshot
        ) || "Altro";
      const addedAt =
        Number.isFinite(entry.addedAt) && entry.addedAt > 0
          ? Number(entry.addedAt)
          : now + index;
      const soldAt =
        Number.isFinite(entry.soldAt) && entry.soldAt > 0
          ? Number(entry.soldAt)
          : status === "sold"
          ? addedAt
          : null;

      return {
        status,
        initialPrice,
        currentValue,
        returnPct,
        category,
        addedAt,
        soldAt,
      };
    });

    const openEntries = detailedEntries.filter((item) => item.status !== "sold");
    const closedEntries = detailedEntries.filter((item) => item.status === "sold");

    const summary = {
      total: computeReturnSummary(detailedEntries),
      open: computeReturnSummary(openEntries),
      closed: computeReturnSummary(closedEntries),
    };

    const categoryCounts = new Map();
    openEntries.forEach((item) => {
      categoryCounts.set(item.category, (categoryCounts.get(item.category) || 0) + 1);
    });
    const pieSlices = Array.from(categoryCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([label, count], index) => ({
        label,
        count,
        color: CHART_COLORS[index % CHART_COLORS.length],
      }));

    const addedAtValues = detailedEntries
      .map((item) => item.addedAt)
      .filter((value) => Number.isFinite(value));
    const startTs = addedAtValues.length > 0 ? Math.min(...addedAtValues) : now;

    const realizedByClose = closedEntries
      .filter(
        (item) =>
          item.initialPrice != null &&
          item.currentValue != null &&
          Number.isFinite(item.soldAt) &&
          item.soldAt > 0
      )
      .sort((a, b) => a.soldAt - b.soldAt);

    const trendPoints = [{ ts: startTs, pct: 0 }];
    if (realizedByClose.length > 0) {
      let realizedInvested = 0;
      let realizedValue = 0;
      realizedByClose.forEach((item) => {
        realizedInvested += item.initialPrice;
        realizedValue += item.currentValue;
        const pct =
          realizedInvested > 0
            ? ((realizedValue - realizedInvested) / realizedInvested) * 100
            : 0;
        trendPoints.push({ ts: item.soldAt, pct });
      });

      const latestRealized = trendPoints[trendPoints.length - 1]?.pct ?? 0;
      const finalPct = Number.isFinite(summary.total.returnPct)
        ? summary.total.returnPct
        : latestRealized;
      trendPoints.push({ ts: now, pct: finalPct });
    } else if (openEntries.length > 0) {
      trendPoints.push({
        ts: now,
        pct: Number.isFinite(summary.open.returnPct) ? summary.open.returnPct : 0,
      });
    } else {
      trendPoints.push({ ts: now, pct: 0 });
    }

    if (trendPoints.length < 2) {
      trendPoints.push({ ts: now + 1, pct: trendPoints[0]?.pct || 0 });
    }

    const formatDate = new Intl.DateTimeFormat("it-IT", {
      day: "2-digit",
      month: "2-digit",
    });
    const trendLabels = trendPoints.map((point, index) => {
      if (index === 0) return "Inizio";
      if (index === trendPoints.length - 1) return "Ora";
      return formatDate.format(new Date(point.ts));
    });
    const trendData = trendPoints.map((point) => Number(point.pct.toFixed(2)));

    return {
      summary,
      pieSlices,
      trendLabels,
      trendData,
      hasPortfolio: detailedEntries.length > 0,
      hasOpen: openEntries.length > 0,
    };
  }, [portfolioEntries, portfolioQuotes]);

  const performanceLineData = useMemo(
    () => ({
      labels: portfolioAnalytics.trendLabels,
      datasets: [
        {
          data: portfolioAnalytics.trendData,
          borderColor: darkMode ? "#7b8cff" : "#4e5dcc",
          backgroundColor: darkMode ? "rgba(123, 140, 255, 0.16)" : "rgba(78, 93, 204, 0.16)",
          fill: true,
          borderWidth: 2,
          tension: 0.32,
          pointRadius: 2.8,
          pointHoverRadius: 4,
        },
      ],
    }),
    [portfolioAnalytics.trendLabels, portfolioAnalytics.trendData, darkMode]
  );

  const performanceLineOptions = useMemo(
    () => ({
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (context) => `Rendimento: ${fmtSignedPct(context.parsed.y)}`,
          },
        },
      },
      scales: {
        x: {
          ticks: { color: darkMode ? "rgba(226,232,240,0.84)" : "rgba(30,41,59,0.78)" },
          grid: { display: false },
        },
        y: {
          ticks: {
            color: darkMode ? "rgba(226,232,240,0.84)" : "rgba(30,41,59,0.78)",
            callback: (value) => `${value}%`,
          },
          grid: {
            color: darkMode ? "rgba(148,163,184,0.22)" : "rgba(148,163,184,0.2)",
          },
        },
      },
    }),
    [darkMode]
  );

  const openCategoryPieData = useMemo(
    () => ({
      labels: portfolioAnalytics.pieSlices.map((slice) => slice.label),
      datasets: [
        {
          data: portfolioAnalytics.pieSlices.map((slice) => slice.count),
          backgroundColor: portfolioAnalytics.pieSlices.map((slice) => slice.color),
          borderColor: darkMode ? "#0f172a" : "#ffffff",
          borderWidth: 2,
          hoverOffset: 8,
        },
      ],
    }),
    [portfolioAnalytics.pieSlices, darkMode]
  );

  const openCategoryPieOptions = useMemo(
    () => ({
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (context) => {
              const value = Number(context.parsed) || 0;
              return `${context.label}: ${value} titoli`;
            },
          },
        },
      },
      cutout: "58%",
    }),
    []
  );

  const portfolioRows = useMemo(() => {
    const items = portfolioEntries.map((entry) => {
      const ticker = entry.ticker;
      const quote = portfolioQuotes[ticker] || {};
      const status = entry.status === "sold" ? "sold" : "bought";
      const currentPrice = Number.isFinite(quote.currentPrice)
        ? quote.currentPrice
        : null;
      const initialPrice =
        Number.isFinite(entry.initialPrice) && entry.initialPrice > 0
          ? Number(entry.initialPrice)
          : null;
      const lockedReturnPct =
        Number.isFinite(entry.lockedReturnPct) ? Number(entry.lockedReturnPct) : null;
      const returnPct =
        status === "sold"
          ? lockedReturnPct
          : initialPrice != null && currentPrice != null
          ? ((currentPrice - initialPrice) / initialPrice) * 100
          : null;
      const tone =
        Number.isFinite(returnPct) && returnPct > 0
          ? "buy"
          : Number.isFinite(returnPct) && returnPct < 0
          ? "sell"
          : "neutral";

      return {
        entryId: entry.id,
        ticker,
        status,
        tone,
        shortName:
          status === "sold"
            ? entry.shortNameSnapshot || quote.shortName || "Posizione portafoglio"
            : quote.shortName || entry.shortNameSnapshot || "Posizione portafoglio",
        initialPrice,
        currentPrice,
        returnPct,
      };
    });

    return items.filter((row) =>
      portfolioView === "sold" ? row.status === "sold" : row.status !== "sold"
    );
  }, [portfolioEntries, portfolioQuotes, portfolioView]);

  return (
    <div className={`home-page ${darkMode ? "dark" : "light"}`}>
      <div className="home-content">
        <section className={`portfolio-overview-card ${darkMode ? "dark" : "light"}`}>
          <div className="portfolio-switcher">
            <div className="portfolio-switcher-head">
              <div className="portfolio-switcher-title">
                <strong>Portafogli</strong>
                <span>La sezione sotto cambia in base al portafoglio selezionato</span>
              </div>
              <div className="portfolio-switcher-actions">
                <span className="portfolio-switcher-hint">
                  Clicca sul nome del portafoglio nella card a destra per rinominare
                </span>
                <button
                  type="button"
                  className="portfolio-delete-btn"
                  onClick={requestDeleteActivePortfolio}
                  disabled={portfolioCollection.items.length <= 1}
                >
                  Elimina portafoglio
                </button>
              </div>
            </div>

            <div className="portfolio-slider-bar">
              {portfolioCollection.items.map((portfolio) => (
                <button
                  key={portfolio.id}
                  type="button"
                  className={portfolio.id === activePortfolioId ? "active" : ""}
                  onClick={() => selectActivePortfolio(portfolio.id)}
                >
                  <span className="portfolio-chip-name">{portfolio.name}</span>
                  <small>
                    {portfolio.entries.length} titoli -{" "}
                    {normalizePortfolioVisibility(portfolio.visibility, "public") === "public"
                      ? "Visibile nella Lista Portafogli"
                      : "Solo tu"}
                  </small>
                </button>
              ))}
            </div>

            {showDeletePortfolioConfirm && activePortfolio && (
              <div className="portfolio-delete-confirm">
                <span>
                  Eliminare <strong>{activePortfolio.name}</strong>? Le sue posizioni verranno
                  rimosse definitivamente.
                </span>
                <div className="portfolio-delete-actions">
                  <button type="button" className="cancel" onClick={cancelDeleteActivePortfolio}>
                    Annulla
                  </button>
                  <button type="button" className="confirm" onClick={confirmDeleteActivePortfolio}>
                    Elimina
                  </button>
                </div>
              </div>
            )}
          </div>

          <div className="portfolio-overview-kpis">
            <article className="overview-kpi">
              <span>Ritorno Portafoglio</span>
              <strong
                className={`${
                  portfolioAnalytics.summary.total.returnPct > 0
                    ? "up"
                    : portfolioAnalytics.summary.total.returnPct < 0
                    ? "down"
                    : ""
                }`}
              >
                {fmtSignedPct(portfolioAnalytics.summary.total.returnPct)}
              </strong>
            </article>
            <article className="overview-kpi">
              <span>Ritorno Aperto</span>
              <strong
                className={`${
                  portfolioAnalytics.summary.open.returnPct > 0
                    ? "up"
                    : portfolioAnalytics.summary.open.returnPct < 0
                    ? "down"
                    : ""
                }`}
              >
                {fmtSignedPct(portfolioAnalytics.summary.open.returnPct)}
              </strong>
            </article>
            <article className="overview-kpi">
              <span>Ritorno Chiuso</span>
              <strong
                className={`${
                  portfolioAnalytics.summary.closed.returnPct > 0
                    ? "up"
                    : portfolioAnalytics.summary.closed.returnPct < 0
                    ? "down"
                    : ""
                }`}
              >
                {fmtSignedPct(portfolioAnalytics.summary.closed.returnPct)}
              </strong>
            </article>
          </div>

          <div className="portfolio-overview-charts">
            <article className="overview-chart-card">
              <div className="overview-chart-head">
                <h4>Andamento Portafoglio</h4>
                <span>chiuso + tratto live aperto</span>
              </div>
              <div className="overview-line-wrap">
                <Line data={performanceLineData} options={performanceLineOptions} />
              </div>
            </article>

            <article className="overview-chart-card pie">
              <div className="overview-chart-head">
                <h4>Categorie Aperte</h4>
                <span>numero titoli per categoria</span>
              </div>
              <div className="overview-pie-wrap">
                {portfolioAnalytics.hasOpen ? (
                  <>
                    <div className="overview-pie-canvas">
                      <Doughnut data={openCategoryPieData} options={openCategoryPieOptions} />
                    </div>
                    <div className="overview-pie-legend">
                      {portfolioAnalytics.pieSlices.map((slice) => (
                        <div key={slice.label} className="overview-pie-item">
                          <span
                            className="overview-pie-dot"
                            style={{ backgroundColor: slice.color }}
                          />
                          <span className="overview-pie-name">{slice.label}</span>
                          <strong>{slice.count}</strong>
                        </div>
                      ))}
                    </div>
                  </>
                ) : (
                  <div className="overview-chart-empty">Nessun titolo aperto da distribuire.</div>
                )}
              </div>
            </article>
          </div>
        </section>

        <div className="home-columns">
          <section className={`watchlist-shell ${darkMode ? "dark" : "light"}`}>
            <div className="watchlist-header">
              <div>
                <div className="watchlist-title-row">
                  <h3>Watchlist</h3>
                  <div className="watchlist-timeframe-control">
                    <span>Previsione</span>
                    <div className="watchlist-timeframe-selector">
                      {WATCHLIST_SIGNAL_TIMEFRAME_OPTIONS.map((option) => (
                        <button
                          key={option.value}
                          type="button"
                          className={
                            watchlistSignalTimeframe === option.value ? "active" : ""
                          }
                          onClick={() => setWatchlistSignalTimeframe(option.value)}
                        >
                          {option.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
                <p>{normalizedWatchlist.length} titoli monitorati - trascina le card per riordinarle</p>
              </div>
              <button className="add-watchlist-btn" onClick={() => setShowAddBox(!showAddBox)}>
                + Aggiungi
              </button>
            </div>

            {watchlistLoading && <div className="watchlist-sync-note">Sincronizzazione in corso...</div>}
            {watchlistError && <div className="watchlist-sync-error">{watchlistError}</div>}

            {showAddBox && (
              <div className={`add-box ${darkMode ? "dark" : "light"}`}>
                <h5>Cerca un titolo da aggiungere</h5>
                <div className="add-box-actions">
                  <input
                    placeholder="Inserisci ticker (es: AAPL)"
                    value={searchInput}
                    onChange={(e) => setSearchInput(e.target.value.toUpperCase())}
                    onKeyDown={(e) => e.key === "Enter" && searchTickerForWatchlist()}
                  />
                  <button className="search-add-btn" onClick={searchTickerForWatchlist}>
                    Cerca
                  </button>
                </div>
                {searchError && <p className="search-error">{searchError}</p>}
                {searchResult && (
                  <div className="search-result" onClick={handleSelectSearchResult}>
                    <strong>{searchResult.ticker}</strong>
                    {searchResult.info?.currentPrice != null && (
                      <span> - prezzo: {fmtEuro(searchResult.info.currentPrice)}</span>
                    )}
                    <small>Clicca per aggiungere alla watchlist</small>
                  </div>
                )}
              </div>
            )}

            {normalizedWatchlist.length === 0 ? (
              <div className="watchlist-empty">
                Nessun ticker aggiunto. Usa "+ Aggiungi" per iniziare.
              </div>
            ) : (
              <div className="watchlist-grid">{normalizedWatchlist.map(renderWatchlistCard)}</div>
            )}
          </section>

          <section className={`portfolio-shell transactions-card ${darkMode ? "dark" : "light"}`}>
            <button
              className="create-portfolio-btn portfolio-create-launch-btn"
              type="button"
              onClick={() => setShowCreatePortfolioCard((prev) => !prev)}
              aria-expanded={showCreatePortfolioCard}
              aria-controls="portfolio-create-card"
            >
              {showCreatePortfolioCard ? "Chiudi nuovo portafoglio" : "Nuovo portafoglio"}
            </button>

            {showCreatePortfolioCard && (
              <div className="portfolio-create-row" id="portfolio-create-card">
                <div className="portfolio-create-controls-card">
                  <div className="portfolio-create-visibility">
                    <div className="portfolio-create-visibility-copy">
                      <span className="portfolio-create-visibility-label">
                        Visibilita nuovo portafoglio
                      </span>
                      <small className="portfolio-create-visibility-hint">
                        Puoi cambiarla anche dopo
                      </small>
                    </div>
                    <div
                      className="portfolio-visibility-selector"
                      role="group"
                      aria-label="Scegli la visibilita del nuovo portafoglio"
                    >
                      <button
                        type="button"
                        className={
                          newPortfolioVisibility === "public"
                            ? "active portfolio-visibility-option"
                            : "portfolio-visibility-option"
                        }
                        onClick={() => setNewPortfolioVisibility("public")}
                        aria-pressed={newPortfolioVisibility === "public"}
                      >
                        <strong>Pubblico</strong>
                        <small>Visibile nella Lista Portafogli</small>
                      </button>
                      <button
                        type="button"
                        className={
                          newPortfolioVisibility === "private"
                            ? "active portfolio-visibility-option"
                            : "portfolio-visibility-option"
                        }
                        onClick={() => setNewPortfolioVisibility("private")}
                        aria-pressed={newPortfolioVisibility === "private"}
                      >
                        <strong>Privato</strong>
                        <small>Solo tu</small>
                      </button>
                    </div>
                  </div>
                  <button className="create-portfolio-btn" type="button" onClick={createPortfolio}>
                    Aggiungi portafoglio
                  </button>
                </div>
              </div>
            )}

            <div className="portfolio-add-row">
              <input
                placeholder="Ticker (es: ENI.MI)"
                value={portfolioInput}
                onChange={(e) => setPortfolioInput(e.target.value.toUpperCase())}
                onKeyDown={(e) => e.key === "Enter" && addToPortfolio()}
              />
              <button className="add-watchlist-btn" onClick={addToPortfolio}>
                + Inserisci
              </button>
            </div>

            {portfolioError && <div className="watchlist-sync-error">{portfolioError}</div>}

            <div className="transactions-head">
              <div className="transactions-head-main">
                {editingPortfolioId === activePortfolioId && activePortfolio ? (
                  <input
                    className="transactions-title-edit-input"
                    value={editingPortfolioNameDraft}
                    autoFocus
                    onChange={(event) => setEditingPortfolioNameDraft(event.target.value)}
                    onBlur={() => commitInlinePortfolioRename(activePortfolioId)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        commitInlinePortfolioRename(activePortfolioId);
                      }
                      if (event.key === "Escape") {
                        event.preventDefault();
                        cancelInlinePortfolioRename();
                      }
                    }}
                  />
                ) : (
                  <button
                    type="button"
                    className="transactions-title-btn"
                    onClick={() =>
                      startInlinePortfolioRename(
                        activePortfolioId,
                        activePortfolio?.name || "Portafoglio"
                      )
                    }
                    title="Clicca per rinominare il portafoglio"
                  >
                    {activePortfolio?.name || "Portafoglio"}
                  </button>
                )}
                <button
                  type="button"
                  className={`portfolio-visibility-toggle-btn ${activePortfolioVisibility}`}
                  onClick={toggleActivePortfolioVisibility}
                  title="Clicca per rendere il portafoglio pubblico o privato"
                  aria-pressed={activePortfolioVisibility === "public"}
                >
                  <strong>{activePortfolioVisibility === "public" ? "Pubblico" : "Privato"}</strong>
                  <small>
                    {activePortfolioVisibility === "public"
                      ? "Visibile nella Lista Portafogli - clicca per renderlo privato"
                      : "Solo tu - clicca per renderlo pubblico"}
                  </small>
                </button>
              </div>
              <div className="transactions-head-actions">
                <button className="transactions-view-btn" type="button">
                  {portfolioCollection.items.length} portafogli
                </button>
              </div>
            </div>

            <div className="transactions-tabs">
              <button
                type="button"
                className={portfolioView === "bought" ? "active" : ""}
                onClick={() => setPortfolioView("bought")}
              >
                Aperto
              </button>
              <button
                type="button"
                className={portfolioView === "sold" ? "active" : ""}
                onClick={() => setPortfolioView("sold")}
              >
                Chiuso
              </button>
            </div>

            {portfolioTickers.length === 0 ? (
              <div className="watchlist-empty">
                Nessun titolo nel portafoglio selezionato. Inserisci un ticker per iniziare.
              </div>
            ) : portfolioRows.length === 0 ? (
              <div className="watchlist-empty">
                Nessuna posizione nella vista selezionata.
              </div>
            ) : (
              <div className="transactions-list">
                {portfolioRows.map((row) => (
                  <article
                    key={row.entryId}
                    className={`transaction-row ${row.tone}`}
                    onClick={() => navigate(`/Previsione?ticker=${encodeURIComponent(row.ticker)}`)}
                  >
                    <div className={`tx-avatar ${row.tone}`}>{row.ticker.charAt(0)}</div>

                    <div className="tx-meta">
                      <strong>{row.ticker}</strong>
                      <span>{row.shortName}</span>
                    </div>

                    <div className="tx-stat">
                      <strong>{fmtEuro(row.initialPrice)}</strong>
                      <span>Prezzo iniziale</span>
                    </div>

                    <div className="tx-stat tx-total">
                      <div className="tx-total-head">
                        <div className="tx-return-block">
                          <strong
                            className={`tx-return ${
                              row.returnPct > 0 ? "up" : row.returnPct < 0 ? "down" : "flat"
                            }`}
                          >
                            {fmtSignedPct(row.returnPct)}
                          </strong>
                          <span className="tx-return-label">
                            {row.status === "sold" ? "Ritorno fissato" : "Ritorno"}
                          </span>
                        </div>
                        {row.status !== "sold" ? (
                          <button
                            type="button"
                            className="tx-sell-btn"
                            onClick={(event) => {
                              event.stopPropagation();
                              handleSellPortfolioTicker(row.entryId);
                            }}
                          >
                            Vendi
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="tx-remove-btn"
                            onClick={(event) => {
                              event.stopPropagation();
                              handleDeletePortfolioEntry(row.entryId);
                            }}
                          >
                            Rimuovi
                          </button>
                        )}
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>
        </div>

        <section className={`saved-social-shell ${darkMode ? "dark" : "light"}`}>
          <div className="saved-social-head">
            <div>
              <h3>Portafogli Salvati</h3>
              <p>
                Qui vedi titoli attuali e movimenti recenti (compra/vendi) dei portafogli che hai
                salvato.
              </p>
            </div>
            <button
              type="button"
              className="saved-social-open-btn"
              onClick={() => navigate("/social")}
            >
              Vai alla Lista Portafogli
            </button>
          </div>

          {savedSocialLoading && savedSocialPortfolios.length === 0 ? (
            <div className="saved-social-status">Caricamento portafogli salvati...</div>
          ) : savedSocialError ? (
            <div className="saved-social-error">{savedSocialError}</div>
          ) : savedSocialPortfolios.length === 0 ? (
            <div className="saved-social-status">
              Nessun portafoglio salvato. Apri Lista Portafogli e salva quelli che vuoi seguire.
            </div>
          ) : (
            <div className="saved-social-grid">
              {savedSocialPortfolios.map((item) => {
                const returnPct = Number(item?.returnPct);
                const returnClass = returnPct > 0 ? "up" : returnPct < 0 ? "down" : "flat";
                const tickers = Array.isArray(item?.tickers) ? item.tickers : [];
                const events = Array.isArray(item?.recentEvents) ? item.recentEvents : [];
                return (
                  <article key={`saved-${item.id}`} className="saved-social-item">
                    <div className="saved-social-item-head">
                      <strong>{item?.name || "Portafoglio"}</strong>
                      <span className={`saved-social-return ${returnClass}`}>
                        {fmtSignedPct(returnPct)}
                      </span>
                    </div>
                    <div className="saved-social-owner">@{item?.ownerUsername || "utente"}</div>
                    <div className="saved-social-meta">
                      <span>{Number(item?.entriesCount) || 0} titoli</span>
                      <span>{Number(item?.likesCount) || 0} like</span>
                    </div>

                    <div className="saved-social-subtitle">Titoli nel portafoglio</div>
                    <div className="saved-social-tickers">
                      {tickers.length ? (
                        tickers.map((ticker) => <span key={`saved-${item.id}-ticker-${ticker}`}>{ticker}</span>)
                      ) : (
                        <small className="saved-social-empty-text">Nessun ticker disponibile</small>
                      )}
                    </div>

                    <div className="saved-social-subtitle">Operazioni recenti</div>
                    <div className="saved-social-events">
                      {events.length ? (
                        events.map((event, index) => {
                          const action = String(event?.action || "").toLowerCase() === "sell" ? "sell" : "buy";
                          const actionLabel = action === "buy" ? "Compra" : "Vendi";
                          const timeLabel = fmtShortDateTime(event?.createdAt);
                          const eventKey =
                            event?.id != null
                              ? `saved-${item.id}-event-${event.id}`
                              : `saved-${item.id}-event-${action}-${event?.ticker || "NA"}-${index}`;
                          return (
                            <div key={eventKey} className={`saved-social-event ${action}`}>
                              <span>{actionLabel} {event?.ticker || "-"}</span>
                              {timeLabel ? <small>{timeLabel}</small> : null}
                            </div>
                          );
                        })
                      ) : (
                        <small className="saved-social-empty-text">Nessuna operazione recente</small>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  );
};

export default Home;


