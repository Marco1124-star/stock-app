# Collegare Stock App a GitHub, Railway e Vercel

## GitHub

Mantieni il repository privato. Non inviare database, cache, log, build,
`node_modules` o file `.env`: sono esclusi dal `.gitignore`.

```powershell
git add .
git status
git commit -m "Configure cloud deployment"
git push origin main
```

Controlla sempre `git status` prima del commit: non includere segreti o dati locali.

## Railway: backend Python

1. **New Project** → **Deploy from GitHub repo** → seleziona `stock-app`.
2. Imposta un Volume in `/data`.
3. In **Variables** imposta:

```text
AUTH_DB_PATH=/data/stock_app.db
YFINANCE_CACHE_DIR=/data/yfinance-cache
FLASK_DEBUG=false
CORS_ORIGINS=https://DOMINIO-FRONTEND.vercel.app
```

4. Genera un dominio Railway. `https://DOMINIO/health` deve restituire
   `{"status":"ok"}`.

## Vercel: frontend React

1. **Add New** → **Project** → importa lo stesso repository.
2. Root Directory: `frontend`; Framework Preset: Create React App.
3. In **Environment Variables** inserisci:

```text
REACT_APP_API_URL=https://DOMINIO-BACKEND.up.railway.app
```

4. Fai Deploy. Copia il dominio Vercel nella variabile `CORS_ORIGINS` su Railway e
   lascia che Railway faccia il redeploy.

I tuoi amici apriranno il dominio Vercel: non dovranno installare o scaricare il progetto.
