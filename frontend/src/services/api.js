import axios from "axios";
import { API_BASE_URL } from "./apiBase";

const API_URL = API_BASE_URL;

const authConfig = (token) => ({
  headers: {
    Authorization: `Bearer ${token}`,
  },
});

const errorMessage = (error, fallback) =>
  error?.response?.data?.error || error?.message || fallback;

export const getStock = async (ticker) => {
  try {
    const response = await axios.get(`${API_URL}/stock/${ticker}`);
    return response.data;
  } catch (error) {
    console.error("Errore API:", error);
    return null;
  }
};

export const registerUser = async ({ username, password }) => {
  try {
    const response = await axios.post(`${API_URL}/auth/register`, { username, password });
    return response.data;
  } catch (error) {
    throw new Error(errorMessage(error, "Registrazione non riuscita"));
  }
};

export const loginUser = async ({ username, password }) => {
  try {
    const response = await axios.post(`${API_URL}/auth/login`, { username, password });
    return response.data;
  } catch (error) {
    throw new Error(errorMessage(error, "Login non riuscito"));
  }
};

export const fetchCurrentUser = async (token) => {
  try {
    const response = await axios.get(`${API_URL}/auth/me`, authConfig(token));
    return response.data?.user || null;
  } catch (error) {
    throw new Error(errorMessage(error, "Sessione non valida"));
  }
};

export const logoutUser = async (token) => {
  try {
    await axios.post(`${API_URL}/auth/logout`, {}, authConfig(token));
  } catch (error) {
    throw new Error(errorMessage(error, "Logout non riuscito"));
  }
};

export const updateAccountUsername = async (token, username) => {
  try {
    const response = await axios.patch(`${API_URL}/auth/username`, { username }, authConfig(token));
    return response.data?.user || null;
  } catch (error) {
    const status = error?.response?.status;
    if (status === 404 || status === 405) {
      try {
        const fallback = await axios.put(`${API_URL}/auth/username`, { username }, authConfig(token));
        return fallback.data?.user || null;
      } catch (fallbackError) {
        throw new Error(errorMessage(fallbackError, "Impossibile aggiornare il nome utente"));
      }
    }
    throw new Error(errorMessage(error, "Impossibile aggiornare il nome utente"));
  }
};

export const changeAccountPassword = async (token, currentPassword, newPassword) => {
  try {
    await axios.put(
      `${API_URL}/auth/password`,
      { currentPassword, newPassword },
      authConfig(token)
    );
    return true;
  } catch (error) {
    throw new Error(errorMessage(error, "Impossibile cambiare password"));
  }
};

export const deleteAccount = async (token, currentPassword) => {
  try {
    await axios.delete(`${API_URL}/auth/me`, {
      ...authConfig(token),
      data: { currentPassword },
    });
    return true;
  } catch (error) {
    throw new Error(errorMessage(error, "Impossibile eliminare l'account"));
  }
};

export const fetchUserWatchlist = async (token) => {
  try {
    const response = await axios.get(`${API_URL}/watchlist`, authConfig(token));
    const watchlist = response.data?.watchlist;
    return Array.isArray(watchlist) ? watchlist : [];
  } catch (error) {
    throw new Error(errorMessage(error, "Impossibile caricare la watchlist"));
  }
};

export const saveUserWatchlist = async (token, watchlist) => {
  try {
    const response = await axios.put(
      `${API_URL}/watchlist`,
      { watchlist },
      authConfig(token)
    );
    const updated = response.data?.watchlist;
    return Array.isArray(updated) ? updated : [];
  } catch (error) {
    throw new Error(errorMessage(error, "Impossibile salvare la watchlist"));
  }
};

export const syncSocialPortfolios = async (token, portfolios) => {
  try {
    const response = await axios.put(
      `${API_URL}/social/portfolios`,
      { portfolios },
      authConfig(token)
    );
    const list = response.data?.portfolios;
    return Array.isArray(list) ? list : [];
  } catch (error) {
    throw new Error(errorMessage(error, "Impossibile sincronizzare i portafogli social"));
  }
};

export const fetchSocialFeed = async (token) => {
  try {
    const response = await axios.get(`${API_URL}/social/feed`, authConfig(token));
    const feed = response.data?.feed;
    return Array.isArray(feed) ? feed : [];
  } catch (error) {
    throw new Error(errorMessage(error, "Impossibile caricare il feed social"));
  }
};

export const setSocialPortfolioLike = async (token, portfolioId, liked) => {
  try {
    const response = await axios.post(
      `${API_URL}/social/portfolios/${encodeURIComponent(portfolioId)}/like`,
      { liked },
      authConfig(token)
    );
    return response.data || {};
  } catch (error) {
    throw new Error(errorMessage(error, "Impossibile aggiornare il like"));
  }
};

export const setSocialPortfolioSave = async (token, portfolioId, saved) => {
  try {
    const response = await axios.post(
      `${API_URL}/social/portfolios/${encodeURIComponent(portfolioId)}/save`,
      { saved },
      authConfig(token)
    );
    return response.data || {};
  } catch (error) {
    throw new Error(errorMessage(error, "Impossibile aggiornare il salvataggio"));
  }
};

export const fetchSavedSocialPortfolios = async (token) => {
  try {
    const response = await axios.get(`${API_URL}/social/saved`, authConfig(token));
    const saved = response.data?.saved;
    return Array.isArray(saved) ? saved : [];
  } catch (error) {
    throw new Error(errorMessage(error, "Impossibile caricare i portafogli salvati"));
  }
};
