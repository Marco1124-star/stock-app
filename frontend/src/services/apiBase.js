const trimTrailingSlash = (value) => String(value || "").trim().replace(/\/+$/, "");

export const API_BASE_URL =
  trimTrailingSlash(process.env.REACT_APP_API_URL) || "http://127.0.0.1:5000";

export const apiUrl = (path = "") => {
  const normalizedPath = String(path || "");
  if (!normalizedPath) return API_BASE_URL;
  return normalizedPath.startsWith("/")
    ? `${API_BASE_URL}${normalizedPath}`
    : `${API_BASE_URL}/${normalizedPath}`;
};
