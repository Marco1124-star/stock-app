# Layout telefono

Il design dedicato si attiva fino a **640 CSS px**, tramite `src/Mobile.css`,
importato dopo gli stili delle pagine in `App.js`. Sopra questa larghezza restano
i layout desktop/tablet esistenti. Non viene rilevato il modello del dispositivo.

- Navigazione inferiore solo per le sessioni autenticate, spazio riservato a fondo
  pagina e supporto alle safe area. Il grafico fullscreen resta sopra la navigazione.
- Collegamenti alle analisi in una fila scorrevole, senza nascondere destinazioni.
- Card impilate, controlli touch e campi da 16px per evitare lo zoom automatico iOS.
- Scorrimento locale delle tabelle; nomi lunghi su più righe.
- Barra fullscreen scorrevole in una riga per lasciare spazio al grafico.
- Stessi comportamenti in modalità chiara e scura. Nessuna modifica ai calcoli/API.

## Verifiche ripetibili

Da `frontend`, avviare `npm start` e un Chromium/Edge **isolato**, headless, con
profilo temporaneo e porta di debug `9336`. Non utilizzare il proprio profilo.
Quindi eseguire:

```powershell
node scripts/mobile-layout-smoke.cjs
$env:CI='true'
npm test -- --watchAll=false --runInBand MobileNavigation FinanceSearch StructureNeuralCard PrevisioneNeuralInputs
```

Lo smoke test intercetta le richieste API, anche quelle di scrittura: usa solo
fixture sintetiche e non un account reale. Controlla otto pagine a 320, 390, 640
e 1280px in entrambi i temi, menu/account, grafico fullscreen, tabella bilancio,
Monte Carlo e pagina di accesso. Le sezioni prive di fixture mostrano lo stato
non disponibile: il test non dimostra completezza o correttezza dei dati remoti.

`MOBILE_SCREENSHOTS` può indicare una cartella temporanea per le schermate;
`MOBILE_TEST_ROUTES` limita le pagine (separate da virgole). Questi test non
sostituiscono una prova fisica su Safari/iOS o Chrome/Android con tastiera aperta.

Verifica del 5 ottobre 2026: 64 combinazioni pagina/larghezza/tema senza overflow
del documento né errori runtime, verifiche interattive superate, 36 test React
superati. Revisionate anche schermate renderizzate con Edge headless.

## Accesso da un telefono reale

### Previsioni: design telefono

`PrevisioneMobile.css` contiene gli override dedicati fino a 640px: intestazione
con prezzo e collegamenti alle sezioni, card a larghezza piena, controlli touch,
riepiloghi compatti e grafici estesi alla card. Il desktop e i calcoli restano
invariati. Lo smoke test verifica anche ancore, selettore del modello e larghezza
delle card; non avvia addestramenti né certifica la qualità delle previsioni.

### Configurazione di rete

Il layout responsive non configura la rete. `src/services/apiBase.js` usa ancora
`http://127.0.0.1:5000` in assenza di `REACT_APP_API_URL`: sul telefono questo
indirizzo indica il telefono, non il PC. Per una prova via LAN serve configurare
l'URL del backend raggiungibile dal dispositivo e verificare binding, firewall
e CORS. Questa modifica estetica non apre porte né modifica la sicurezza di rete.
