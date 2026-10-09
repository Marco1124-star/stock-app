/* Run against a local app and isolated headless Chromium on port 9336.
 * ALL non-static requests (including POSTs) are fulfilled with fixtures here.
 * Never uses real credentials or mutates a backend. Screenshots are optional.
 */
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const origin = process.env.MOBILE_TEST_ORIGIN || 'http://localhost:3000';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const history = Array.from({ length: 1300 }, (_, i) => {
  const date = new Date(Date.UTC(2021, 9, 1) + i * 86400000 * 1.4).toISOString().slice(0, 10);
  const close = 100 + i * .04 + Math.sin(i * .7) * 3;
  return { date, open: close - .5, high: close + 2, low: close - 2, close, volume: 1200000 + i * 150 };
});
const stock = { symbol: 'TEST', info: { symbol: 'TEST', shortName: 'Società dimostrativa con nome lungo', currentPrice: 152, dailyLow: 149.35, dailyHigh: 154.2, currency: 'EUR', sector: 'Technology', dailyChange: 1.2 }, ohlc: history, performance: {}, risk: { level: 'N/D', metrics: {} } };
function fixture(url) {
  const p = new URL(url).pathname;
  if (p.endsWith('/financials')) {
    const periods = Array.from({ length: 10 }, (_, i) => ({ key: `${2025 - i}-12-31`, label: `${2025 - i}-12-31` }));
    const rows = [['TotalRevenue', 'Ricavi totali', 1000000], ['GrossProfit', 'Utile lordo', 450000], ['OperatingIncome', 'Risultato operativo', 240000], ['NetIncome', 'Utile netto', 180000]].map(([key, label, value]) => ({ key, label, values: Object.fromEntries(periods.map((p, i) => [p.key, value / (1 + .05 * i)])) }));
    return { symbol: 'TEST', currency: 'EUR', quote: stock.info, statements: { income: { periods, rows }, balance: { periods, rows: [] }, cashflow: { periods, rows: [] } } };
  }
  if (p.endsWith('/auth/me')) return { user: { id: 'mobile-fixture', username: 'mobile_test' } };
  if (p.endsWith('/watchlist')) return { watchlist: ['TEST'] };
  if (p.includes('/social/')) return { portfolios: [], feed: [], saved: [] };
  if (p.includes('/search/suggestions')) return { results: [{ symbol: 'TEST', shortname: stock.info.shortName, exchange: 'MIL', quoteType: 'EQUITY' }] };
  if (p.endsWith('/history')) return { history, symbol: 'TEST', currency: 'EUR' };
  if (p.endsWith('/technicals')) return { oscillatorsSummary: [{ name: 'Relative Strength Index (14)', value: 55, action: 'Neutral' }], movingAveragesSummary: [{ name: 'Media mobile semplice (200)', value: 130, action: 'Buy' }] };
  if (p.endsWith('/supply_demand')) return { current_price: 152, zones: { support: [{ price: 145, min: 144, max: 146, strength: 65 }], resistance: [{ price: 160, min: 159, max: 161, strength: 70 }] }, market_state: { state: 'IN_NONE', strength: 0 } };
  if (p.endsWith('/live_price')) return { price: 152 };
  if (p.includes('/seasonality/')) return { months: ['Gen','Feb','Mar','Apr','Mag','Giu','Lug','Ago','Set','Ott','Nov','Dic'], years: [2022, 2023, 2024, 2025], seasonalCurveByYear: Object.fromEntries([2022, 2023, 2024, 2025].map(y => [y, Array.from({ length: 12 }, (_, m) => Math.sin(m + y) * 3)])) };
  if (/\/stock\/[^/]+$/.test(p)) return stock;
  return null; // explicit unavailable-data state for non-fixtured services
}

