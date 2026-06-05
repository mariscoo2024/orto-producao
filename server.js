const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'db.json');

// ── Banco de dados em arquivo JSON ──────────────────────────────────────────
function lerDB() {
  try {
    if (!fs.existsSync(DB_FILE)) return dbVazio();
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch(e) { return dbVazio(); }
}

function salvarDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
}

function dbVazio() {
  return { pedidos:[], rastreios:[], estoque:[], sobras:[], movHist:{}, custos:{} };
}

// ── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));

// ── Servir index.html na raiz (sem pasta public) ─────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ── API: GET tudo ────────────────────────────────────────────────────────────
app.get('/api/dados', (req, res) => {
  res.json(lerDB());
});

// ── API: SALVAR parcial ───────────────────────────────────────────────────────
app.post('/api/salvar', (req, res) => {
  try {
    const db = lerDB();
    const body = req.body;
    if (body.pedidos   !== undefined) db.pedidos   = body.pedidos;
    if (body.rastreios !== undefined) db.rastreios = body.rastreios;
    if (body.estoque   !== undefined) db.estoque   = body.estoque;
    if (body.sobras    !== undefined) db.sobras    = body.sobras;
    if (body.movHist   !== undefined) db.movHist   = body.movHist;
    if (body.custos    !== undefined) db.custos    = body.custos;
    salvarDB(db);
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ ok: false, erro: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`Orto Premium rodando na porta ${PORT}`);
});
