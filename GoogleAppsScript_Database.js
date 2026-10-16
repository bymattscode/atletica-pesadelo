/**

 * =========================================================================
 * BANCO DE DADOS ONLINE - ATLETICA PESADELO (AAAEFGA)
 * Google Apps Script para Google Sheets & Google Drive
 * =========================================================================
 * 
 * INSTRUCOES RAPIDAS DE ATUALIZACAO / INSTALACAO:
 * 1. Abra a sua Planilha no Google Drive ("Vendas - Atletica Pesadelo").
 * 2. No menu superior da planilha, clique em: Extensoes > Apps Script.
 * 3. Selecione e apague todo o codigo existente e cole este conteudo completo.
 * 4. Clique no icone de disquete (Salvar) no topo.
 * 5. Clique no botao azul "Implantar" (canto superior direito) > "Gerenciar implantacoes".
 * 6. Clique no icone de lapis (Editar) no canto superior direito da janela.
 * 7. Em "Versao", selecione "Nova versao".
 * 8. Clique em "Implantar" e confirme!
 * 
 * Pronto! Os comprovantes enviados serao automaticamente salvos na pasta
 * "Comprovantes - Atletica Pesadelo" no seu Google Drive com link direto na coluna "Comprovante" da planilha
 * e os valores totais calculados serao salvos na coluna "Valor Total".
 */

function setupDatabase() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // Aba de Pedidos
  let sheetPedidos = ss.getSheetByName("Pedidos");
  if (!sheetPedidos) {
    sheetPedidos = ss.insertSheet("Pedidos");
    sheetPedidos.appendRow([
      "ID", "Data", "Nome", "Telefone", "CPF",
      "Comissário", "Produto", "Tamanho", "Quantidade",
      "Status Pagamento", "Status Entrega", "Comprovante", "Valor Total"
    ]);
    sheetPedidos.getRange(1, 1, 1, 13).setFontWeight("bold").setBackground("#800020").setFontColor("#ffffff");
    sheetPedidos.setFrozenRows(1);
  } else {
    // Se a aba ja existir com 11 ou 12 colunas, adiciona as colunas faltantes
    if (sheetPedidos.getLastColumn() < 12) {
      sheetPedidos.getRange(1, 12).setValue("Comprovante")
        .setFontWeight("bold").setBackground("#800020").setFontColor("#ffffff");
    }
    if (sheetPedidos.getLastColumn() < 13) {
      sheetPedidos.getRange(1, 13).setValue("Valor Total")
        .setFontWeight("bold").setBackground("#800020").setFontColor("#ffffff");
    }
  }

  // Aba de Comissarios
  let sheetComissarios = ss.getSheetByName("Comissarios");
  if (!sheetComissarios) {
    sheetComissarios = ss.insertSheet("Comissarios");
    sheetComissarios.appendRow(["Nome"]);
    sheetComissarios.getRange(1, 1, 1, 1).setFontWeight("bold").setBackground("#800020").setFontColor("#ffffff");
    sheetComissarios.setFrozenRows(1);
  }
}

// SALVA O ARQUIVO DE COMPROVANTE NO GOOGLE DRIVE E RETORNA O LINK
function salvarComprovanteNoDrive(nomeArquivo, base64Data, mimeType, clienteNome, pedidoId) {
  try {
    if (!base64Data || base64Data.toString().trim() === "") return "";

    // Pasta no Google Drive
    const nomePasta = "Comprovantes - Atletica Pesadelo";
    let folders = DriveApp.getFoldersByName(nomePasta);
    let folder;
    if (folders.hasNext()) {
      folder = folders.next();
    } else {
      folder = DriveApp.createFolder(nomePasta);
    }

    // Remove cabecalho de Data URL (ex: data:image/jpeg;base64,...)
    let pureBase64 = base64Data.toString();
    let detectedMime = mimeType || "image/jpeg";
    if (pureBase64.indexOf(",") > -1) {
      const parts = pureBase64.split(",");
      const mimeMatch = parts[0].match(/:(.*?);/);
      if (mimeMatch && mimeMatch[1]) {
        detectedMime = mimeMatch[1];
      }
      pureBase64 = parts[1];
    }

    const decodedBytes = Utilities.base64Decode(pureBase64);
    let extensao = "jpg";
    if (nomeArquivo && nomeArquivo.indexOf(".") > -1) {
      extensao = nomeArquivo.split('.').pop().toLowerCase();
    } else if (detectedMime.indexOf("png") > -1) {
      extensao = "png";
    } else if (detectedMime.indexOf("pdf") > -1) {
      extensao = "pdf";
    }

    const nomeLimpo = (clienteNome || "Pedido").replace(/[^a-zA-Z0-9]/g, "_");
    const nomeFinal = "Comprovante_" + nomeLimpo + "_" + pedidoId + "." + extensao;

    const blob = Utilities.newBlob(decodedBytes, detectedMime, nomeFinal);
    const file = folder.createFile(blob);

    // Torna o arquivo acessivel por link para visualizacao
    try {
      file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    } catch (eShare) {
      Logger.log("Aviso de compartilhamento: " + eShare.toString());
    }

    return file.getUrl();
  } catch (err) {
    Logger.log("Erro ao salvar comprovante no Drive: " + err.toString());
    return "";
  }
}

