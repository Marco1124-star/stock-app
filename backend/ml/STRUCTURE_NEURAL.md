# Modello integrato Previsioni — versione attiva V4.2

`structure-neural-v4.2` mantiene i periodi 1D/1W/1M sotto e introduce:

- **Fonti causali:** geometria originale della pagina; andamento, volatilità,
  downside risk, drawdown, volumi e reazioni ai livelli; RSI/MACD/ATR/ADX/CMF
  e SMA20/50/200 dal motore condiviso di Tecnici. Mediane di Stagionalità
  con p05/p95 calcolati solo sugli anni precedenti. Indicatori del bilancio
  dai filing SEC originali, utilizzabili dalla seduta successiva all'accettazione,
  non oltre 550 giorni. Missingness esplicita; nessun fondamentale odierno retrodatato.
- **Mercato:** indice locale scelto dal suffisso/mercato della quotazione quando
  disponibile. Dati strettamente antecedenti alla seduta del titolo, massimo
  quattro giorni di anzianità. Beta e correlazione sono lagged, non sincroni.
  La mappa borsa-indice è un proxy, non una classificazione economica. Mai inferire
  il paese dal fuso orario: anche Milano può avere timezone Europe/Zurich su Yahoo.
  Settore/peer point-in-time NON collegati; disponibilità esposta nella UI.
- **Trend finale:** tre classi, fascia laterale `max(0.1%, 0.25*vol20*sqrt(h))`.
  I rendimenti-obiettivo rettificati non sono winsorizzati; gli eventi estremi
  reali restano nel test. Clipping delle feature stimato solo sul training.
- **Percorso:** prima barriera +/- `vol20*sqrt(h)` toccata o nessuna barriera.
- **Gap:** primo target al 50% fra gli otto candidati più vicini, prima
  dell'invalidazione sul più vicino livello opposto, fissato all'origine.
  Nessuno stop quando manca tale livello. Gap contemporanei o target e stop
  nella stessa candela sono ambigui: esclusi, contati e dichiarati. Le stime
  sono quindi condizionate ai casi ordinabili, non universalmente calibrate.
  I modelli binari per gap e per nessun target NON formano una distribuzione
  congiunta; non si normalizzano artificialmente. Nessuna selezione se più gap
  superano i filtri. Il trend finale non impone il lato del primo gap.
- **Challenger:** MLP16/8, MLP8/4, loro media, logistica e LightGBM opzionale.
  Selezione sullo sviluppo OOF, holdout purgato intatto, calibrazione temporale.
  “MLP di riferimento” confronta la stessa nuova matrice/target: NON è una
  misura del miglioramento rispetto alle vecchie versioni con input differenti.
  Per confermare il primo gap servono inoltre almeno 20 finestre con target reale
  e ranking migliore del semplice gap più vicino. L'accuratezza binaria sui gap
  non raggiunti da sola non qualifica la selezione del target.
- **Rendimento:** regressori quantilici fissi 10/50/90; copertura osservata,
  errore assoluto medio della mediana e finestre di test. Output sperimentale,
  copertura nominale 80% non garantita. Non è un percorso di prezzo simulato.
- **Esecuzione:** POST `/stock/<ticker>/structure-neural/jobs` restituisce subito
  HTTP202; GET `.../jobs/<jobId>` recupera stato/risultato. Un processo figlio
  a thread limitati, coda massima tre richieste, timeout dieci minuti. Annullare
  l'attesa nel browser non interrompe il calcolo; richieste identiche riusano il job.
  Risultati e pesi sono salvati sotto `.ml-cache/structure-jobs`, con cache di
  30 minuti per snapshot identico. Un nuovo snapshot richiede nuovo training:
  il riuso dei pesi per inferenze su snapshot diversi non è ancora implementato.
  I file joblib sono artefatti locali, non devono essere caricati da fonti non fidate.

La versione non usa tutte le card come feature: simulazioni e previsioni di altri
modelli non diventano osservazioni reali; dati settoriali senza storia verificata
restano esclusi. Non promette un errore piccolo o un vantaggio economico.
Indicatori attuali allineati alla data dello snapshot; l'eventuale candela odierna
osservata può alimentare l'inferenza, ma resta esclusa dal training. La risposta
riporta separatamente `featureAsOf` e `trainingAsOf`; intraday non equivale a una
previsione validata specificamente per quell'orario.

