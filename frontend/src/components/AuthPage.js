import React, { useState } from "react";
import { loginUser, registerUser } from "../services/api";
import "./AuthPage.css";

const AuthPage = ({ darkMode, onAuthSuccess }) => {
  const [mode, setMode] = useState("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const resetForm = () => {
    setPassword("");
    setConfirmPassword("");
    setError("");
  };

  const switchMode = (nextMode) => {
    if (nextMode === mode) return;
    setMode(nextMode);
    resetForm();
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!username.trim()) {
      setError("Inserisci uno username.");
      return;
    }
    if (!password) {
      setError("Inserisci una password.");
      return;
    }
    if (mode === "register" && password !== confirmPassword) {
      setError("Le password non coincidono.");
      return;
    }

    setLoading(true);
    setError("");
    try {
      const payload = { username: username.trim(), password };
      const session =
        mode === "register" ? await registerUser(payload) : await loginUser(payload);
      if (typeof onAuthSuccess === "function") {
        onAuthSuccess(session);
      }
    } catch (err) {
      setError(err.message || "Operazione non riuscita.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={`auth-page ${darkMode ? "dark" : "light"}`}>
      <div className="auth-shell">
        <section className="auth-intro">
          <p className="auth-badge">Stock App</p>
          <h1>Accedi alla tua dashboard personale</h1>
          <p>
            Ogni account ha la propria home e la propria watchlist sincronizzata
            automaticamente.
          </p>
          <div className="auth-points">
            <span>Watchlist privata</span>
            <span>Login veloce</span>
            <span>Dati sempre disponibili</span>
          </div>
        </section>

        <section className="auth-card">
          <div className="auth-tabs">
            <button
              type="button"
              className={mode === "login" ? "active" : ""}
              onClick={() => switchMode("login")}
            >
              Login
            </button>
            <button
              type="button"
              className={mode === "register" ? "active" : ""}
              onClick={() => switchMode("register")}
            >
              Registrati
            </button>
          </div>

          <form className="auth-form" onSubmit={handleSubmit}>
            <label>
              Username
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="es. marco_trading"
                autoComplete="username"
                disabled={loading}
              />
            </label>

            <label>
              Password
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Minimo 6 caratteri"
                autoComplete={mode === "login" ? "current-password" : "new-password"}
                disabled={loading}
              />
            </label>

            {mode === "register" && (
              <label>
                Conferma password
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="Ripeti la password"
                  autoComplete="new-password"
                  disabled={loading}
                />
              </label>
            )}

            {error && <div className="auth-error">{error}</div>}

            <button type="submit" className="auth-submit" disabled={loading}>
              {loading
                ? "Attendere..."
                : mode === "register"
                  ? "Crea account"
                  : "Accedi"}
            </button>
          </form>
        </section>
      </div>
    </div>
  );
};

export default AuthPage;