// RETORNAR TODOS OS DADOS (GET)
function doGet(e) {
  setupDatabase();
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // Ler Pedidos
  const sheetPedidos = ss.getSheetByName("Pedidos");
  const pedidosData = sheetPedidos.getDataRange().getValues();
  const orders = [];

  // Pula linha 1 de cabecalho
  for (let i = 1; i < pedidosData.length; i++) {
    const row = pedidosData[i];
    if (row[0]) {
      let dataFormatada = row[1];
      if (row[1] instanceof Date) {
        dataFormatada = Utilities.formatDate(row[1], "GMT-3", "dd/MM/yyyy HH:mm");
      }
      let valorFinal = (row[12] !== undefined && row[12] !== null) ? row[12].toString().trim() : "";
      if (!valorFinal || valorFinal === "" || valorFinal.toLowerCase().indexOf("definir") > -1) {
        const prod = (row[6] || "").toString();
        const qtd = parseInt(row[8] || 1);
        let sum = 0;
        const PRECOS = { "Jersey": 100, "Tube Top": 50, "Oversize": 65, "Corta Vento": 165, "Caneca": 45, "Eco Bag": 35 };
        Object.keys(PRECOS).forEach(function (pKey) {
          if (prod.toLowerCase().indexOf(pKey.toLowerCase()) > -1) {
            const reg = new RegExp(pKey + "[^\\+]*x(\\d+)", "i");
            const match = prod.match(reg);
            const q = match ? parseInt(match[1]) : (prod.indexOf("+") > -1 ? 1 : qtd);
            sum += PRECOS[pKey] * (isNaN(q) || q < 1 ? 1 : q);
          }
        });
        if (sum > 0) {
          valorFinal = "R$ " + sum.toFixed(2).replace(".", ",");
        } else {
          valorFinal = "A definir";
        }
      }

      orders.push({
        id: row[0],
        data: dataFormatada,
        nome: row[2],
        telefone: row[3],
        cpf: row[4],
        comissario: row[5],
        produto: row[6],
        tamanho: row[7],
        quantidade: parseInt(row[8] || 1),
        statusPagamento: row[9] || "Confirmado",
        statusEntrega: row[10] || "Pendente",
        comprovanteUrl: row[11] || "",
        valorTotal: valorFinal
      });
    }
  }

  // Ler Comissarios
  const sheetComissarios = ss.getSheetByName("Comissarios");
  const comissariosData = sheetComissarios.getDataRange().getValues();
  const comissarios = [];
  for (let i = 1; i < comissariosData.length; i++) {
    const row = comissariosData[i];
    if (row[0] && row[0].toString().trim() !== "") {
      comissarios.push(row[0].toString().trim());
    }
  }

  const response = {
    status: "success",
    orders: orders,
    comissarios: comissarios
  };

  return ContentService.createTextOutput(JSON.stringify(response))
    .setMimeType(ContentService.MimeType.JSON);
}