(async () => {
  const targets = await (await fetch('http://127.0.0.1:9336/json/list')).json();
  const target = targets.find(t => t.type === 'page');
  assert(target, 'Start an isolated headless Chromium first');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(resolve => ws.once('open', resolve));
  let id = 0;
  const pending = new Map();
  const errors = [];
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const key = ++id;
    const timeout = setTimeout(() => { pending.delete(key); reject(new Error(`CDP timeout: ${method}`)); }, 30000);
    pending.set(key, { resolve: value => { clearTimeout(timeout); resolve(value); }, reject });
    ws.send(JSON.stringify({ id: key, method, params }));
  });
  ws.on('message', async raw => {
    const msg = JSON.parse(raw);
    if (msg.id) {
      const request = pending.get(msg.id); pending.delete(msg.id);
      if (request) msg.error ? request.reject(new Error(msg.error.message)) : request.resolve(msg.result);
    }
    if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.text + ': ' + msg.params.exceptionDetails.exception?.description);
    if (msg.method === 'Fetch.requestPaused') {
      const { requestId, request } = msg.params;
      const u = new URL(request.url);
      const staticRequest = u.origin === origin && !u.pathname.startsWith('/api/') && request.method === 'GET' && !/^\/(stock|auth|watchlist|seasonality|social\/feed)/.test(u.pathname);
      if (staticRequest) await call('Fetch.continueRequest', { requestId });
      else {
        const data = fixture(request.url);
        await call('Fetch.fulfillRequest', { requestId, responseCode: request.method === 'OPTIONS' ? 204 : data ? 200 : 503,
          responseHeaders: [{ name: 'Content-Type', value: 'application/json' }, { name: 'Access-Control-Allow-Origin', value: origin }, { name: 'Access-Control-Allow-Headers', value: '*' }, { name: 'Access-Control-Allow-Methods', value: 'GET,POST,PUT,DELETE,OPTIONS' }],
          body: Buffer.from(JSON.stringify(data || { error: 'Servizio non incluso nella fixture mobile' })).toString('base64') });
      }
    }
  });
  const evaluate = async expression => (await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value;
  await call('Page.enable'); await call('Runtime.enable');
  await call('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
  // Isolated test session only: every API request is intercepted above.
  const routes = process.env.MOBILE_TEST_ROUTES?.split(',') || ['/', '/search?query=TEST', '/technicals?ticker=TEST', '/stagionalita?ticker=TEST', '/previsione?ticker=TEST', '/bilancio?ticker=TEST', '/quantitativi?ticker=TEST', '/social'];
  const results = [];
  for (const dark of [false, true]) {
    const source = `localStorage.setItem('authToken','isolated-layout-fixture');localStorage.setItem('uiDarkMode','${dark ? '1' : '0'}');`;
    const { identifier } = await call('Page.addScriptToEvaluateOnNewDocument', { source });
    for (const route of routes) {
      await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
      await call('Page.navigate', { url: origin + route });
      for (let i = 0; i < 40; i++) {
        if (await evaluate(`!!document.querySelector('.mobile-navigation') && !document.querySelector('.page-loading')`)) break;
        await sleep(250);
      }
      await sleep(700);
      for (const width of [320, 390, 640, 1280]) {
        await call('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: true });
        await sleep(600); // Allow chart resize/animation to finish before measuring overflow.
        const result = await evaluate(`(() => {
          const nav = document.querySelector('.mobile-navigation');
          const visible = el => { const s = getComputedStyle(el); return s.visibility !== 'hidden' && s.display !== 'none' && el.getClientRects().length; };
          return { viewport: innerWidth, width: document.documentElement.scrollWidth,
            nav: nav && getComputedStyle(nav).display !== 'none',
            page: document.querySelector('.app-content > *')?.className,
            overflowing: [...document.querySelectorAll('.app-content *')].filter(el => {
              if (!visible(el) || el.getBoundingClientRect().right <= ${width} + 1) return false;
              for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) if (['auto','scroll','hidden','clip'].includes(getComputedStyle(p).overflowX)) return false;
              return true;
            }).slice(0, 8).map(el => el.tagName + '.' + el.className) };
        })()`);
        results.push({ route, dark, requestedWidth: width, ...result });
        assert(await evaluate(`getComputedStyle(document.querySelector('.app-navbar')).display ${width <= 640 ? '===' : '!=='} 'none'`), 'Top navigation must be hidden only on phones');
        if (route.startsWith('/previsione')) {
          assert(await evaluate(`getComputedStyle(document.querySelector('.previsione-mobile-hero')).display ${width <= 640 ? '!==' : '==='} 'none'`), 'Forecast redesign must only appear on phones');
          assert(await evaluate(`[...document.querySelectorAll('.previsione-mobile-sections a')].every(a => !!document.querySelector(a.getAttribute('href')))`), 'Every forecast shortcut must target an existing section');
          if (width <= 640) {
            assert(await evaluate(`[...document.querySelector('.cards-row').children].every(el => Math.abs(el.getBoundingClientRect().width - el.parentElement.getBoundingClientRect().width) < 2)`), 'Forecast context cards must fill the mobile column');
            assert(await evaluate(`getComputedStyle(document.querySelector('.timeframe-selector button.active')).backgroundColor !== 'rgb(219, 231, 255)'`), 'Selected mobile controls must not use the low-contrast legacy blue');
          }
        }
        if (width <= 640) assert(await evaluate(`(() => {
          const shell = document.querySelector('.app-content--mobile-nav');
          return parseFloat(getComputedStyle(shell).paddingBottom) === 0 && parseFloat(getComputedStyle(shell.firstElementChild).paddingBottom) >= 96;
        })()`), 'Floating-nav clearance must use the page background, not an outer grey strip');
        console.log(JSON.stringify(results[results.length - 1]));
        if (route === '/') {
          assert(await evaluate(`getComputedStyle(document.querySelector('.home-dashboard-hero')).display ${width <= 640 ? '===' : '!=='} 'none'`), 'Personal dashboard card must be hidden only on phones');
          const card = await evaluate(`(() => {
            const card = document.querySelector('.watchlist-card');
            const remove = card?.querySelector('.remove-chip');
            const open = card?.querySelector('.watchlist-open');
            return card && { height: card.getBoundingClientRect().height, width: card.getBoundingClientRect().width,
              removeWidth: remove.getBoundingClientRect().width, removeHeight: remove.getBoundingClientRect().height,
              openHeight: open.getBoundingClientRect().height, metrics: card.querySelectorAll('.metric').length };
          })()`);
          assert(card && card.metrics === 2, 'Watchlist must preserve both price metrics');
          if (width <= 640) assert(card.height < 190 && card.removeWidth >= 44 && card.removeHeight >= 44 && card.openHeight >= 44, 'Compact card must retain accessible touch targets');
          console.log(JSON.stringify({ watchlist: card, width, dark }));
        }
        if (process.env.MOBILE_DEBUG && width === 390) console.log(await evaluate(`JSON.stringify([...document.querySelectorAll('.previsione-nav-cards .card-title, .financial-identity, .financial-identity > div')].map(el => { const s = getComputedStyle(el), r = el.getBoundingClientRect(); return { text: el.textContent, display: s.display, color: s.color, position: s.position, top: r.top, left: r.left, width: r.width, height: r.height, opacity: s.opacity, visibility: s.visibility, flex: s.flex }; }))`));
        if (process.env.MOBILE_SCREENSHOTS && width === 390) {
          fs.mkdirSync(process.env.MOBILE_SCREENSHOTS, { recursive: true });
          const shot = await call('Page.captureScreenshot', { format: 'png' });
          fs.writeFileSync(path.join(process.env.MOBILE_SCREENSHOTS, `${route.split('?')[0].replace(/\//g, '') || 'home'}-${dark ? 'dark' : 'light'}.png`), Buffer.from(shot.data, 'base64'));
          await evaluate(`window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' })`);
          await sleep(150);
          const bottomShot = await call('Page.captureScreenshot', { format: 'png' });
          fs.writeFileSync(path.join(process.env.MOBILE_SCREENSHOTS, `${route.split('?')[0].replace(/\//g, '') || 'home'}-bottom-${dark ? 'dark' : 'light'}.png`), Buffer.from(bottomShot.data, 'base64'));
          await evaluate(`window.scrollTo({ top: 0, behavior: 'instant' })`);
          if (route === '/') {
            await evaluate(`document.querySelector('.watchlist-card').scrollIntoView({ block: 'center', behavior: 'instant' })`);
            await sleep(150);
            const cardShot = await call('Page.captureScreenshot', { format: 'png' });
            fs.writeFileSync(path.join(process.env.MOBILE_SCREENSHOTS, `watchlist-${dark ? 'dark' : 'light'}.png`), Buffer.from(cardShot.data, 'base64'));
            await evaluate(`window.scrollTo({ top: 0, behavior: 'instant' })`);
          }
        }
      }
      await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
      if (route.startsWith('/previsione')) {
        for (const id of ['previsione-signals', 'previsione-levels', 'previsione-charts', 'previsione-gaps']) {
          await evaluate(`document.querySelector('.previsione-mobile-sections a[href="#${id}"]').click()`);
          await sleep(600);
          assert(await evaluate(`location.hash === '#${id}' && document.querySelector('#${id}').getBoundingClientRect().width <= innerWidth`), 'Forecast quick navigation must work');
          if (process.env.MOBILE_SCREENSHOTS) {
            const shot = await call('Page.captureScreenshot', { format: 'png' });
            fs.writeFileSync(path.join(process.env.MOBILE_SCREENSHOTS, `${id}-${dark ? 'dark' : 'light'}.png`), Buffer.from(shot.data, 'base64'));
          }
        }
        await evaluate(`(() => { const period = document.querySelector('[aria-label="Orizzonte rete neurale"]'); period.value = '1w'; period.dispatchEvent(new Event('change', { bubbles: true })); })()`);
        await sleep(500);
        assert(await evaluate(`document.querySelector('[aria-label="Orizzonte rete neurale"]').value === '1w'`), 'Forecast timeframe must still change');
      }
      if (route.startsWith('/search')) {
        await evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent === 'Schermo intero').click()`);
        await sleep(350);
        assert(await evaluate(`(() => {
          const tools = document.querySelector('.tf-chart-group--fullscreen');
          const chart = document.querySelector('.chart-container--fullscreen');
          tools.scrollLeft = tools.scrollWidth;
          return chart.getBoundingClientRect().width <= innerWidth && chart.getBoundingClientRect().height <= innerHeight + 1 && tools.scrollLeft > 0;
        })()`), 'Fullscreen chart and tools must fit and scroll');
        await evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent === 'Chiudi schermo intero').click()`);
      }
      if (route.startsWith('/bilancio')) {
        assert(await evaluate(`(() => {
          const table = document.querySelector('.financial-table-scroll');
          if (!table) return false;
          table.scrollLeft = 150;
          return table.scrollLeft > 0 && table.clientWidth <= innerWidth && document.documentElement.scrollWidth <= innerWidth;
        })()`), 'Populated financial table must scroll locally');
      }
      if (route.startsWith('/quantitativi')) {
        await evaluate(`document.querySelector('#quant-tab-montecarlo').click()`);
        await sleep(900);
        assert(await evaluate(`!!document.querySelector('#quant-panel-montecarlo canvas') && document.documentElement.scrollWidth <= innerWidth`), 'Monte Carlo chart must render without page overflow');
      }
      if (route === '/') {
        await evaluate(`document.querySelector('.mobile-navigation-account').click()`);
        await sleep(200);
        assert(await evaluate(`document.querySelector('.mobile-navigation-account').getAttribute('aria-expanded') === 'true'`));
        assert(await evaluate(`(() => { const panel = document.querySelector('.account-menu-panel'); return panel.getBoundingClientRect().right <= innerWidth; })()`));
        await evaluate(`[...document.querySelectorAll('.account-menu-item')].find(b => b.textContent.includes('Cambia username')).click()`);
        await sleep(200);
        assert(await evaluate(`(() => { const dialog = document.querySelector('[role="dialog"]'); return dialog && dialog.getBoundingClientRect().width <= innerWidth; })()`));
        await evaluate(`document.querySelector('.account-dialog-close').click()`);
        await evaluate(`document.querySelector('.mobile-navigation-account').click()`);
        await sleep(150);
        assert(await evaluate(`document.querySelector('.mobile-navigation-account').getAttribute('aria-expanded') === 'true' && getComputedStyle(document.querySelector('.account-menu-panel')).display !== 'none'`), 'Bottom account action must open the account menu');
        await evaluate(`(() => { const button = document.querySelector('.mobile-navigation-account'); button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); button.click(); })()`);
        await sleep(150);
        assert(await evaluate(`document.querySelector('.mobile-navigation-account').getAttribute('aria-expanded') === 'false'`), 'Bottom account action must also close the menu');
      }
    }
    await call('Page.removeScriptToEvaluateOnNewDocument', { identifier });
  }
  await evaluate(`localStorage.clear()`);
  await call('Page.navigate', { url: origin });
  await sleep(1200);
  for (const width of [320, 390, 640]) {
    await call('Emulation.setDeviceMetricsOverride', { width, height: 700, deviceScaleFactor: 1, mobile: true });
    await sleep(150);
    assert(await evaluate(`!!document.querySelector('.auth-form') && !document.querySelector('.mobile-navigation') && document.documentElement.scrollWidth <= innerWidth`), 'Sign-in layout must fit without authenticated navigation');
  }
  console.log('PASS: interaction checks for the selected routes; anonymous sign-in at 320/390/640px');
  console.log(JSON.stringify({ checkedLayouts: results.length, runtimeErrors: [...new Set(errors)] }, null, 2));
  ws.close();
  assert(!errors.length, 'Runtime errors in fixture views');
  assert(results.every(r => r.width <= r.requestedWidth + 1 && r.viewport === r.requestedWidth && r.nav === (r.requestedWidth <= 640)), 'Viewport overflow or incorrect mobile navigation visibility');
})().catch(error => { console.error(error); process.exit(1); });
