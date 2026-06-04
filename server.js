const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'db.json');

// Inicializar banco se não existir
if (!fs.existsSync(DB_FILE)) {
  fs.writeFileSync(DB_FILE, JSON.stringify({
    pedidos: [], estoque: [], rastreios: [], sobras: [], custos: null
  }));
}

function lerDB() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch(e) { return { pedidos:[], estoque:[], rastreios:[], sobras:[], custos:null }; }
}

function salvarDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

const server = http.createServer((req, res) => {
  const pathname = url.parse(req.url).pathname;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  // GET dados
  if (req.method === 'GET' && pathname === '/api/dados') {
    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(JSON.stringify(lerDB()));
    return;
  }

  // POST salvar
  if (req.method === 'POST' && pathname === '/api/salvar') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const db = lerDB();
        if (data.pedidos !== undefined) db.pedidos = data.pedidos;
        if (data.estoque !== undefined) db.estoque = data.estoque;
        if (data.rastreios !== undefined) db.rastreios = data.rastreios;
        if (data.sobras !== undefined) db.sobras = data.sobras;
        if (data.custos !== undefined) db.custos = data.custos;
        salvarDB(db);
        res.writeHead(200, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({ok: true}));
      } catch(e) {
        res.writeHead(400); res.end(JSON.stringify({erro: e.message}));
      }
    });
    return;
  }

  // Servir index.html (na raiz, sem pasta public)
  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    try {
      const html = fs.readFileSync(path.join(__dirname, 'index.html'));
      res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
      res.end(html);
    } catch(e) {
      res.writeHead(404); res.end('index.html não encontrado');
    }
    return;
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => {
  console.log('Orto Premium rodando na porta ' + PORT);
});
