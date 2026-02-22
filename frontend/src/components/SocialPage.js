import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  fetchSocialFeed,
  setSocialPortfolioLike,
  setSocialPortfolioSave,
} from "../services/api";
import "./SocialPage.css";

const fmtSignedPct = (value) => {
  const num = Number(value);
  if (!Number.isFinite(num) || Math.abs(num) < 0.005) return "0%";
  return `${num > 0 ? "+" : ""}${num.toFixed(2)}%`;
};

const getReturnClass = (value) => {
  const num = Number(value);
  if (!Number.isFinite(num) || num === 0) return "flat";
  return num > 0 ? "up" : "down";
};

const SocialPage = ({ darkMode, token, user }) => {
  const [feed, setFeed] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [busyLikes, setBusyLikes] = useState({});
  const [busySaves, setBusySaves] = useState({});

  const refreshFeed = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setError("");
    try {
      const list = await fetchSocialFeed(token);
      setFeed(Array.isArray(list) ? list : []);
    } catch (err) {
      setError(err.message || "Errore nel caricamento della lista portafogli.");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    if (!token) {
      setFeed([]);
      setError("");
      return undefined;
    }

    refreshFeed();
    const interval = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      refreshFeed();
    }, 45000);

    return () => clearInterval(interval);
  }, [token, refreshFeed]);

  const updateReaction = useCallback((portfolioId, payload) => {
    setFeed((prev) =>
      prev.map((item) => {
        if (item.id !== portfolioId) return item;
        return {
          ...item,
          viewerLiked:
            typeof payload?.liked === "boolean" ? payload.liked : Boolean(item.viewerLiked),
          viewerSaved:
            typeof payload?.saved === "boolean" ? payload.saved : Boolean(item.viewerSaved),
          likesCount: Number.isFinite(Number(payload?.likesCount))
            ? Number(payload.likesCount)
            : item.likesCount,
          savesCount: Number.isFinite(Number(payload?.savesCount))
            ? Number(payload.savesCount)
            : item.savesCount,
        };
      })
    );
  }, []);

  const handleLike = useCallback(
    async (item) => {
      if (!token || busyLikes[item.id]) return;
      setBusyLikes((prev) => ({ ...prev, [item.id]: true }));
      try {
        const payload = await setSocialPortfolioLike(token, item.id, !item.viewerLiked);
        updateReaction(item.id, payload);
      } catch (err) {
        setError(err.message || "Errore durante l'aggiornamento del like.");
      } finally {
        setBusyLikes((prev) => ({ ...prev, [item.id]: false }));
      }
    },
    [token, busyLikes, updateReaction]
  );

  const handleSave = useCallback(
    async (item) => {
      if (!token || busySaves[item.id]) return;
      setBusySaves((prev) => ({ ...prev, [item.id]: true }));
      try {
        const payload = await setSocialPortfolioSave(token, item.id, !item.viewerSaved);
        updateReaction(item.id, payload);
      } catch (err) {
        setError(err.message || "Errore durante il salvataggio del portafoglio.");
      } finally {
        setBusySaves((prev) => ({ ...prev, [item.id]: false }));
      }
    },
    [token, busySaves, updateReaction]
  );

  const totalPosts = useMemo(() => feed.length, [feed.length]);

  const leaderboard = useMemo(() => {
    return [...feed]
      .sort((a, b) => {
        const aReturn = Number(a?.returnPct);
        const bReturn = Number(b?.returnPct);
        const safeA = Number.isFinite(aReturn) ? aReturn : 0;
        const safeB = Number.isFinite(bReturn) ? bReturn : 0;
        if (safeB !== safeA) return safeB - safeA;

        const aUser = String(a?.ownerUsername || "");
        const bUser = String(b?.ownerUsername || "");
        return aUser.localeCompare(bUser);
      })
      .slice(0, 12);
  }, [feed]);

  return (
    <div className={`social-page ${darkMode ? "dark" : "light"}`}>
      <div className="social-content">
        <section className="social-hero">
          <h1>Lista portafogli</h1>
          <p>
            Vedi i portafogli pubblicati dagli utenti, metti like e salva quelli che vuoi
            monitorare in Home.
          </p>
          <div className="social-hero-meta">
            <span>{totalPosts} portafogli pubblici</span>
            <span>{user?.username ? `Connesso come @${user.username}` : "Utente anonimo"}</span>
          </div>
        </section>

        {error && <div className="social-error">{error}</div>}

        {loading && feed.length === 0 ? (
          <div className="social-status">Caricamento lista portafogli...</div>
        ) : feed.length === 0 ? (
          <div className="social-status">
            Nessun portafoglio pubblicato al momento. Aggiungi titoli in Home per comparire qui.
          </div>
        ) : (
          <section className="social-layout">
            <div className="social-feed-column">
              <div className="social-grid">
                {feed.map((item) => {
                  const returnPct = Number(item.returnPct);
                  const returnClass = getReturnClass(returnPct);
                  const isMine = item.ownerUsername === user?.username;

                  return (
                    <article key={item.id} className="social-post">
                      <div className="social-post-top">
                        <div className="social-user">
                          <div className="social-avatar">
                            {(item.ownerUsername || "?").charAt(0).toUpperCase()}
                          </div>
                          <div className="social-user-text">
                            <strong>@{item.ownerUsername}</strong>
                            <span>{isMine ? "Il tuo portafoglio" : "Portafoglio pubblico"}</span>
                          </div>
                        </div>
                        <div className={`social-return-chip ${returnClass}`}>
                          {fmtSignedPct(returnPct)}
                        </div>
                      </div>

                      <h3>{item.name || "Portafoglio"}</h3>

                      <div className="social-stats">
                        <div>
                          <span>Titoli</span>
                          <strong>{item.entriesCount || 0}</strong>
                        </div>
                        <div>
                          <span>Aperti</span>
                          <strong>{item.openCount || 0}</strong>
                        </div>
                        <div>
                          <span>Chiusi</span>
                          <strong>{item.closedCount || 0}</strong>
                        </div>
                      </div>

                      <div className="social-tickers">
                        {(item.tickers || []).length ? (
                          item.tickers.map((ticker) => (
                            <span key={`${item.id}-${ticker}`}>{ticker}</span>
                          ))
                        ) : (
                          <small>Nessun ticker disponibile</small>
                        )}
                      </div>

                      <div className="social-actions">
                        <button
                          type="button"
                          className={`social-action like ${item.viewerLiked ? "active" : ""}`}
                          disabled={Boolean(busyLikes[item.id])}
                          onClick={() => handleLike(item)}
                        >
                          {item.viewerLiked ? "Liked" : "Like"} - {item.likesCount || 0}
                        </button>
                        <button
                          type="button"
                          className={`social-action save ${item.viewerSaved ? "active" : ""}`}
                          disabled={Boolean(busySaves[item.id])}
                          onClick={() => handleSave(item)}
                        >
                          {item.viewerSaved ? "Salvato" : "Salva"} - {item.savesCount || 0}
                        </button>
                      </div>
                    </article>
                  );
                })}
              </div>
            </div>

            <aside className="social-leaderboard" aria-label="Classifica portafogli">
              <div className="social-leaderboard-head">
                <h2>Classifica portafogli</h2>
                <span>Top {leaderboard.length}</span>
              </div>
              <p className="social-leaderboard-sub">
                Posizione, utente, rendimento e salvataggio rapido.
              </p>

              <div className="social-leaderboard-list">
                {leaderboard.map((item, index) => {
                  const returnPct = Number(item.returnPct);
                  const returnClass = getReturnClass(returnPct);
                  return (
                    <div key={`rank-${item.id}`} className="social-rank-row">
                      <div className={`social-rank-pos ${index < 3 ? "top" : ""}`}>
                        #{index + 1}
                      </div>
                      <div className="social-rank-main">
                        <strong>@{item.ownerUsername}</strong>
                        <span>{item.name || "Portafoglio"}</span>
                      </div>
                      <div className={`social-rank-return ${returnClass}`}>
                        {fmtSignedPct(returnPct)}
                      </div>
                      <button
                        type="button"
                        className={`social-rank-save ${item.viewerSaved ? "active" : ""}`}
                        disabled={Boolean(busySaves[item.id])}
                        onClick={() => handleSave(item)}
                      >
                        {item.viewerSaved ? "Salvato" : "Salva"}
                      </button>
                    </div>
                  );
                })}
              </div>
            </aside>
          </section>
        )}
      </div>
    </div>
  );
};

export default SocialPage;
