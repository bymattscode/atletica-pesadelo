# Atlética Pesadelo

## Testar manualmente no computador

Com Node.js instalado, execute no terminal:

```sh
cd /home/lucasodpaula/Workspace/Pesadelo/app-produtos/atletica-pesadelo
node dev/server.cjs
```

Abra **http://127.0.0.1:4173** no navegador. Encerre com **Ctrl+C**.
O servidor usa somente o endereço local do computador.

Essa prévia inclui comissários fictícios e um botão **Painel de teste**.
Você pode adicionar produtos, anexar uma imagem/PDF fictício, confirmar pedidos,
alterar status, visualizar o ranking e exportar o Excel. Os dados ficam apenas no
armazenamento desse navegador e sobrevivem ao recarregamento da página.
Arquivos de comprovante grandes podem atingir o limite de armazenamento local.

A prévia substitui a integração por uma API simulada antes de carregar o app,
usa chaves locais separadas e aplica uma política do navegador que bloqueia
conexões de dados. Não acessa o Google Sheets nem o Drive. Fontes, ícones e a
biblioteca Excel continuam sendo carregados dos CDNs existentes.

Use esse comando para testes manuais: abrir `index.html` diretamente ou servir a
pasta sem o servidor de prévia carrega a configuração normal de produção.

Para usar outra porta:

```sh
PORT=4174 node dev/server.cjs
```

Os testes automatizados e seu isolamento estão documentados em
[tests/README.md](tests/README.md).