// RECEBER ACOES / PEDIDOS / CADASTROS (POST)
function doPost(e) {
  setupDatabase();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const lock = LockService.getScriptLock();
  lock.tryLock(15000);

  try {
    let payload = {};
    if (e.postData && e.postData.contents) {
      try {
        payload = JSON.parse(e.postData.contents);
      } catch (err) {
        payload = e.parameter;
      }
    } else {
      payload = e.parameter;
    }

    const action = payload.action;

    // 1. NOVO PEDIDO COM COMPROVANTE E VALOR TOTAL
    if (action === "addOrder") {
      const o = payload.order;
      const sheet = ss.getSheetByName("Pedidos");

      let comprovanteLink = "";
      if (o.comprovanteBase64) {
        comprovanteLink = salvarComprovanteNoDrive(
          o.comprovanteNome || "comprovante.jpg",
          o.comprovanteBase64,
          o.comprovanteType || "image/jpeg",
          o.nome,
          o.id
        );
      } else if (o.comprovanteUrl) {
        comprovanteLink = o.comprovanteUrl;
      }

      let valorGravado = o.valorFormatado || (o.valorTotal ? "R$ " + Number(o.valorTotal).toFixed(2).replace(".", ",") : "");
      if (!valorGravado || valorGravado === "" || valorGravado.toLowerCase().indexOf("definir") > -1) {
        const prod = (o.produto || "").toString();
        const qtd = parseInt(o.quantidade || 1);
        let sum = 0;
        const PRECOS = { "Jersey": 100, "Tube Top": 50, "Oversize": 65, "Corta Vento": 165, "Caneca": 45, "Eco Bag": 35 };
        Object.keys(PRECOS).forEach(function (pKey) {
          if (prod.toLowerCase().indexOf(pKey.toLowerCase()) > -1) {
            const reg = new RegExp(pKey + "[^\\+]*x(\\d+)", "i");
            const match = prod.match(reg);
            const q = match ? parseInt(match[1]) : (prod.indexOf("+") > -1 ? 1 : qtd);
            sum += PRECOS[pKey] * (isNaN(q) || q < 1 ? 1 : q);
          }
        });
        if (sum > 0) {
          valorGravado = "R$ " + sum.toFixed(2).replace(".", ",");
        } else {
          valorGravado = "A definir";
        }
      }

      sheet.appendRow([
        o.id,
        o.data,
        o.nome,
        o.telefone,
        o.cpf,
        o.comissario,
        o.produto,
        o.tamanho,
        o.quantidade,
        o.statusPagamento || "Confirmado",
        o.statusEntrega || "Pendente",
        comprovanteLink,
        valorGravado
      ]);

      return ContentService.createTextOutput(JSON.stringify({
        status: "success",
        message: "Pedido gravado no Google Sheets",
        comprovanteUrl: comprovanteLink,
        valorTotal: valorGravado
      })).setMimeType(ContentService.MimeType.JSON);
    }

    // 2. EXCLUIR PEDIDO
    if (action === "deleteOrder") {
      const orderId = payload.id;
      const sheet = ss.getSheetByName("Pedidos");
      const data = sheet.getDataRange().getValues();
      for (let i = 1; i < data.length; i++) {
        if (data[i][0] == orderId) {
          sheet.deleteRow(i + 1);
          break;
        }
      }
      return ContentService.createTextOutput(JSON.stringify({ status: "success", message: "Pedido removido do Google Sheets" }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // 3. ATUALIZAR STATUS DE PAGAMENTO / ENTREGA
    if (action === "updateOrder") {
      const orderId = payload.id;
      const sheet = ss.getSheetByName("Pedidos");
      const data = sheet.getDataRange().getValues();
      for (let i = 1; i < data.length; i++) {
        if (data[i][0] == orderId) {
          if (payload.statusPagamento) sheet.getRange(i + 1, 10).setValue(payload.statusPagamento);
          if (payload.statusEntrega) sheet.getRange(i + 1, 11).setValue(payload.statusEntrega);
          break;
        }
      }
      return ContentService.createTextOutput(JSON.stringify({ status: "success", message: "Status atualizado no Google Sheets" }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // 4. CADASTRAR COMISSARIO
    if (action === "addComissario") {
      const nome = payload.nome;
      const sheet = ss.getSheetByName("Comissarios");
      const data = sheet.getDataRange().getValues();
      let exists = false;
      for (let i = 1; i < data.length; i++) {
        if (data[i][0] && data[i][0].toString().toLowerCase() === nome.toLowerCase()) {
          exists = true;
          break;
        }
      }
      if (!exists) {
        sheet.appendRow([nome]);
      }
      return ContentService.createTextOutput(JSON.stringify({ status: "success", message: "Comissario gravado" }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // 5. REMOVER COMISSARIO
    if (action === "deleteComissario") {
      const nome = payload.nome;
      const sheet = ss.getSheetByName("Comissarios");
      const data = sheet.getDataRange().getValues();
      for (let i = 1; i < data.length; i++) {
        if (data[i][0] && data[i][0].toString().toLowerCase() === nome.toLowerCase()) {
          sheet.deleteRow(i + 1);
          break;
        }
      }
      return ContentService.createTextOutput(JSON.stringify({ status: "success", message: "Comissario removido" }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    return ContentService.createTextOutput(JSON.stringify({ status: "error", message: "Acao nao reconhecida" }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (error) {
    return ContentService.createTextOutput(JSON.stringify({ status: "error", error: error.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  } finally {
    lock.releaseLock();
  }
}
