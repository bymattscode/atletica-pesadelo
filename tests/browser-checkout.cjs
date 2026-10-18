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
      const type = resolved.endsWith('.png') ? 'image/png' : resolved.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8';
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
    await check('Kit catalog and accessory choices use all eight promotional prices', `
      resetOrderForm();
      qaAssert(document.querySelectorAll('.kit-card').length === 6, 'Six kit cards must exist');
      qaAssert([...document.querySelectorAll('.size-btn')].map(button => button.textContent.trim()).join(',') === PesadeloKits.sizes.join(','), 'Kits must use the existing size range');
      for (const [id, price] of [['campus', 95], ['look-tube', 90], ['torcida', 140], ['campus-completo', 280], ['frio-no-campus', 220], ['tudo-pesadelo', 455]]) {
        configureKit(id);
        qaAssert(document.getElementById('kitPriceSummary').textContent.includes(price + ',00'), 'Incorrect base price: ' + id);
      }
      for (const [id, base, complete] of [['campus', 95, null], ['look-tube', 90, 120], ['frio-no-campus', 220, 250]]) {
        configureKit(id);
        for (const accessory of ['Eco Bag', 'Caneca individual']) {
          document.getElementById('kitAccessorySelect').value = accessory; handleKitConfigChange();
          qaAssert(PesadeloKits.createItem(id, readKitOptions(), PRECOS_PRODUTOS).unitPrice === base, 'Accessory changed base price');
        }
        if (complete) {
          document.getElementById('kitAccessorySelect').value = 'ambos'; handleKitConfigChange();
          qaAssert(PesadeloKits.createItem(id, readKitOptions(), PRECOS_PRODUTOS).unitPrice === complete && complete - base === 30, 'Upgrade must cost exactly 30');
        } else {
          qaAssert(![...document.getElementById('kitAccessorySelect').options].some(option => option.value === 'ambos'), 'Campus must allow only one accessory');
        }
      }
      configureKit('campus-completo'); qaAssert(document.getElementById('kitAccessoryGroup').hidden, 'Fixed composition must not offer an accessory choice');
    `);
    await check('Updated Campus Completo uses two independent sizes and charges 280 per kit', `
      resetOrderForm(); configureKit('campus-completo');
      qaAssert(document.querySelectorAll('#kitSizeFields select').length === 2, 'Campus Completo must offer two clothing sizes');
      qaInput('kitSize-Oversize', 'PP'); qaInput('kitSize-CortaVento', 'XGG'); qaInput('kitQuantity', '2');
      const kit = PesadeloKits.createItem('campus-completo', readKitOptions(), PRECOS_PRODUTOS);
      qaAssert(kit.unitPrice === 280 && kit.valorAvulso === 295 && kit.economia === 15, 'Incorrect new prices');
      qaAssert(kit.componentes.length === 4 && !kit.componentes.some(item => item.produto === 'Eco Bag'), 'Old accessory must not remain in the kit');
      addKitToOrder(); qaTotal('560,00');
      qaInput('f_nome', 'Comprador Campus Completo QA'); qaInput('f_telefone', '61999998888'); qaInput('f_cpf', '12345678900');
      document.getElementById('f_comissario').selectedIndex = 1;
      currentUploadedFile = { nome: 'comprovante-qa.pdf', type: 'application/pdf', base64: 'data:application/pdf;base64,JVBERi0xLjQ=' };
      document.getElementById('orderForm').requestSubmit();
      qaAssert(pendingOrderData.valorTotal === 560 && pendingOrderData.quantidade === 8, 'Two kits must cost 560 and contain eight pieces');
      qaAssert(pendingOrderData.produto.includes('Oversize (PP)') && pendingOrderData.produto.includes('Corta Vento (XGG)') && !pendingOrderData.produto.includes('Ecobag'), 'Review lost the selected clothing sizes');
      backToOrderForm();
    `);
    await check('Two Campus kits cost 190 and can change quantity or be removed', `
      resetOrderForm(); configureKit('campus'); qaInput('kitQuantity', '2'); addKitToOrder(); qaTotal('190,00');
      qaAssert(orderCart[0].quantidade === 2 && itemPieceCount(orderCart[0]) === 4, 'Kit and piece quantities must differ');
      const quantity = document.querySelector('.kit-cart-quantity input'); quantity.value = '3'; quantity.dispatchEvent(new Event('change', { bubbles: true }));
      qaTotal('285,00'); changeKitQuantity(0, 2); qaTotal('190,00'); removeItemFromCart(0);
      qaAssert(orderCart.length === 0, 'Removing a kit must remove its entire composition');
    `);
    await check('All clothing sizes and independent kit Jersey customizations survive navigation', `
      resetOrderForm(); configureKit('tudo-pesadelo');
      qaAssert(document.querySelectorAll('#kitSizeFields select').length === 4, 'Tudo Pesadelo requires four independent sizes');
      qaInput('kitSize-TubeTop', 'PP'); qaInput('kitSize-Jersey', 'G'); qaInput('kitSize-Oversize', 'GG'); qaInput('kitSize-CortaVento', 'XGG');
      qaInput('kitJerseyName', 'ALESSANDRO'); qaInput('kitJerseyNumber', '07');
      configureKit('campus'); configureKit('tudo-pesadelo');
      qaAssert(document.getElementById('kitJerseyNumber').value === '07' && document.getElementById('kitSize-Jersey').value === 'G', 'Kit draft must survive navigation');
      addKitToOrder(); qaInput('kitJerseyName', 'BEATRIZ'); qaInput('kitJerseyNumber', '00'); addKitToOrder();
      qaAssert(orderCart.length === 2, 'Personalized kits must stay separate'); qaTotal('910,00');
      qaInput('f_nome', 'Comprador QA local'); qaInput('f_telefone', '61999998888'); qaInput('f_cpf', '12345678900');
      document.getElementById('f_comissario').selectedIndex = 1;
      currentUploadedFile = { nome: 'comprovante-qa.pdf', type: 'application/pdf', base64: 'data:application/pdf;base64,JVBERi0xLjQ=' };
      document.getElementById('orderForm').requestSubmit();
      qaAssert(pendingOrderData.quantidade === 14, 'Two complete kits must count 14 pieces');
      const review = document.getElementById('revItemsList').textContent;
      qaAssert(review.includes('ALESSANDRO') && review.includes('BEATRIZ') && review.includes('07') && review.includes('00'), 'Kit review lost customization');
      backToOrderForm();
    `);
    for (const width of [360, 390, 1440]) {
      await command('Emulation.setDeviceMetricsOverride', { width, height: width < 500 ? 844 : 1000, deviceScaleFactor: 1, mobile: false });
      for (const view of ['kit-form', 'kit-review']) {
        await evaluate(view === 'kit-form' ? 'backToOrderForm()' : `document.getElementById('orderForm').requestSubmit()`);
        await evaluate(`document.getElementById('toast').classList.remove('show'); window.scrollTo(0,0);`);
        const widthCheck = await evaluate('document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth');
        assert.equal(widthCheck, true, 'Kit view must not overflow horizontally at ' + width);
        if (view === 'kit-review') {
          assert.equal(await evaluate(`[...document.querySelectorAll('.confirm-kit-item .kit-item-details')].every(element => element.scrollWidth <= element.clientWidth + 1)`), true,
            'Kit composition must wrap inside its review column');
        }
        const { data } = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
        await fs.writeFile(path.join(screenshots, view + '-' + width + '.png'), Buffer.from(data, 'base64'));
        if (view === 'kit-form') {
          await evaluate(`document.getElementById('kitConfigurator').scrollIntoView({ behavior: 'instant', block: 'start' })`);
          const focused = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
          await fs.writeFile(path.join(screenshots, 'kit-config-' + width + '.png'), Buffer.from(focused.data, 'base64'));
        }
      }
    }
    passed.push('Kit configuration and review remain responsive at 360px, 390px and 1440px');
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
    await check('Mixed kit checkout sends 270 to the mock and preserves purchased composition', `
      startNewOrder(); configureKit('campus'); addKitToOrder();
      configureKit('torcida'); qaInput('kitJerseyName', 'ANA'); qaInput('kitJerseyNumber', '07'); addKitToOrder();
      qaSelect('Caneca individual'); addItemToOrder(); qaTotal('270,00');
      qaInput('f_nome', 'Comprador de kits QA'); qaInput('f_telefone', '61999998888'); qaInput('f_cpf', '12345678900');
      document.getElementById('f_comissario').selectedIndex = 1;
      currentUploadedFile = { nome: 'comprovante-qa.pdf', type: 'application/pdf', base64: 'data:application/pdf;base64,JVBERi0xLjQ=' };
      document.getElementById('orderForm').requestSubmit();
      qaAssert(pendingOrderData.valorTotal === 270 && pendingOrderData.quantidade === 6, 'Mixed kit order has incorrect totals');
      document.getElementById('btnConfirmFinalize').click();
      const payload = JSON.parse(window.__mockRequests.filter(request => request.method === 'POST').at(-1).body);
      const products = getOrderItems({ produto: payload.order.produto, quantidade: payload.order.quantidade });
      qaAssert(products.length === 6 && products.reduce((sum, item) => sum + item.subtotal, 0) === 270, 'Serialized kit composition lost its discounts');
      qaAssert(payload.order.produto.includes('Kit Campus') && payload.order.produto.includes('Kit Torcida') && payload.order.produto.includes('Número: 07'), 'Submitted order lost kit identity');
    `);
    const requests = await evaluate('window.__mockRequests');
    assert.equal(requests.filter(request => request.method === 'POST').length, 2, 'Both submissions must be mocked');
    if (previewMode) {
      assert.ok(requests.every(request => request.url === origin + '/__preview__/api'), 'Preview must use only its local endpoint');
      await evaluate(`syncWithGoogleSheets(false)`);
      assert.equal(await evaluate(`orders.length === 2 && orders.every(order => !order.itens) && orders.some(order => order.valorTotal === 'R$ 270,00' && getOrderItems(order).some(item => item.numeroCamisa === '07' && item.kitNome === 'Kit Torcida'))`), true,
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