Verifica offline: `venv\Scripts\python.exe -m unittest test_structure_neural test_structure_validation test_structure_timeframes test_structure_fusion`.
Smoke live opzionale: `venv\Scripts\python.exe smoke_structure_neural.py --ticker ENI.MI --timeframe 1w`.

Riferimenti: [LightGBM classifier](https://lightgbm.readthedocs.io/en/stable/pythonapi/lightgbm.LGBMClassifier.html),
[calibrazione](https://scikit-learn.org/stable/modules/calibration.html).

### Verifica locale del 1 ottobre 2026

- Suite combinata backend: 56 test passati; test aggiuntivo borsa/fuso passato
  nella suite mirata di 43 test (le due suite si sovrappongono, non vanno sommate).
- Frontend: 25 test passati, compresi polling, abort, errori e risposte obsolete.
- Build di produzione completata; contenuto compilato della card confrontato
  con il sorgente finale. Avvisi preesistenti in QuantitativeAnalysis e sul bundle.
- Prova HTTP finale V4.2 su ENI.MI 1D: job accettato in 0,02 s, completato
  in circa 56 s inclusi i dati della pagina. Richiesta prezzo separata: 0,57 s.
  Sono misure locali puntuali, non una garanzia di latenza.
- Analisi 1W e 1M complete nella versione precedente; il successivo fix V4.2
  corregge la scelta del benchmark italiano. Nessuna prova di accuratezza
  universale: sul caso finale ENI i modelli trend/gap restano sperimentali.
- Verifica grafica in browser non eseguita: strumenti di ispezione non disponibili.

## Contratto dei periodi mantenuto da V3

`structure-neural-v3` distingue tre analisi sincronizzate con il periodo della pagina:

| Periodo | Target | Livelli storici | Filtri predefiniti (forza/distanza/merge) |
| --- | --- | --- | --- |
| 1D | 1 seduta | 120 barre giornaliere, pivot close | 70 / 1 / 0.6 |
| 1W | 5 sedute | 100 barre settimanali, pivot high/low | 80 / 2 / 1.2 |
| 1M (`1mo`) | 21 sedute | 60 barre mensili, pivot high/low | 90 / 4 / 2.5 |

I gap rimangono quelli del grafico **giornaliero**, anche per 1W e 1M.
Ogni osservazione storica ricostruisce le barre dal solo prefisso disponibile,
inclusa la settimana/mese parziale: nessuna chiusura futura entra nei livelli.
Le settimane iniziano lunedì; i mesi il primo giorno. Servono almeno 100 barre
settimanali o 60 mensili prima di ammettere un campione nelle rispettive analisi.
Le osservazioni sono snapshot giornalieri correlati, non mesi indipendenti.
Selezione, calibrazione e test restano separati per periodo con purge in sedute.
La risposta riporta `timeframe` e `horizon`; la UI rifiuta risposte di altri periodi.
Il cambio periodo annulla l'attesa e rimuove i risultati precedenti. Non prova
maggiore accuratezza: serve una verifica fuori campione per ciascun titolo/periodo.

Smoke opzionale su server avviato:
`venv\Scripts\python.exe smoke_structure_neural.py --ticker ENI.MI --timeframe 1w`.

## Archivio V2 e procedura di validazione mantenuta

`structure-neural-v2` conserva gli input della pagina e gli orizzonti 5/21 sedute.
Obiettivo: provare a ridurre gli errori fuori campione e impedire che stime poco
informative vengano presentate come segnali affidabili. Non garantisce errori
piccoli, rendimenti o capacità di prevedere i prezzi.

## Procedura attuale

1. Fino a 2.016 date recenti (circa otto anni di sedute) per ogni titolo. Le
   label e la geometria restano quelle descritte nell'archivio V1 sotto.
2. Ultimo tratto riservato al test finale, con confine e purge invariati rispetto
   a V1. Tre split expanding-window nel solo sviluppo, ogni training label termina
   prima della prima data di validazione. Le date di validazione sono separate
   di h+1 barre anche fra fold; tutti i gap della stessa data rimangono insieme.
3. Candidati fissati a priori: rete originale 16/8 (alpha 5, seed 42), rete
   compatta 8/4 (alpha 10, seed 17), media 50/50 delle due reti. La compatta
   pesa ogni data allo stesso modo, indipendentemente dal numero di gap.
4. Scelta sulla perdita Brier delle predizioni development out-of-fold (OOF),
   prima della calibrazione. Si conserva la configurazione originale se il
   vantaggio di sviluppo è inferiore all'1%. Mai scegliere in base al test finale.
5. Temperature scaling su predizioni OOF, almeno 20 finestre e tutte le classi
   rappresentate. Un parametro T limitato fra 0,75 e 3, minimizzando log loss
   ponderata per data + `0,02 * log(T)^2`. Se il miglioramento dell'obiettivo
   regolarizzato è <0,001 si usa identità. Non è isotonic né una calibrazione
   ottenuta dalle predizioni in-sample. La temperatura è stimata, non una prova
   che le probabilità siano perfettamente calibrate.
6. Refit sullo sviluppo e valutazione una sola volta sul holdout, senza usarne
   gli esiti per scegliere architetture, miscele o temperatura. Confronti con
   frequenze storiche, regressione logistica regolarizzata C=0,1 e vero MLP V1
   addestrato sulla sua finestra originale di 1.512 date. Metriche a peso uguale
   per data: Brier non scalato 0–2, log loss, accuratezza ed errore di classe,
   accuratezza bilanciata. Il Brier non è una percentuale d'errore sul prezzo.
7. Bootstrap circolare a blocchi, 1.000 repliche sulle date non sovrapposte:
   intervallo 95% del Brier e limite superiore unilaterale della differenza di
   perdita. L'incertezza può essere ampia, soprattutto a 21 sedute.
8. Stato «validato» solo con almeno due fold, Brier >2% migliore del prior e
   differenza con limite superiore <0, Brier non peggiore del precedente e della
   regressione logistica, accuratezza non inferiore al prior e miglioramento
   rispetto al prior anche nella metà più recente del test. Il confronto con
   V1/lineare è anche descrittivo: non prova da solo superiorità statistica.
9. Produzione: architettura scelta congelata; nuove predizioni temporali OOF
   per stimare la calibrazione aggiornata, poi refit su tutte le label mature.
   Come nel principio `CalibratedClassifierCV(ensemble=False)`, il calibratore
   vede predizioni OOF e il classificatore finale usa tutti i dati. Il holdout
   valuta la procedura precedente, NON questi nuovi pesi. Sono esposti sia il
   calibratore usato nel test sia quello attualmente usato in produzione.

Il test finale può dimostrare che il nuovo procedimento è peggiore. In quel
caso è sperimentale e non viene promosso a segnale confermato; non si cambia
retroattivamente modello per mostrare il risultato più conveniente sul test.

## Astensione e interpretazione

Le stime restano visibili, ma nessun gap viene confermato con trend incerto:
massima probabilità <60%, differenza fra primi due esiti <15 punti, disaccordo
fra reti >20 punti, o dati fuori dal dominio storico. Il controllo di dominio
segnala due feature oltre [P1 − 0,5*IQR98, P99 + 0,5*IQR98], oppure una nuova
condizione per una feature prima costante. È un euristico, non un intervallo
predittivo. Il disaccordo è una differenza fra reti, non un intervallo 95%.
Un gap richiede inoltre probabilità di riempimento >=60%, lato coerente con il
trend ed entrambi i modelli validati. Soglie prefissate, non ottimizzate sul test.

La copertura riporta quante osservazioni passano i filtri di confidenza/dominio
nel holdout; l'accuratezza selettiva riguarda SOLO quelle osservazioni, non tutte
le previsioni né una strategia di trading. I risultati globali restano esposti.
Un gap raramente chiuso può avere alta accuratezza predicendo sempre «non si
chiude»: per questo sono mostrati riferimento, accuratezza bilanciata e Brier.

Lo storico non è point-in-time certificato; restano revisioni/corporate action,
numero limitato di finestre, dipendenza residua, model selection e consultazioni
multiple su tanti titoli. Non c'è una stima garantita dell'errore futuro.

Verifica riproducibile: `python -m unittest test_structure_neural test_structure_validation`.
Confronto dati pubblici: `python benchmark_structure_precision.py --tickers ENI.MI AAPL`.
La verifica pubblica non ritocca parametri e stampa anche risultati peggiori.

Fonti metodologiche ufficiali:
[Calibrazione OOF e refit](https://scikit-learn.org/1.7/modules/calibration.html),
[MLP e pesi](https://scikit-learn.org/1.7/modules/generated/sklearn.neural_network.MLPClassifier.html),
[selezione e test separati](https://scikit-learn.org/stable/auto_examples/model_selection/plot_nested_cross_validation_iris.html).

## Verifica del 21 settembre 2026

Esito tecnico: 33 test backend e 34 test frontend superati; build CRA completata
(warning preesistenti in QuantitativeAnalysis e dimensione bundle). Nessuna
ispezione visiva nel browser: la verifica dell'interfaccia è automatizzata nel DOM.
Smoke test HTTP sul backend locale aggiornato, ENI.MI / EUR / 5 sedute, con i
livelli reali e 260 barre effettivamente caricate dalla pagina: riuscito,
incluse coerenza snapshot, cache, finitezza JSON e separazione delle date.

Risultati di QUELLA esecuzione, non una promessa di precisione futura:

| Compito ENI, 5 sedute | Brier V2 | Brier V1 | Brier lineare | Errori di classe | Accuratezza bilanciata |
| --- | ---: | ---: | ---: | ---: | ---: |
| Trend | 0,606855 | 0,602144 | 0,610541 | 50,00% | 33,33% |
| Riempimento gap | 0,128710 | 0,123366 | 0,125602 | 8,00% | 50,00% |

Test storico: 42 finestre, 15/09/2025–11/09/2026; 42 osservazioni trend e 269
osservazioni gap, queste ultime aggregate a peso uguale per data. La previsione
attuale usa lo snapshot di pagina del 21/09/2026, potenzialmente intraday.
Entrambi i compiti restano sperimentali. Il basso errore grezzo sui gap deriva
anche dalla prevalenza dell'esito «non riempito»: NON prova un buon riconoscimento
dei gap che verranno raggiunti. Nessun gap candidato confermato.

Le prove esplorative precedenti su ENI e Apple non hanno mostrato un vantaggio
uniforme. I parametri non sono stati ritoccati per far vincere questo test.
Un vantaggio effettivo richiede ulteriore evidenza prospettica; l'aggiornamento
introduce ricerca controllata, diagnostica e astensione, non accuratezza garantita.

# Archivio della versione V1 — non è la configurazione attiva

Versione `structure-neural-v1`. Card indipendente in **Previsioni**, avvio manuale,
grafico **1D**, orizzonti di **5 o 21 sedute**. Non ripristina il vecchio modello
adattivo e non modifica il segnale acquisto/vendita esistente. Nessun ordine.

## Input reali della pagina

La richiesta invia prezzo/data, zone `price/min/max`, gap aperti identificati da
data/tipo/intervallo/riempimento, filtri avanzati e numero di barre effettivamente
caricate. L'inferenza usa questi valori, non livelli alternativi inventati.
I volumi influenzano le zone tramite la formula ADL originale; non entrano RSI,
MACD, oscillatori, stagionalità, fondamentali o valute convertite in USD.

Il motore delle zone è condiviso fra pagina e training: ultime 120 barre, pivot
con due vicini per lato, 50 intervalli di prezzo, ADL cumulativo, percentile,
filtro di distanza e fusione originali. I due pivot più recenti non sono ancora
confermati. Conservare le soglie su ADL nullo/negativo non significa certificarne
la validità economica. Un test indipendente confronta la versione vettorizzata
con il precedente ciclo scalare, anche per i timeframe delle altre pagine.

Gap: intervallo fra candele con separazione strettamente maggiore dell'1%, oppure
tre candele dello stesso colore con separazione fra prima e terza. Riempimento
storico misurato solo DOPO la formazione. A 50% il gap è chiuso come nella pagina;
intervalli senza ampiezza vengono esclusi. Il training ricostruisce gli stati
aperti causalmente e confronta al massimo gli otto gap più vicini.

La finestra dei gap replica il numero di barre **effettivamente** ricevute dalla
pagina, entro cinque anni. Attualmente l'endpoint generale limita l'OHLC
giornaliero a 260 barre: l'etichetta cinque anni della pagina non garantisce
cinque anni realmente caricati. La card esplicita la copertura nel metodo;
questo modulo non amplia silenziosamente i grafici preesistenti.

## Due reti separate

- Trend: MLP 16/8, attivazione tanh, classi ribasso/laterale/rialzo. Target:
  `AdjClose[t+h] / AdjClose[t] - 1`; soglia laterale
  `±0.005 * sqrt(h / 5)`, scelta progettuale, non una soglia universale.
  Nove feature relative: presenza, distanza e ampiezza delle zone più vicine,
  posizione nell'intervallo, numero di supporti e resistenze pertinenti.
- Gap: MLP 16/8 binaria, target riempimento >=50% entro h sedute. Alle nove
  feature aggiunge distanza/ampiezza del gap, riempimento già osservato, età,
  direzione e formazione su tre candele. Le probabilità dei diversi gap sono
  indipendenti: non sommano a 100 e non indicano quale sarà raggiunto per primo.

MLP scikit-learn, alpha=5, massimo 400 iterazioni, seed=42, nessun early stopping
su split casuale. Standardizzazione e clipping 1°/99° percentile sono stimati
solo sul training; i flag discreti mantengono il loro dominio. Label non
winsorizzate. Mancanza di una classe, dati insufficienti o mancata convergenza
producono uno stato esplicito, non stime nulle presentate come reali.

## Validazione temporale e limite delle conclusioni

Storico giornaliero completato fornito dal loader esistente, fino a 20 anni
(fallback dichiarati nel source ID), al massimo 1.512 date di training recenti.
Le barre più vecchie servono a ricostruire i gap. Richiesti almeno 850 prezzi,
volumi utilizzabili e sufficiente campione per ogni classe. Niente imputazione
di Adj Close; finestre con dati non finiti o salti di calendario >7 giorni
sono escluse. La pagina non può essere più vecchia dell'ultima barra usata:
altrimenti il forecast è rifiutato, evitando informazioni successive alla data
di previsione. Una barra corrente intraday è ammessa e segnalata come limite.

Ultima parte dello storico riservata al test: `max(252, 21*(h+1))` barre.
Il training congelato esclude tutte le etichette che raggiungono l'inizio test.
Le date test sono separate di h+1 barre (almeno 20 finestre), i gap della stessa
data non si dividono fra training e test. Non è una walk-forward multifold.

Confronto con probabilità costanti delle classi nel training:

1. Brier multiclasse non scalato, somma degli errori quadratici sulle classi
   (anche per il caso binario: scala 0–2), poi media per data a peso uguale.
2. Riduzione Brier >2% rispetto al riferimento.
3. Estremo superiore unilaterale 95% della differenza di perdita <0, bootstrap
   circolare a blocchi sulle date, 500 repliche, blocco circa radice cubica di N.
4. Accuratezza non inferiore al riferimento maggioritario.

La rete finale viene riaddestrata su tutte le etichette ormai mature SOLO dopo
questa valutazione. I risultati test si riferiscono alla rete congelata, non
a un test indipendente di quella finale. Il test è piccolo, il bootstrap è
approssimativo; non c'è correzione per consultazioni ripetute di molti titoli o
filtri, confronto con tutti i modelli alternativi o validazione esterna.
Le percentuali NON sono calibrate. Non è provato un vantaggio di trading.

La dicitura «Validazione fuori campione superata» riguarda questo confronto
limitato. Un gap candidato richiede entrambe le reti validate, trend direzionale,
gap dal lato coerente e probabilità stimata >=50%. Altrimenti le stime restano
visibili come sperimentali, senza forzare un obiettivo o un acquisto/vendita.

## Tracciabilità e operatività

`POST /stock/<ticker>/structure-neural`: snapshot validato prima dei download;
lock per un solo training simultaneo, errore 429 esplicito; cache di 30 minuti
con versione, ticker richiesto/risolto, digest storico e parametri completi.
Nessun peso viene serializzato su disco. Payload limitato a 300 KB.
Cambio ticker, filtri, dati o orizzonte invalida la card e annulla l'attesa.
Non si analizzano zone/gap ancora in caricamento o appartenenti a un altro titolo.

Fonte Yahoo Finance, valuta locale. OHLC originali per geometria, Adj Close per
target rendimento: dividendi, split e revisioni possono modificare lo storico;
non è un archivio point-in-time certificato. Non si filtrano gap da notizie o
dividendi. Non simula esecuzione, spread, commissioni o slippage.

Verifica offline: `venv\Scripts\python.exe -m unittest test_structure_neural`.
Prova live facoltativa, backend già avviato:
`venv\Scripts\python.exe smoke_structure_neural.py --ticker ENI.MI --horizon 5`.
Fixture sintetiche dei test non sono evidenza di capacità predittiva.

Riferimenti ufficiali:
[MLP](https://scikit-learn.org/stable/modules/neural_networks_supervised.html),
[validazione temporale](https://scikit-learn.org/stable/modules/generated/sklearn.model_selection.TimeSeriesSplit.html),
[calibrazione](https://scikit-learn.org/stable/modules/calibration.html).
