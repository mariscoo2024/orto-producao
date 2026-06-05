const express = require('express');
const fs = require('fs');
const path = require('path');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

// ── JSONBin.io como banco de dados persistente ───────────────────────────────
// Variáveis de ambiente configuradas no Railway:
//   JSONBIN_BIN_ID  — ID do bin (criado automaticamente na 1a vez)
//   JSONBIN_API_KEY — sua chave da API do jsonbin.io
const BIN_ID  = process.env.JSONBIN_BIN_ID  || '';
const API_KEY = process.env.JSONBIN_API_KEY || '';
const USE_JSONBIN = BIN_ID && API_KEY;

// Fallback local se variáveis não configuradas ainda
const DB_FILE = path.join(__dirname, 'db.json');

function dbVazio() {
  return { pedidos:[], rastreios:[], estoque:[], sobras:[], movHist:{}, custos:{} };
}

// ── Helpers JSONBin ──────────────────────────────────────────────────────────
function jsonbinRequest(method, body) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.jsonbin.io',
      path: `/v3/b/${BIN_ID}`,
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Master-Key': API_KEY,
        'X-Bin-Versioning': 'false'
      }
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function lerDB() {
  if (!USE_JSONBIN) {
    try { return JSON.parse(fs.readFileSync(DB_FILE,'utf8')); } catch(e) { return dbVazio(); }
  }
  try {
    const r = await jsonbinRequest('GET');
    return r.record || dbVazio();
  } catch(e) { return dbVazio(); }
}

async function salvarDB(db) {
  if (!USE_JSONBIN) {
    fs.writeFileSync(DB_FILE, JSON.stringify(db,null,2),'utf8');
    return;
  }
  await jsonbinRequest('PUT', db);
}

// ── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ── API: GET tudo ────────────────────────────────────────────────────────────
app.get('/api/dados', async (req, res) => {
  try { res.json(await lerDB()); }
  catch(e) { res.status(500).json({ erro: e.message }); }
});

// ── API: SALVAR parcial ───────────────────────────────────────────────────────
app.post('/api/salvar', async (req, res) => {
  try {
    const db = await lerDB();
    const body = req.body;
    if (body.pedidos   !== undefined) db.pedidos   = body.pedidos;
    if (body.rastreios !== undefined) db.rastreios = body.rastreios;
    if (body.estoque   !== undefined) db.estoque   = body.estoque;
    if (body.sobras    !== undefined) db.sobras    = body.sobras;
    if (body.movHist   !== undefined) db.movHist   = body.movHist;
    if (body.custos    !== undefined) db.custos    = body.custos;
    await salvarDB(db);
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ ok: false, erro: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`Orto Premium rodando na porta ${PORT}`);
  console.log(`Banco: ${USE_JSONBIN ? 'JSONBin.io (persistente ✅)' : 'arquivo local (temporário ⚠️)'}`);
});
