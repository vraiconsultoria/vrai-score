// Converte a aba "Análises" (CSV da planilha) em data/stocks.json estruturado.
// Uso: node scripts/build-data.js ../planilha_923396675.csv data/stocks.json

const fs = require('fs');
const path = require('path');

const INPUT = process.argv[2] || path.join(__dirname, '..', '..', 'planilha_923396675.csv');
const OUTPUT = process.argv[3] || path.join(__dirname, '..', 'data', 'stocks.json');

function parseCSV(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i+1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; }
    else { if (c === '"') q = true; else if (c === ',') { row.push(cell); cell = ''; }
      else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
      else if (c !== '\r') cell += c; }
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function num(s) {
  if (s == null) return null;
  let t = String(s).trim();
  if (!t || t === '-' || t === '---%' || t === '--------') return null;
  t = t.replace(/R\$\s*/g, '').replace(/US\$\s*/g, '').replace(/\s/g, '');
  const isPct = t.endsWith('%');
  if (isPct) t = t.slice(0, -1);
  if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
  const n = parseFloat(t);
  if (!isFinite(n)) return null;
  return isPct ? n / 100 : n;
}

const SECTOR_MAP = [
  [/BANCOS/i, 'Bancos'],
  [/SEGURADORAS|Insurance/i, 'Seguradoras'],
  [/ÓLEO E GÁS|OLEO E GAS/i, 'Petróleo e Gás'],
  [/UTILITIES|UTILIDADE/i, 'Utilities'],
  [/FARMAC|SAÚDE|SAUDE/i, 'Saúde'],
  [/BENS DE CONSUMO BÁSICO|NÃO CÍCLICO|NAO CICLICO|Staples/i, 'Consumo Básico'],
  [/TELECOM|COMUNICAÇ|COMUNICAC/i, 'Telecom'],
  [/INDUSTRIAIS|Industrials/i, 'Industriais'],
  [/MATERIAIS BÁSICOS|MATERIAIS BASICOS/i, 'Materiais Básicos'],
  [/AGRO|AGRÍCOLAS|AGRICOLAS/i, 'Agronegócio'],
  [/TECNOLOGIA|Info Tech/i, 'Tecnologia'],
  [/CONSUMO NÃO BÁSICO|Discretionary|CÍCLICO|CICLICO/i, 'Consumo Cíclico'],
  [/IMOBILIÁR|IMOBILIAR/i, 'Imobiliário'],
];

function detectSector(s) {
  if (!s) return null;
  for (const [rx, n] of SECTOR_MAP) if (rx.test(s)) return n;
  return null;
}

const raw = fs.readFileSync(INPUT, 'utf8');
const rows = parseCSV(raw);
const stocks = [];
const seen = new Set();
let currentSector = null;
const isIndexOrETF = t => /^(IFNC|FIND11|XLF|IXG|UTIL|IEE|XINA11|ICON11|XLE|IXC|OIH)$/i.test(t);

for (let i = 1; i < rows.length; i++) {
  const r = rows[i];
  const empresa = (r[0] || '').trim();
  const ativo = (r[1] || '').trim();
  const sec = detectSector(ativo);
  if (sec && !empresa) { currentSector = sec; continue; }
  if (!ativo || !/^[A-Z]{4}\d{1,2}$/.test(ativo)) continue;
  if (isIndexOrETF(ativo)) continue;
  if (r[6] == null || String(r[6]).trim() === '') continue;

  const key = `${currentSector}|${ativo}`;
  if (seen.has(key)) continue;
  seen.add(key);

  stocks.push({
    ativo,
    empresa: empresa.replace(/\s*\([^)]*\)\s*$/, '').trim(), // limpa descrições longas
    descricao_longa: empresa.includes('(') ? empresa : null,
    setor: currentSector,
    preco: num(r[2]),
    preco_minimo_52s: num(r[3]),
    patrimonio_liquido_bi: num(r[5]),
    roe: num(r[6]),
    lucro_bi: num(r[7]),
    payout: num(r[8]),
    dividendos_bi: num(r[9]),
    valor_mercado_bi: num(r[10]),
    p_vp: num(r[11]),
    p_l: num(r[12]),
    dy: num(r[13]),
    growth: num(r[14]),
    retorno: num(r[15]),
  });
}

const setoresCount = {};
for (const s of stocks) setoresCount[s.setor] = (setoresCount[s.setor] || 0) + 1;

const payload = {
  meta: {
    gerado_em: new Date().toISOString(),
    total_ativos: stocks.length,
    setores: setoresCount,
    fonte: 'Planilha "Análises" VRAI — snapshot inicial',
    versao: '1.0.0',
    aviso: 'Dados de snapshot. v2 trará atualização automática via brapi.dev + Fundamentus.',
  },
  stocks,
};

fs.writeFileSync(OUTPUT, JSON.stringify(payload, null, 2), 'utf8');
console.log(`Gerado ${OUTPUT} com ${stocks.length} ativos em ${Object.keys(setoresCount).length} setores.`);
