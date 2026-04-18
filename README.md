# Vrai Score

Análise fundamentalista de ações da B3 com ranking por setor, filtros ajustáveis e insights.

## Como publicar (GitHub Pages — grátis, leva ~5 min)

Você não precisa programar. Siga os 6 passos abaixo.

### 1. Crie o repositório

1. Entre em https://github.com/vraiconsultoria
2. Clique em **New repository** (botão verde)
3. Nome sugerido: **`vrai-score`**
4. Visibilidade: **Public**
5. Marque **Add a README file** (qualquer coisa, vai ser substituída)
6. Clique em **Create repository**

### 2. Suba os arquivos

1. No repositório recém-criado, clique em **Add file → Upload files**
2. Arraste **todo o conteúdo da pasta `webapp/`** para a janela (ou seja: `index.html`, a pasta `assets/`, a pasta `data/`, `README.md`, `.github/`, `scripts/`)
3. Clique em **Commit changes**

### 3. Ative o GitHub Pages

1. No repositório, clique em **Settings** (engrenagem no topo)
2. No menu lateral esquerdo, clique em **Pages**
3. Em **Source**, escolha **Deploy from a branch**
4. Em **Branch**, escolha **main** e **/ (root)**
5. Clique em **Save**

### 4. Aguarde 1-2 minutos

O GitHub vai gerar sua URL pública. Ela aparecerá no topo da tela de Pages como:

```
https://vraiconsultoria.github.io/vrai-score/
```

### 5. Pronto

Abra essa URL no celular, computador, compartilhe com clientes. Funciona em qualquer dispositivo.

### 6. (Opcional) Domínio próprio

Se tiver um domínio (ex: `vraiconsultoria.com.br`), em **Settings → Pages → Custom domain** você pode apontar para algo como `score.vraiconsultoria.com.br`. Precisa adicionar um registro CNAME no seu provedor de domínio. Se quiser fazer isso, me avise.

---

## Estrutura dos arquivos

```
webapp/
├── index.html              ← o app (HTML + Tailwind + Alpine.js via CDN)
├── assets/
│   └── logo.png            ← logo Vrai
├── data/
│   └── stocks.json         ← dados das ações (snapshot inicial)
├── scripts/
│   ├── build-data.js       ← converte a planilha em stocks.json
│   └── update-data.js      ← (v2) atualiza stocks.json via brapi/Fundamentus
├── .github/workflows/
│   └── update-data.yml     ← (v2) agendamento diário do update
└── README.md               ← este arquivo
```

## Atualização dos dados

### Snapshot atual (v1)
Os dados em `data/stocks.json` vieram da sua planilha do Google Sheets no momento da criação. Para atualizar manualmente:

1. Exporte a aba "Análises" da planilha como CSV
2. Salve o arquivo como `planilha_923396675.csv` na pasta raiz do projeto
3. Execute no terminal: `node scripts/build-data.js`
4. Faça commit do novo `data/stocks.json`

### Automação (v2 — próxima sessão)
O arquivo `.github/workflows/update-data.yml` está pronto para ativar atualização automática. Quando você pedir a v2, vamos:

- Conectar a API da **brapi.dev** (grátis, sem autenticação) para preço, P/L, DY, ROE, P/VP em tempo real
- Scraping do **Fundamentus** para Payout, Dívida Líquida/EBITDA e P/L recorrente
- Rodar todo dia útil às 19h (pós-fechamento do mercado) via GitHub Actions
- Commit automático do `data/stocks.json` atualizado

O workflow já existe como template; basta remover o comentário `# disabled: true` do arquivo quando estivermos prontos.

## Métodos de score disponíveis

| Método | Fórmula | Quando usar |
|---|---|---|
| **Retorno / P/L** (padrão) | (DY + Growth) / P/L | Visão geral equilibrada de retorno e preço |
| **Bazin** | (Preço-teto 6% − Preço) / Preço | Carteira focada em dividendos |
| **Magic Formula** | ROE / P/L | Cruza barato com qualidade (Greenblatt) |
| **Graham** | (√(22,5 × LPA × VPA) − Preço) / Preço | Buy & hold defensivo |

## Filtros de qualidade

Aplicados antes do ranking:

- **Payout máximo** (padrão: 85%, utilities 90%) — evita "armadilhas de dividendo"
- **P/L máximo** ajustável
- **DY mínimo** ajustável
- **ROE mínimo** ajustável
- **Excluir prejuízo** (P/L ≤ 0 ou ROE ≤ 0)
- **Alerta DY > 15%** (pode indicar empresa em dificuldades)

## Limitações conhecidas desta versão

- **Dívida Líquida/EBITDA**: ainda não está no dataset. Será adicionada na v2 via scraping do Fundamentus.
- **P/L Recorrente (ex-itens)**: idem. A v1 usa o P/L reportado. Para ações com itens não-recorrentes relevantes (ex: venda de ativos), pode haver distorção.
- **Bancos**: DL/EBITDA não se aplica. Na v2 vamos puxar Basileia e inadimplência.
- **Histórico 5 anos**: ainda não implementado. Chegará na v2 com brapi.

## Suporte

Dúvidas técnicas, bugs, pedidos de feature: abra uma issue no próprio repositório ou me chame.

---

*Uso educacional — não constitui recomendação de investimento. Consulte sempre um profissional certificado (CVM/Ancord/CFP) antes de decidir.*
