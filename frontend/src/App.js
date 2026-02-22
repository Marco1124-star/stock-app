import React, { useCallback, useEffect, useRef, useState } from "react";
import { BrowserRouter as Router, Routes, Route, NavLink, Navigate } from "react-router-dom";

import Home from "./components/Home";
import Search from "./components/Search";
import TechnicalsPage from "./components/TechnicalsPage";
import Stagionalita from "./components/Stagionalità";
import Previsione from "./components/Previsione";
import AuthPage from "./components/AuthPage";
import SocialPage from "./components/SocialPage";

import {
  changeAccountPassword,
  deleteAccount,
  fetchCurrentUser,
  fetchUserWatchlist,
  logoutUser,
  saveUserWatchlist,
  updateAccountUsername,
} from "./services/api";

import "bootstrap/dist/css/bootstrap.min.css";
import "./App.css";
import "bootstrap/dist/js/bootstrap.bundle.min.js";

const AUTH_TOKEN_KEY = "authToken";
const AUTH_USER_KEY = "authUser";
const DARK_MODE_STORAGE_KEY = "uiDarkMode";
const PORTFOLIO_STORAGE_PREFIX = "portfolio-tickers:v1:";
const HOME_SNAPSHOT_PREFIX = "home-snapshot:v1:";

const normalizeTicker = (value) =>
  (value || "").trim().toUpperCase().replace(/\s+/g, "");

const uniqueTickers = (list) =>
  (Array.isArray(list) ? list : [])
    .map(normalizeTicker)
    .filter(Boolean)
    .filter((item, idx, arr) => arr.indexOf(item) === idx);

const readStoredUser = () => {
  try {
    return JSON.parse(localStorage.getItem(AUTH_USER_KEY) || "null");
  } catch {
    return null;
  }
};

const readStoredDarkMode = () => {
  try {
    const raw = localStorage.getItem(DARK_MODE_STORAGE_KEY);
    return raw === "1" || raw === "true";
  } catch {
    return false;
  }
};

const _scopeUsername = (value) => String(value || "guest").trim().toLowerCase();

const migrateUserScopedLocalData = (fromUsername, toUsername) => {
  const fromScope = _scopeUsername(fromUsername);
  const toScope = _scopeUsername(toUsername);
  if (!fromScope || !toScope || fromScope === toScope) return;

  const prefixes = [PORTFOLIO_STORAGE_PREFIX, HOME_SNAPSHOT_PREFIX];
  try {
    prefixes.forEach((prefix) => {
      const oldKey = `${prefix}${fromScope}`;
      const nextKey = `${prefix}${toScope}`;
      const existing = localStorage.getItem(oldKey);
      if (existing == null) return;
      if (localStorage.getItem(nextKey) == null) {
        localStorage.setItem(nextKey, existing);
      }
      localStorage.removeItem(oldKey);
    });
  } catch {
    // ignore storage errors
  }
};

