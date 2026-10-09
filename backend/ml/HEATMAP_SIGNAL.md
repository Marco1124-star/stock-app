# Heatmap forward signal — forward-ridge-v1

## Objective and timing

The descriptive correlation/Ridge tables remain separate from the trading
signal. The signal predicts a future adjusted-close return for one security,
using information observable at the latest completed daily close `t`.

- Entry: the close of session `t+1`.
- Exit: close of `t+1+h`, where `h` is 1, 21 or 252 sessions.
- Label: `P[t+1+h] / P[t+1] - 1`.
- Live history excludes the current calendar day's potentially open candle.
- No simulated execution or real orders are submitted.

## Inputs and model

Features include past 1/5/21/63-session stock and own-sector returns,
21/63-session volatility, relative stock-versus-sector momentum, market returns,
other sector returns and a peer basket where available. Only adjusted-price
inputs enter the signal. The API reports an explicit unavailable state if the
stock's adjusted prices or comparable sector history cannot be established.

Features are not correlation coefficients and the descriptive model's
intercept is not interpreted as future alpha. Ridge penalises mean squared
loss with fixed lambda = 1. Each training fold separately learns the usable
columns (at least 80% nonmissing), imputation medians, 1st/99th percentile
clipping limits, means and scales. No hyperparameter search is performed.

## Evaluation

Four expanding temporal folds train on at least 252 completed labels. Every
training label must mature strictly before the first validation origin.
The live fit uses only labels already observed by the snapshot date.
Validation predictions are subsequently thinned into nonoverlapping holding
periods. Metrics include RMSE, directional accuracy and errors relative to
both a training-period mean-return prediction and a zero-return prediction.
Fold label endpoints are included in the API audit data.

Minimum validation windows: 60 daily, 12 monthly, 8 annual. Five years of
prices usually cannot validate an annual recommendation; the directional
estimate can remain visible with `insufficient_validation` / “Da validare”.

## Decision policy

All thresholds below are disclosed design choices, not universal financial
rules or empirically optimised trading thresholds.

- Buy/sell requires lower out-of-sample RMSE than both reference forecasts,
  directional accuracy at least as high as the training-mean reference and
  50%, and at least 75% of earlier fitted models agreeing with the current
  forecast's sign when supplied today's features.
- The expected move must exceed total round-trip cost plus 0.10 × OOS RMSE.
- Empirical residual support for a move beyond costs must be at least 55%.
- Otherwise the result is “Attendi”; missing or insufficient evidence is a
  separate unavailable / to-be-validated state, never an implicit “Neutro”.

The cost control is in basis points: 30 bps = 0.30% total buy-and-resell costs.
Residual quantiles provide an empirical 80% prediction range, not a guaranteed
coverage interval or calibrated probability. “Sell” means reduce/exit an
existing position, not initiate a simulated short.

## Limitations and reproduction

### International listings and currency (API cache v5-fx)

The target need not occur in the heatmap. Sector and quote currency are
resolved from company/quote metadata, never from financial-statement currency.
The exact listing ticker is retained. GBp/GBX, ZAc and ILA price units are
normalised to GBP, ZAR and ILS; returns remain in the target's local currency.

US sector ETFs, SPY and the US-scanner peers are converted to that currency
before returns are calculated: `P_local(t) = P_USD(t) * FX_local_per_USD(t)`.
The direct Yahoo FX pair is tried first, then the reciprocal of the inverse
pair. Missing or invalid FX observations are not filled. Unknown quote
currency or missing FX blocks both the signal and mixed-currency descriptive
comparisons. The API/UI expose currency, FX pair, date and limitations.
Chart fallback timestamps are converted from UTC to the exchange timezone
before extracting the session date. This preserves London FX dates across
daylight-saving changes instead of mislabelling Monday bars as Sunday.

For off-heatmap or non-USD listings, forecasting features use only foreign
prices/FX dated strictly before the target date, with maximum age four
calendar days. This conservative availability alignment avoids using a later
US close to predict at an earlier foreign close. The target's actual trading
calendar defines forecast horizons; earlier available foreign observations
can repeat during foreign-market holidays. Missing prior observations stay
missing. Descriptive correlations remain retrospective daily-date comparisons,
not synchronised intraday correlations, and can be affected by closing times.

These are US-sector proxies expressed in local currency, not local-sector
benchmarks or a global peer universe. A heatmap outage does not prevent an
otherwise valid ETF-factor model. Absent sector, FX, adjusted-price or
validation data still produces explicit unavailable/to-be-validated results.

The universe is the current heatmap, with up to 24 same-sector peers selected
by current market capitalisation. It is not a historical security master and
is subject to survivorship/selection bias. Nonoverlapping outcomes can still
be serially dependent. A successful validation does not establish statistical
significance of the economic edge or guarantee future profitability.

Run from the project root:

`python -m unittest backend.test_heatmap_forward_signal backend.test_heatmap_signal_api backend.test_heatmap_currency -v`

The tests cover time alignment, missing/stale/incompatible inputs, purged
folds, both buy and sell on synthetic predictable data, noise, transaction
cost effects, annual sample limits and API/cache integration.

Method references:
[time-ordered validation](https://scikit-learn.org/stable/modules/generated/sklearn.model_selection.TimeSeriesSplit.html),
[preprocessing and leakage](https://scikit-learn.org/stable/common_pitfalls.html).
