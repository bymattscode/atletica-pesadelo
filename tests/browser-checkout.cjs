#!/usr/bin/env node
// Isolated browser checks: no production request can leave this test browser.
// External traffic is blocked by a dead proxy AND CDP Fetch interception;
// fetch is replaced before application scripts run. Uses a fresh temporary profile.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const project = path.resolve(__dirname, '..');
const smokeOnly = process.argv.includes('--smoke');
const previewMode = process.argv.includes('--preview');
const chromePath = process.env.CHROME_PATH || '/usr/bin/google-chrome';

async function main() {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'pesadelo-browser-qa-'));
  const screenshots = path.join(profile, 'screenshots');
  await fs.mkdir(screenshots);
  const server = previewMode ? require('../dev/server.cjs').createPreviewServer() : http.createServer(async (req, res) => {
    const requested = new URL(req.url, 'http://localhost').pathname;
    const file = requested === '/' ? 'index.html' : requested.slice(1);
    const resolved = path.resolve(project, file);
    if (!resolved.startsWith(project + path.sep)) {
      res.writeHead(403).end();
      return;
    }
    try {
      const data = await fs.readFile(resolved);
      const type = resolved.endsWith('.png') ? 'image/png' : 'text/html; charset=utf-8';
      res.writeHead(200, { 'Content-Type': type }).end(data);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const chrome = spawn(chromePath, [
    '--headless=new', '--no-sandbox', '--disable-dev-shm-usage',
    '--disable-gpu', '--disable-background-networking', '--disable-component-update',
    '--disable-default-apps', '--disable-extensions', '--disable-sync',
    '--no-first-run', '--no-default-browser-check', '--disable-features=MediaRouter',
    '--proxy-server=http://127.0.0.1:9', '--proxy-bypass-list=127.0.0.1',
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let ws;
  try {
    const endpoint = await new Promise((resolve, reject) => {
      let log = '';
      const timeout = setTimeout(() => reject(new Error(`Chrome startup timed out: ${log}`)), 10000);
      chrome.once('error', reject);
      chrome.once('exit', code => { clearTimeout(timeout); reject(new Error(`Chrome exited: ${code}: ${log}`)); });
      chrome.stderr.on('data', chunk => {
        log += chunk.toString();
        const match = log.match(/DevTools listening on (ws:\/\/[^\s]+)/);
        if (match) { clearTimeout(timeout); resolve(match[1]); }
      });
    });
    ws = new WebSocket(endpoint);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    let nextId = 1;
    let sessionId;
    const pending = new Map();
    const blocked = [];
    const exceptions = [];
    const interceptErrors = [];
    function command(method, params = {}, session = sessionId) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timed out: ${method}`)); }, 15000);
        pending.set(id, { resolve, reject, timeout });
        ws.send(JSON.stringify({ id, method, params, ...(session ? { sessionId: session } : {}) }));
      });
    }
    ws.onmessage = event => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const task = pending.get(message.id);
        if (!task) return;
        pending.delete(message.id);
        clearTimeout(task.timeout);
        if (message.error) task.reject(new Error(JSON.stringify(message.error)));
        else task.resolve(message.result);
      } else if (message.method === 'Fetch.requestPaused') {
        const { requestId, request } = message.params;
        const allowed = request.url.startsWith(origin + '/');
        if (!allowed) blocked.push(request.url);
        command(allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest', {
          requestId, ...(!allowed ? { errorReason: 'BlockedByClient' } : {})
        }, message.sessionId).catch(error => interceptErrors.push(error.message));
      } else if (message.method === 'Runtime.exceptionThrown') {
        exceptions.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
      }
    };
    const { targetId } = await command('Target.createTarget', { url: 'about:blank' }, null);
    ({ sessionId } = await command('Target.attachToTarget', { targetId, flatten: true }, null));
    await command('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
    await command('Page.enable');
    await command('Runtime.enable');
    if (!previewMode) await command('Page.addScriptToEvaluateOnNewDocument', { source: `
      window.__mockRequests = [];
      window.fetch = async (url, options = {}) => {
        window.__mockRequests.push({ url: String(url), method: options.method || 'GET', body: options.body || null });
        return new Response(JSON.stringify({ status: 'success', orders: [], comissarios: ['Comissário QA local'] }), {
          status: 200, headers: { 'Content-Type': 'application/json' }
        });
      };
      window.open = () => { throw new Error('Opening external windows is disabled in QA'); };
      navigator.sendBeacon = () => false;
    ` });
    async function evaluate(expression) {
      const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    }
    await command('Page.navigate', { url: origin + '/' });
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await evaluate(`document.readyState === 'complete' && typeof getCurrentFormItem === 'function' && document.getElementById('f_comissario').options.length > 1`)) break;
      if (attempt === 99) throw new Error('Application did not initialize');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (previewMode) await evaluate('window.__mockRequests = window.__previewRequests');
    assert.equal(await evaluate('window.__mockRequests.length'), 1, 'Initial sync is mocked');
    assert.equal(exceptions.length, 0, `Browser exceptions: ${exceptions.join('\n')}`);
    if (smokeOnly) {
      console.log(JSON.stringify({ passed: ['Isolated browser startup'], externalRequestsBlocked: blocked.length, profile }, null, 2));
      return;
    }
    await evaluate(`
      window.qaAssert = (condition, message) => { if (!condition) throw new Error(message); };
      window.qaSelect = label => {
        const tile = [...document.querySelectorAll('.product-tile')].find(el => el.querySelector('.product-name').textContent.trim() === label);
        qaAssert(tile, 'Product tile not found: ' + label); tile.click();
      };
      window.qaInput = (id, value) => {
        const input = document.getElementById(id); qaAssert(input, 'Input not found: ' + id);
        input.value = value; input.dispatchEvent(new Event('input', { bubbles: true }));
      };
      window.qaSize = value => [...document.querySelectorAll('.size-btn')].find(el => el.textContent.trim() === value).click();
      window.qaTotal = value => qaAssert(document.getElementById('pixTotalValueDisplay').textContent.includes(value), 'Incorrect Pix total: ' + document.getElementById('pixTotalValueDisplay').textContent);
    `);
    const passed = [];
    async function check(name, code) {
      await evaluate(`(() => { ${code} })()`);
      passed.push(name);
    }
    await check('Scenario A: caneca + tirante individually = 50', `
      resetOrderForm(); qaSelect('Caneca individual'); qaInput('f_quantidade', '1'); addItemToOrder();
      qaSelect('Tirante individual'); qaInput('f_quantidade', '1'); addItemToOrder();
      qaAssert(orderCart.length === 2, 'Individual products must be independent'); qaTotal('50,00');
    `);
    await check('Scenario B: legacy combo = 45; Ecobag = 35', `
      resetOrderForm(); qaSelect('Caneca + Tirante'); qaAssert(getCurrentFormItem().produto === 'Caneca', 'Legacy combo identity changed');
      addItemToOrder(); qaTotal('45,00'); resetOrderForm(); qaSelect('Ecobag'); qaTotal('35,00');
    `);
    await check('Scenario C: 2 canecas + 1 tirante = 85', `
      resetOrderForm(); qaSelect('Caneca individual'); qaInput('f_quantidade', '2'); addItemToOrder();
      qaSelect('Tirante individual'); qaInput('f_quantidade', '1'); addItemToOrder(); qaTotal('85,00');
    `);
    await check('Jersey drafts preserve size/name/07 during product navigation', `
      resetOrderForm(); qaSelect('Jersey'); qaSize('GG'); qaInput('f_jersey_nome', 'ALESSANDRO'); qaInput('f_jersey_numero', '07');
      qaSelect('Caneca individual'); qaAssert(document.getElementById('sizeGroupContainer').style.display === 'none', 'Individual caneca should not require size');
      qaSelect('Oversize'); qaSize('P'); qaSelect('Jersey');
      qaAssert(document.getElementById('f_tamanho').value === 'GG', 'Jersey size was lost');
      qaAssert(document.getElementById('f_jersey_nome').value === 'ALESSANDRO', 'Jersey name was lost');
      qaAssert(document.getElementById('f_jersey_numero').value === '07', 'Jersey zero was lost'); qaTotal('100,00');
    `);
    await check('Scenario D: same-size jerseys retain independent customizations', `
      addItemToOrder(); qaInput('f_jersey_nome', 'BEATRIZ'); qaInput('f_jersey_numero', '10'); addItemToOrder();
      qaAssert(orderCart.length === 2, 'Distinct personalized jerseys were merged'); qaTotal('200,00');
      const text = document.getElementById('orderItemsList').textContent;
      qaAssert(text.includes('ALESSANDRO') && text.includes('07') && text.includes('BEATRIZ') && text.includes('10'), 'Cart is missing personalization');
    `);
    await check('Review and back preserve customization and draft', `
      qaInput('f_nome', 'Comprador QA local'); qaInput('f_telefone', '61999998888'); qaInput('f_cpf', '12345678900');
      document.getElementById('f_comissario').selectedIndex = 1;
      currentUploadedFile = { nome: 'comprovante-qa.pdf', type: 'application/pdf', base64: 'data:application/pdf;base64,JVBERi0xLjQ=' };
      document.getElementById('orderForm').requestSubmit();
      qaAssert(document.getElementById('confirmOrderView').classList.contains('active'), 'Review did not open');
      qaAssert(pendingOrderData.valorTotal === 200, 'Review total is incorrect');
      const text = document.getElementById('revItemsList').textContent;
      qaAssert(text.includes('ALESSANDRO') && text.includes('07') && text.includes('BEATRIZ'), 'Review is missing personalization');
      backToOrderForm(); qaAssert(orderCart.length === 2, 'Cart lost when going back');
      qaAssert(document.getElementById('f_tamanho').value === 'GG' && document.getElementById('f_jersey_numero').value === '10', 'Draft lost when going back');
    `);
    for (const width of [360, 390, 1440]) {
      await command('Emulation.setDeviceMetricsOverride', { width, height: width < 500 ? 844 : 1000, deviceScaleFactor: 1, mobile: false });
      for (const view of ['form', 'review']) {
        await evaluate(view === 'form' ? 'backToOrderForm()' : `document.getElementById('orderForm').requestSubmit()`);
        await evaluate(`window.scrollTo(0, 0); document.getElementById('toast').classList.remove('show');`);
        const dimensions = await evaluate(`({ width: innerWidth, body: document.body.scrollWidth, root: document.documentElement.scrollWidth })`);
        assert.ok(dimensions.body <= width && dimensions.root <= width, `${view} horizontal overflow at ${width}px: ${JSON.stringify(dimensions)}`);
        const { data } = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
        await fs.writeFile(path.join(screenshots, `${view}-${width}.png`), Buffer.from(data, 'base64'));
      }
    }
    passed.push('No horizontal overflow: form and review at 360px, 390px, 1440px');
    await check('Invalid partial personalization cannot enter cart; blank pair remains optional', `
      resetOrderForm(); qaSelect('Jersey'); qaInput('f_jersey_nome', 'NOME'); qaInput('f_jersey_numero', ''); addItemToOrder();
      qaAssert(orderCart.length === 0, 'Incomplete personalization was accepted');
      qaInput('f_jersey_nome', ''); qaInput('f_jersey_numero', '07'); addItemToOrder();
      qaAssert(orderCart.length === 0, 'Number without name was accepted');
      qaInput('f_jersey_nome', ''); qaInput('f_jersey_numero', ''); addItemToOrder();
      qaAssert(orderCart.length === 1, 'Unpersonalized legacy jersey was rejected');
    `);
    await check('Final confirmation submits only to the mock and retains personalization', `
      resetOrderForm(); qaSelect('Jersey'); qaSize('P');
      qaInput('f_jersey_nome', 'ANA-MARIA'); qaInput('f_jersey_numero', '07'); addItemToOrder();
      qaSelect('Caneca individual'); qaInput('f_quantidade', '2'); addItemToOrder();
      qaInput('f_nome', 'Comprador QA local'); qaInput('f_telefone', '61999998888'); qaInput('f_cpf', '12345678900');
      document.getElementById('f_comissario').selectedIndex = 1;
      currentUploadedFile = { nome: 'comprovante-qa.pdf', type: 'application/pdf', base64: 'data:application/pdf;base64,JVBERi0xLjQ=' };
      document.getElementById('orderForm').requestSubmit();
      qaAssert(pendingOrderData.valorTotal === 170, 'Mixed review total must be 170');
      document.getElementById('btnConfirmFinalize').click();
      const posts = window.__mockRequests.filter(request => request.method === 'POST');
      qaAssert(posts.length === 1, 'Final confirmation must call the existing mocked sender once');
      const payload = JSON.parse(posts[0].body);
      qaAssert(payload.action === 'addOrder' && payload.order.valorTotal === 170, 'Incorrect submitted action or amount');
      qaAssert(payload.order.produto.includes('Nome: ANA-MARIA; Número: 07'), 'Submitted description lost personalization');
      qaAssert(document.getElementById('confirmSuccessBox').style.display === 'block', 'Success view did not open');
      qaAssert(document.getElementById('successProductsSummary').textContent.includes('Número: 07'), 'Success summary lost leading zero');
      qaAssert(orderCart.length === 0 && document.getElementById('f_jersey_nome').value === '', 'New-order draft was not reset');
    `);
    const requests = await evaluate('window.__mockRequests');
    assert.equal(requests.filter(request => request.method === 'POST').length, 1, 'The only submission must be mocked');
    if (previewMode) {
      assert.ok(requests.every(request => request.url === origin + '/__preview__/api'), 'Preview must use only its local endpoint');
      await evaluate(`syncWithGoogleSheets(false)`);
      assert.equal(await evaluate(`orders.length === 1 && !orders[0].itens && getOrderItems(orders[0])[0].numeroCamisa === '07'`), true,
        'The preview must preserve the personalized order through its simulated backend');
      passed.push('Manual preview server uses only its local endpoint and reloads saved personalization');
    }
    assert.equal(exceptions.length, 0, `Browser exceptions: ${exceptions.join('\n')}`);
    assert.deepEqual(interceptErrors, [], 'Network interception must be error-free');
    console.log(JSON.stringify({ passed, externalRequestsBlocked: blocked.length, backendCallsMocked: requests.length, realBackendCalls: 0, screenshots }, null, 2));
  } finally {
    if (ws) ws.close();
    chrome.kill('SIGTERM');
    await new Promise(resolve => server.close(resolve));
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
