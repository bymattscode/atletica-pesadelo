'use strict';

const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');

const project = path.resolve(__dirname, '..');
const previewKeys = {
  PESADELO_PEDIDOS_UNB_PROD_V1: 'PESADELO_PREVIEW_PEDIDOS_V1',
  PESADELO_COMISSARIOS_PROD_V1: 'PESADELO_PREVIEW_COMISSARIOS_V1',
  PESADELO_SHEETS_URL: 'PESADELO_PREVIEW_SHEETS_URL',
  PESADELO_GESTAO_AUTH: 'PESADELO_PREVIEW_GESTAO_AUTH',
  PESADELO_PEDIDOS_UNB_CLEAN_V1: 'PESADELO_PREVIEW_CLEAN_V1',
  PESADELO_PEDIDOS_UNB_OFICIAL_V1: 'PESADELO_PREVIEW_OFICIAL_V1'
};

async function handleRequest(req, res) {
  const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
  const headers = {
    'Cache-Control': 'no-store',
    // Mesmo se o mock falhar, o navegador não pode consultar o Google Sheets.
    'Content-Security-Policy': "connect-src 'none'; frame-src 'self' data:; form-action 'none'; object-src 'none'; base-uri 'self'",
    'X-Content-Type-Options': 'nosniff'
  };
  try {
    if (pathname === '/' || pathname === '/index.html') {
      let html = await fs.readFile(path.join(project, 'index.html'), 'utf8');
      for (const [original, local] of Object.entries(previewKeys)) html = html.replaceAll(original, local);
      html = html.replace(/const DEFAULT_SHEETS_URL = "[^"]+";/,
        'const DEFAULT_SHEETS_URL = "/__preview__/api";');
      html = html.replace('<head>', '<head>\n  <script src="/__preview__/mock-api.js"></script>');
      html = html.replace('<body>', `<body>
        <aside style="padding:12px 20px;background:#422006;color:#fef3c7;font:14px sans-serif;display:flex;gap:12px;flex-wrap:wrap;align-items:center;justify-content:center">
          <span>PRÉVIA LOCAL · Dados de teste somente neste navegador · Google Sheets desconectado</span>
          <button type="button" onclick="sessionStorage.setItem('PESADELO_PREVIEW_GESTAO_AUTH','true');applyAuthState();switchMainView('dashView',document.getElementById('btnNavDash'))" style="padding:6px 10px;cursor:pointer">Painel de teste</button>
        </aside>`);
      res.writeHead(200, { ...headers, 'Content-Type': 'text/html; charset=utf-8' }).end(html);
      return;
    }
    if (pathname === '/__preview__/mock-api.js') {
      const script = await fs.readFile(path.join(__dirname, 'mock-api.js'));
      res.writeHead(200, { ...headers, 'Content-Type': 'text/javascript; charset=utf-8' }).end(script);
      return;
    }
    if (/^\/assets\/logo_(pesadelo|unb)\.png$/.test(pathname)) {
      const asset = await fs.readFile(path.join(project, pathname.slice(1)));
      res.writeHead(200, { ...headers, 'Content-Type': 'image/png' }).end(asset);
      return;
    }
    res.writeHead(404, headers).end('Recurso indisponível na prévia local.');
  } catch (error) {
    console.error('Erro na prévia local:', error.message);
    res.writeHead(500, headers).end('Não foi possível carregar a prévia local.');
  }
}

function createPreviewServer() {
  return http.createServer(handleRequest);
}

if (require.main === module) {
  const port = Number(process.env.PORT || 4173);
  const server = createPreviewServer();
  server.on('error', error => {
    console.error(`Não foi possível iniciar a prévia: ${error.message}`);
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`Prévia local: http://127.0.0.1:${server.address().port}`);
    console.log('Pedidos de teste ficam somente no navegador. Nenhum acesso ao Google Sheets.');
    console.log('Use Ctrl+C para encerrar.');
  });
}

module.exports = { createPreviewServer, handleRequest };
