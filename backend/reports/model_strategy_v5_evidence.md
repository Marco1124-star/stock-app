# Evidenze per la strategia ML v5

Data di analisi: 10 agosto 2026 (Europe/Rome).

## Domanda e decisione

La domanda è come migliorare o sostituire i modelli che stimano il rendimento azionario a 1 mese, 3 mesi e 1 anno. La decisione supportata è quali modelli mantenere, quali ricostruire e quali dati aggiungere prima di una nuova promozione in produzione.

## Evidenza locale usata

- `models/fundamental_return_model_v4_quarterly_candidate.json`: metriche holdout e bootstrap del candidato trimestrale v4.
- `models/fundamental_return_model_v4_annual_candidate.json`: confronto con il candidato annuale v4.
- `models/fundamental_v4_quarterly_dataset.csv`: profilo del dataset point-in-time.
- `notebooks/fundamental_model_v4_audit.ipynb`: notebook di audit riproducibile; il file è strutturalmente valido ma non contiene output Jupyter persistiti.
- `ml/model_governance.py`: gate di promozione correnti.

### Risultati trimestrali verificati

| Orizzonte | MAE modello | MAE zero | Miglioramento relativo | Rank IC cross-sectional | CI 95% Rank IC | Copertura intervallo 80% | Stato |
|---|---:|---:|---:|---:|---:|---:|---|
| 1 mese | 7,5828% | 7,5540% | -0,3820% | -0,0058 | [-0,0652; 0,0429] | 70,75% | non validato |
| 3 mesi | 13,9352% | 13,9480% | +0,0914% | -0,0375 | [-0,1559; 0,0756] | 67,39% | holdout non confermato |
| 1 anno | 28,7716% | 28,9273% | +0,5383% | 0,0607 | [0,0193; 0,0956] | 75,83% | validato per i gate correnti |

Il CI 95% del vantaggio MAE contro zero attraversa lo zero in tutti e tre gli orizzonti. Per 1 anno il CI 95% del Rank IC è invece interamente positivo. Il gate complessivo rifiuta l'artifact perché 1 mese e 3 mesi non superano i controlli, anche se 1 anno supera i gate individuali.

### Profilo del dataset verificato

- 13.488 snapshot, 74 emittenti, 202 date di snapshot e 4.373 filing unici.
- 10.207 righe trimestrali e 3.281 annuali.
- Nessun duplicato su ticker e data di snapshot, nessun problema di valuta mista o unità rilevato.
- Copertura mediana delle feature: 87,10%.
- Label mature: 98,90% a 1 mese, 97,81% a 3 mesi e 92,87% a 1 anno.
- `security_master_verified` è falso per tutte le righe: l'universo corrente manuale non elimina il rischio di survivorship/delisting bias.
- Missingness rilevante: interest coverage 49,28%, R&S/fatturato 43,75%, net debt/EBITDA 35,53%.

## Fonti primarie esterne

- CatBoost, ordered boosting e gestione delle categoriche: https://proceedings.neurips.cc/paper/2018/hash/14491b756b3a51daac41c24863285549-Abstract.html
- XGBoost Learning to Rank / LambdaMART: https://xgboost.readthedocs.io/en/release_3.2.0/tutorials/learning_to_rank.html
- Gu, Kelly e Xiu, ML e caratteristiche azionarie: https://academic.oup.com/rfs/article/33/5/2223/5758276
- Kelly, Pruitt e Su, IPCA: https://asu.elsevierpure.com/en/publications/characteristics-are-covariances-a-unified-model-of-risk-and-retur/
- Benchmark tabellare alberi contro deep learning: https://proceedings.neurips.cc/paper_files/paper/2022/hash/0378c7692da36807bdec87ab043cdadc-Abstract-Datasets_and_Benchmarks.html
- TabPFN per dataset tabellari piccoli/medi: https://www.nature.com/articles/s41586-024-08328-6
- TabM, challenger deep tabellare: https://proceedings.iclr.cc/paper_files/paper/2025/file/c1ba41c694834aeef91ae161711d4939-Paper-Conference.pdf
- NGBoost, previsione probabilistica: https://proceedings.mlr.press/v119/duan20a.html

## Logica della raccomandazione

1. A 1 mese i fondamentali aggiornano troppo lentamente rispetto al target; servono dati di mercato, eventi e revisioni. In assenza di questi dati, il modello deve astenersi.
2. A 3 mesi il vantaggio MAE quasi nullo e il Rank IC negativo indicano che una regressione sul livello del rendimento non sta ordinando bene i titoli. La funzione obiettivo deve diventare cross-sectional ranking, raggruppata per data.
3. A 1 anno il Rank IC positivo e il suo intervallo bootstrap giustificano il mantenimento di XGBoost Huber come champion sperimentale, affiancato da CatBoost, IPCA/Elastic Net e un ensemble OOF.
4. CatBoost è il challenger con miglior rapporto beneficio/costo quando vengono aggiunti settore/SIC e missingness indicators. LightGBM resta utile come diversificazione, ma appartiene alla stessa famiglia e non risolve da solo un target o un dataset inadeguato.
5. TabM e TabPFN sono esperimenti controllati, non sostituti immediati. Il dataset ha 13.488 righe ma soltanto 202 date e righe dipendenti per filing: il numero effettivo di osservazioni indipendenti è molto inferiore.
6. NGBoost o regressione quantile/conformal servono soprattutto a migliorare l'incertezza e l'astensione, non garantiscono un MAE centrale migliore.

## Gate proposti

- 1 e 3 mesi: miglioramento MAE relativo almeno 1-2%, Rank IC medio almeno 0,03 con limite inferiore CI 95% maggiore di zero, spread top-bottom positivo dopo costi e copertura 80% tra 75% e 85%.
- 1 anno: miglioramento MAE relativo maggiore di 1%, Rank IC almeno 0,05 con CI positivo, copertura 80% tra 75% e 85% e diagnostica non-overlap disponibile.
- Tutti gli orizzonti: promozione indipendente, holdout congelato, walk-forward purgato, costi di transazione e turnover inclusi, intervalli valutati anche per ampiezza.

## Scelte di presentazione

È stato inserito un solo grafico di confronto, affiancato alla tabella esatta. Le raccomandazioni sono inferenze tecniche, non garanzie di rendimento futuro.

### Chart map e contratto

- Sezione: risultati correnti.
- Domanda: quanto migliora o peggiora il MAE rispetto alla previsione sempre zero per i candidati annuale e trimestrale?
- Takeaway: il candidato annuale è peggiore della baseline in tutti gli orizzonti; il trimestrale è peggiore a 1 mese e produce vantaggi molto piccoli a 3 mesi e 1 anno.
- Famiglia e tipo: confronto categoriale, barre raggruppate.
- Dati: 6 osservazioni, due candidati per ciascuno dei tre orizzonti; il dataset conserva anche MAE, baseline, Rank IC e stato di validazione.
- Assi: orizzonte sull'asse x; miglioramento MAE relativo percentuale sull'asse y; candidato annuale/trimestrale come unico raggruppamento cromatico.
- Benchmark: linea orizzontale a zero; sopra zero è migliore, sotto zero è peggiore della baseline.
- Palette: due radici non semantiche con legenda; segno comunicato da posizione rispetto allo zero e valori firmati, non da verde/rosso.
- QA: titolo neutro, unità e data nel sottotitolo, valori esatti disponibili nella tabella adiacente, layout full-width e fallback semantico generato dal builder.