function App() {
  const [darkMode, setDarkMode] = useState(() => readStoredDarkMode());
  const [navOpen, setNavOpen] = useState(false);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [token, setToken] = useState(() => localStorage.getItem(AUTH_TOKEN_KEY) || "");
  const [user, setUser] = useState(() => readStoredUser());
  const [authLoading, setAuthLoading] = useState(Boolean(localStorage.getItem(AUTH_TOKEN_KEY)));
  const [watchlist, setWatchlist] = useState([]);
  const [watchlistLoading, setWatchlistLoading] = useState(false);
  const [watchlistError, setWatchlistError] = useState("");
  const [accountMenuNotice, setAccountMenuNotice] = useState(null);
  const [accountDialog, setAccountDialog] = useState(null);
  const accountMenuRef = useRef(null);

  const toggleDarkMode = () => setDarkMode((prev) => !prev);
  const toggleNav = () => setNavOpen((v) => !v);
  const closeNav = () => {
    setNavOpen(false);
    setAccountMenuOpen(false);
  };

  const clearSession = useCallback(() => {
    localStorage.removeItem(AUTH_TOKEN_KEY);
    localStorage.removeItem(AUTH_USER_KEY);
    setToken("");
    setUser(null);
    setWatchlist([]);
    setWatchlistError("");
    setWatchlistLoading(false);
    setNavOpen(false);
    setAccountMenuOpen(false);
  }, []);

  const handleAuthSuccess = useCallback((session) => {
    const nextToken = session?.token;
    const nextUser = session?.user;
    if (!nextToken || !nextUser) return;

    localStorage.setItem(AUTH_TOKEN_KEY, nextToken);
    localStorage.setItem(AUTH_USER_KEY, JSON.stringify(nextUser));
    setToken(nextToken);
    setUser(nextUser);
    setNavOpen(false);
    setAccountMenuOpen(false);
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(DARK_MODE_STORAGE_KEY, darkMode ? "1" : "0");
    } catch {
      // ignore storage errors
    }
  }, [darkMode]);

  useEffect(() => {
    if (!accountMenuOpen) return undefined;

    const handlePointerDown = (event) => {
      if (!accountMenuRef.current?.contains(event.target)) {
        setAccountMenuOpen(false);
      }
    };

    const handleKeyDown = (event) => {
      if (event.key === "Escape") {
        setAccountMenuOpen(false);
      }
    };

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [accountMenuOpen]);

  useEffect(() => {
    if (!navOpen) {
      setAccountMenuOpen(false);
    }
  }, [navOpen]);

  useEffect(() => {
    if (!accountMenuNotice?.message) return undefined;
    const timeoutId = window.setTimeout(() => {
      setAccountMenuNotice(null);
    }, 3200);
    return () => window.clearTimeout(timeoutId);
  }, [accountMenuNotice]);

  useEffect(() => {
    if (!accountDialog) return undefined;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const handleKeyDown = (event) => {
      if (event.key === "Escape") {
        setAccountDialog((prev) => (prev?.loading ? prev : null));
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [accountDialog]);

  useEffect(() => {
    let active = true;

    const bootstrapSession = async () => {
      if (!token) {
        if (active) {
          setAuthLoading(false);
          setUser(null);
          setWatchlist([]);
        }
        return;
      }

      setAuthLoading(true);
      try {
        const [currentUser, remoteWatchlist] = await Promise.all([
          fetchCurrentUser(token),
          fetchUserWatchlist(token),
        ]);
        if (!active) return;
        setUser(currentUser);
        setWatchlist(uniqueTickers(remoteWatchlist));
        localStorage.setItem(AUTH_USER_KEY, JSON.stringify(currentUser));
        setWatchlistError("");
      } catch {
        if (!active) return;
        clearSession();
      } finally {
        if (active) {
          setAuthLoading(false);
        }
      }
    };

    bootstrapSession();
    return () => {
      active = false;
    };
  }, [token, clearSession]);

  const syncWatchlist = useCallback(
    async (nextList) => {
      const normalized = uniqueTickers(nextList);
      setWatchlist(normalized);
      setWatchlistLoading(true);
      setWatchlistError("");

      try {
        const saved = await saveUserWatchlist(token, normalized);
        setWatchlist(uniqueTickers(saved));
        return true;
      } catch (err) {
        setWatchlistError(err.message || "Errore durante il salvataggio della watchlist.");
        return false;
      } finally {
        setWatchlistLoading(false);
      }
    },
    [token]
  );

  const handleAddToWatchlist = useCallback(
    async (ticker) => {
      const normalized = normalizeTicker(ticker);
      if (!normalized) return false;
      if (watchlist.includes(normalized)) return true;
      return syncWatchlist([...watchlist, normalized]);
    },
    [watchlist, syncWatchlist]
  );

  const handleLogout = useCallback(async () => {
    try {
      if (token) {
        await logoutUser(token);
      }
    } catch {
      // ignore logout errors and clear local session
    } finally {
      clearSession();
    }
  }, [token, clearSession]);

  const openAccountDialog = useCallback(
    (kind) => {
      if (!token || !user) return;
      setAccountMenuOpen(false);
      setAccountMenuNotice(null);
      setAccountDialog({
        kind,
        loading: false,
        error: "",
        form: {
          username: user.username || "",
          currentPassword: "",
          newPassword: "",
          confirmPassword: "",
        },
      });
    },
    [token, user]
  );

  const closeAccountDialog = useCallback(() => {
    setAccountDialog((prev) => (prev?.loading ? prev : null));
  }, []);

  const updateAccountDialogField = useCallback((field, value) => {
    setAccountDialog((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        error: "",
        form: {
          ...prev.form,
          [field]: value,
        },
      };
    });
  }, []);

  const submitAccountDialog = useCallback(
    async (event) => {
      event.preventDefault();
      if (!accountDialog || !token || !user) return;

      const { kind, form } = accountDialog;
      const nextUsername = String(form.username || "").trim().replace(/^@+/, "");
      const currentPassword = String(form.currentPassword || "");
      const newPassword = String(form.newPassword || "");
      const confirmPassword = String(form.confirmPassword || "");

      if (kind === "username" && !nextUsername) {
        setAccountDialog((prev) => (prev ? { ...prev, error: "Inserisci un nome utente valido." } : prev));
        return;
      }

      if (kind === "password") {
        if (!currentPassword || !newPassword || !confirmPassword) {
          setAccountDialog((prev) =>
            prev ? { ...prev, error: "Compila tutti i campi della password." } : prev
          );
          return;
        }
        if (newPassword !== confirmPassword) {
          setAccountDialog((prev) =>
            prev ? { ...prev, error: "Le nuove password non coincidono." } : prev
          );
          return;
        }
      }

      if (kind === "delete" && !currentPassword) {
        setAccountDialog((prev) =>
          prev ? { ...prev, error: "Inserisci la password per confermare l'eliminazione." } : prev
        );
        return;
      }

      setAccountDialog((prev) => (prev ? { ...prev, loading: true, error: "" } : prev));

      try {
        if (kind === "username") {
          const updatedUser = await updateAccountUsername(token, nextUsername);
          if (updatedUser?.username) {
            migrateUserScopedLocalData(user.username, updatedUser.username);
            localStorage.setItem(AUTH_USER_KEY, JSON.stringify(updatedUser));
            setUser(updatedUser);
            setAccountMenuNotice({
              type: "success",
              message: `Nome utente aggiornato in @${updatedUser.username}`,
            });
          }
          setAccountDialog(null);
          setAccountMenuOpen(true);
          return;
        }

        if (kind === "password") {
          await changeAccountPassword(token, currentPassword, newPassword);
          setAccountDialog(null);
          setAccountMenuNotice({
            type: "success",
            message: "Password aggiornata con successo.",
          });
          setAccountMenuOpen(true);
          return;
        }

        if (kind === "delete") {
          await deleteAccount(token, currentPassword);
          setAccountDialog(null);
          clearSession();
          return;
        }
      } catch (error) {
        setAccountDialog((prev) =>
          prev
            ? {
                ...prev,
                loading: false,
                error: error?.message || "Operazione non riuscita",
              }
            : prev
        );
      }
    },
    [accountDialog, clearSession, token, user]
  );

  const handleChangeUsername = useCallback(() => {
    openAccountDialog("username");
  }, [openAccountDialog]);

  const handleChangePassword = useCallback(() => {
    openAccountDialog("password");
  }, [openAccountDialog]);

  const handleDeleteAccount = useCallback(() => {
    openAccountDialog("delete");
  }, [openAccountDialog]);

  const isAuthenticated = Boolean(token && user);

  return (
    <Router>
      <nav className={`app-navbar ${darkMode ? "dark" : "light"}`}>
        <div className="nav-inner">
          <NavLink className="brand" to="/" onClick={closeNav}>
            Stock App
          </NavLink>

          <button
            className={`nav-toggle ${navOpen ? "open" : ""}`}
            type="button"
            aria-label="Apri menu"
            aria-expanded={navOpen}
            onClick={toggleNav}
          >
            <span />
            <span />
            <span />
          </button>

          <div className={`nav-content ${navOpen ? "open" : ""}`}>
            {isAuthenticated ? (
              <>
                <div className="nav-links">
                  <NavLink
                    className={({ isActive }) => `nav-link ${isActive ? "active" : ""}`}
                    to="/"
                    onClick={closeNav}
                  >
                    Home
                  </NavLink>
                  <NavLink
                    className={({ isActive }) => `nav-link ${isActive ? "active" : ""}`}
                    to="/search"
                    onClick={closeNav}
                  >
                    Cerca
                  </NavLink>
                  <NavLink
                    className={({ isActive }) => `nav-link ${isActive ? "active" : ""}`}
                    to="/social"
                    onClick={closeNav}
                  >
                    Lista portafogli
                  </NavLink>
                </div>

                <div className="nav-actions nav-actions-auth">
                  <div
                    ref={accountMenuRef}
                    className={`account-menu ${accountMenuOpen ? "open" : ""}`}
                  >
                    <button
                      type="button"
                      className="account-menu-trigger"
                      aria-label="Apri menu account"
                      aria-haspopup="menu"
                      aria-expanded={accountMenuOpen}
                      aria-controls="account-menu-panel"
                      onClick={() => setAccountMenuOpen((prev) => !prev)}
                    >
                      <span className="account-menu-avatar" aria-hidden="true">
                        {(user?.username || "U").slice(0, 1).toUpperCase()}
                      </span>
                    </button>

                    <div className="account-menu-panel" id="account-menu-panel" role="menu">
                      <div className="account-menu-user" role="presentation">
                        @{user.username}
                      </div>
                      {accountMenuNotice?.message && (
                        <div className={`account-menu-notice ${accountMenuNotice.type || "info"}`}>
                          {accountMenuNotice.message}
                        </div>
                      )}
                      <button
                        type="button"
                        role="menuitem"
                        className="account-menu-item"
                        onClick={handleChangeUsername}
                      >
                        Cambia username
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        className="account-menu-item"
                        onClick={handleChangePassword}
                      >
                        Cambia password
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        className="account-menu-item account-menu-item-mode"
                        onClick={toggleDarkMode}
                      >
                        <span>Dark Mode</span>
                        <span className={`account-menu-state ${darkMode ? "on" : "off"}`}>
                          {darkMode ? "On" : "Off"}
                        </span>
                      </button>
                      <div className="account-menu-divider" role="separator" />
                      <button
                        type="button"
                        role="menuitem"
                        className="account-menu-item"
                        onClick={handleLogout}
                      >
                        Logout
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        className="account-menu-item account-menu-item-danger"
                        onClick={handleDeleteAccount}
                      >
                        Elimina account
                      </button>
                    </div>
                  </div>
                </div>
              </>
            ) : (
              <div className="nav-actions nav-actions-auth">
                <span className="auth-user-chip">Accesso richiesto</span>
                <button
                  className={`mode-toggle ${darkMode ? "dark" : "light"}`}
                  onClick={toggleDarkMode}
                >
                  {darkMode ? "Dark Mode" : "Light Mode"}
                </button>
              </div>
            )}
          </div>
        </div>
      </nav>

      <div className={darkMode ? "bg-dark min-vh-100" : "bg-light min-vh-100"}>
        {authLoading ? (
          <div className="status loading">Verifica sessione in corso...</div>
        ) : (
          <Routes>
            {isAuthenticated ? (
              <>
                <Route
                  path="/"
                  element={
                    <Home
                      darkMode={darkMode}
                      user={user}
                      token={token}
                      watchlist={watchlist}
                      onSaveWatchlist={syncWatchlist}
                      watchlistLoading={watchlistLoading}
                      watchlistError={watchlistError}
                    />
                  }
                />
                <Route
                  path="/search"
                  element={
                    <Search
                      darkMode={darkMode}
                      watchlist={watchlist}
                      onAddToWatchlist={handleAddToWatchlist}
                    />
                  }
                />
                <Route path="/technicals" element={<TechnicalsPage darkMode={darkMode} />} />
                <Route path="/Stagionalità" element={<Stagionalita darkMode={darkMode} />} />
                <Route path="/StagionalitÃ " element={<Stagionalita darkMode={darkMode} />} />
                <Route path="/stagionalita" element={<Stagionalita darkMode={darkMode} />} />
                <Route path="/Previsione" element={<Previsione darkMode={darkMode} />} />
                <Route path="/previsione" element={<Previsione darkMode={darkMode} />} />
                <Route
                  path="/social"
                  element={<SocialPage darkMode={darkMode} token={token} user={user} />}
                />
                <Route path="*" element={<Navigate to="/" replace />} />
              </>
            ) : (
              <Route
                path="*"
                element={<AuthPage darkMode={darkMode} onAuthSuccess={handleAuthSuccess} />}
              />
            )}
          </Routes>
        )}
      </div>

      {accountDialog && (
        <div
          className={`account-dialog-backdrop ${darkMode ? "dark" : "light"}`}
          onMouseDown={closeAccountDialog}
        >
          <div
            className={`account-dialog-card ${darkMode ? "dark" : "light"}`}
            role="dialog"
            aria-modal="true"
            aria-labelledby="account-dialog-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="account-dialog-head">
              <div className="account-dialog-title-wrap">
                <h3 id="account-dialog-title">
                  {accountDialog.kind === "username" && "Cambia nome utente"}
                  {accountDialog.kind === "password" && "Cambia password"}
                  {accountDialog.kind === "delete" && "Elimina account"}
                </h3>
                <p>
                  {accountDialog.kind === "username" &&
                    "Aggiorna il tuo username. Puoi usare lettere, numeri, ., -, _ (3-30 caratteri)."}
                  {accountDialog.kind === "password" &&
                    "Inserisci la password attuale e scegli una nuova password sicura."}
                  {accountDialog.kind === "delete" &&
                    "Questa azione elimina account, sessioni e dati associati. Non e reversibile."}
                </p>
              </div>
              <button
                type="button"
                className="account-dialog-close"
                onClick={closeAccountDialog}
                disabled={accountDialog.loading}
                aria-label="Chiudi"
              >
                ×
              </button>
            </div>

            <form className="account-dialog-form" onSubmit={submitAccountDialog}>
              {accountDialog.kind === "username" && (
                <label className="account-dialog-field">
                  <span>Nome utente</span>
                  <div className="account-dialog-input-wrap">
                    <span className="account-dialog-input-prefix">@</span>
                    <input
                      type="text"
                      autoFocus
                      value={accountDialog.form.username || ""}
                      onChange={(event) =>
                        updateAccountDialogField("username", event.target.value.replace(/^@+/, ""))
                      }
                      placeholder="nomeutente"
                      maxLength={30}
                      disabled={accountDialog.loading}
                    />
                  </div>
                </label>
              )}

              {accountDialog.kind === "password" && (
                <>
                  <label className="account-dialog-field">
                    <span>Password attuale</span>
                    <input
                      type="password"
                      autoFocus
                      value={accountDialog.form.currentPassword || ""}
                      onChange={(event) =>
                        updateAccountDialogField("currentPassword", event.target.value)
                      }
                      placeholder="Inserisci la password attuale"
                      disabled={accountDialog.loading}
                    />
                  </label>
                  <label className="account-dialog-field">
                    <span>Nuova password</span>
                    <input
                      type="password"
                      value={accountDialog.form.newPassword || ""}
                      onChange={(event) =>
                        updateAccountDialogField("newPassword", event.target.value)
                      }
                      placeholder="Minimo 6 caratteri"
                      disabled={accountDialog.loading}
                    />
                  </label>
                  <label className="account-dialog-field">
                    <span>Conferma nuova password</span>
                    <input
                      type="password"
                      value={accountDialog.form.confirmPassword || ""}
                      onChange={(event) =>
                        updateAccountDialogField("confirmPassword", event.target.value)
                      }
                      placeholder="Ripeti la nuova password"
                      disabled={accountDialog.loading}
                    />
                  </label>
                </>
              )}

              {accountDialog.kind === "delete" && (
                <>
                  <div className="account-dialog-danger-note">
                    <strong>Attenzione</strong>
                    <span>
                      Stai eliminando definitivamente l&apos;account @{user?.username}. Tutti i dati
                      associati verranno rimossi.
                    </span>
                  </div>
                  <label className="account-dialog-field">
                    <span>Password attuale</span>
                    <input
                      type="password"
                      autoFocus
                      value={accountDialog.form.currentPassword || ""}
                      onChange={(event) =>
                        updateAccountDialogField("currentPassword", event.target.value)
                      }
                      placeholder="Inserisci la password per confermare"
                      disabled={accountDialog.loading}
                    />
                  </label>
                </>
              )}

              {accountDialog.error && <div className="account-dialog-error">{accountDialog.error}</div>}

              <div className="account-dialog-actions">
                <button
                  type="button"
                  className="account-dialog-btn secondary"
                  onClick={closeAccountDialog}
                  disabled={accountDialog.loading}
                >
                  Annulla
                </button>
                <button
                  type="submit"
                  className={`account-dialog-btn ${
                    accountDialog.kind === "delete" ? "danger" : "primary"
                  }`}
                  disabled={accountDialog.loading}
                >
                  {accountDialog.loading
                    ? "Attendi..."
                    : accountDialog.kind === "username"
                    ? "Salva nome utente"
                    : accountDialog.kind === "password"
                    ? "Aggiorna password"
                    : "Elimina account"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </Router>
  );
}

export default App;
