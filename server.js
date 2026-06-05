const express = require('express');
const fs = require('fs');
const path = require('path');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Configurações ─────────────────────────────────────────────────────────────
const BIN_ID        = process.env.JSONBIN_BIN_ID  || '';
const API_KEY       = process.env.JSONBIN_API_KEY || '';
const USE_JSONBIN   = BIN_ID && API_KEY;
const DB_FILE       = path.join(__dirname, 'db.json');

const BLING_CLIENT_ID     = process.env.BLING_CLIENT_ID     || 'dbbfe20eaf3be5e064af5fd8c806c550885d1aa9';
const BLING_CLIENT_SECRET = process.env.BLING_CLIENT_SECRET || '78d4b62b4a9a2b1b0ee95705d2d20f08cf910c0e974e249428a58aac3878';
const BLING_REDIRECT_URI  = process.env.BLING_REDIRECT_URI  || 'https://orto-producao-production.up.railway.app/auth/bling/callback';

// Token Bling em memória (persiste no db.json também)
let blingToken = { access_token:'', refresh_token:'', expires_at:0 };

// ── JSONBin helpers ───────────────────────────────────────────────────────────
function dbVazio() {
  return { pedidos:[], rastreios:[], estoque:[], sobras:[], movHist:{}, custos:{}, blingToken:{} };
}

function jsonbinRequest(method, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const options = {
      hostname: 'api.jsonbin.io',
      path: `/v3/b/${BIN_ID}`,
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Master-Key': API_KEY,
        'X-Bin-Versioning': 'false',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {})
      }
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function lerDB() {
  if (!USE_JSONBIN) {
    try { return JSON.parse(fs.readFileSync(DB_FILE,'utf8')); } catch(e) { return dbVazio(); }
  }
  try { const r = await jsonbinRequest('GET'); return r.record || dbVazio(); }
  catch(e) { return dbVazio(); }
}

async function salvarDB(db) {
  if (!USE_JSONBIN) { fs.writeFileSync(DB_FILE, JSON.stringify(db,null,2),'utf8'); return; }
  await jsonbinRequest('PUT', db);
}

// ── Bling OAuth helpers ───────────────────────────────────────────────────────
function httpsPost(hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const payload = typeof body === 'string' ? body : JSON.stringify(body);
    const options = { hostname, path, method:'POST',
      headers: { ...headers, 'Content-Length': Buffer.byteLength(payload) }
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { resolve(data); } });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function httpsGet(hostname, path, headers) {
  return new Promise((resolve, reject) => {
    const options = { hostname, path, method:'GET', headers };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { resolve(data); } });
    });
    req.on('error', reject);
    req.end();
  });
}

async function refreshBlingToken() {
  if (!blingToken.refresh_token) return false;
  try {
    const creds = Buffer.from(`${BLING_CLIENT_ID}:${BLING_CLIENT_SECRET}`).toString('base64');
    const body = `grant_type=refresh_token&refresh_token=${blingToken.refresh_token}`;
    const data = await httpsPost('www.bling.com.br', '/Api/v3/oauth/token',
      { 'Authorization': `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body);
    if (data.access_token) {
      blingToken = { access_token: data.access_token, refresh_token: data.refresh_token || blingToken.refresh_token,
        expires_at: Date.now() + (data.expires_in || 3600) * 1000 };
      // Persistir token no banco
      const db = await lerDB();
      db.blingToken = blingToken;
      await salvarDB(db);
      return true;
    }
    return false;
  } catch(e) { console.error('Refresh token falhou:', e.message); return false; }
}

async function getBlingToken() {
  if (blingToken.access_token && Date.now() < blingToken.expires_at - 60000) return blingToken.access_token;
  if (blingToken.refresh_token) {
    const ok = await refreshBlingToken();
    if (ok) return blingToken.access_token;
  }
  return null;
}

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));

// Servir arquivos estáticos
app.use(express.static(path.join(__dirname)));

// Rota raiz
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ── OAuth: iniciar login Bling ────────────────────────────────────────────────
app.get('/auth/bling', (req, res) => {
  const state = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const url = `https://www.bling.com.br/Api/v3/oauth/authorize?response_type=code&client_id=${BLING_CLIENT_ID}&redirect_uri=${encodeURIComponent(BLING_REDIRECT_URI)}&state=${state}`;
  res.redirect(url);
});

// ── OAuth: callback do Bling ──────────────────────────────────────────────────
app.get('/auth/bling/callback', async (req, res) => {
  const { code, error, error_description } = req.query;
  console.log('Bling callback recebido:', req.query);
  if (error) return res.send('<h2>Erro do Bling: '+error+'</h2><p>'+( error_description||'')+'</p>');
  if (!code) return res.send('<h2>Parâmetros recebidos:</h2><pre>'+JSON.stringify(req.query,null,2)+'</pre><p>Código não encontrado.</p>');
  try {
    const creds = Buffer.from(`${BLING_CLIENT_ID}:${BLING_CLIENT_SECRET}`).toString('base64');
    const body = `grant_type=authorization_code&code=${code}&redirect_uri=${encodeURIComponent(BLING_REDIRECT_URI)}`;
    const data = await httpsPost('www.bling.com.br', '/Api/v3/oauth/token',
      { 'Authorization': `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body);
    if (data.access_token) {
      blingToken = { access_token: data.access_token, refresh_token: data.refresh_token,
        expires_at: Date.now() + (data.expires_in || 3600) * 1000 };
      const db = await lerDB();
      db.blingToken = blingToken;
      await salvarDB(db);
      res.send('<h2>✅ Bling conectado com sucesso!</h2><p>Pode fechar esta aba e voltar ao sistema.</p><script>setTimeout(()=>window.close(),2000)</script>');
    } else {
      res.send('<h2>❌ Erro ao conectar: ' + JSON.stringify(data) + '</h2>');
    }
  } catch(e) { res.send('<h2>Erro: ' + e.message + '</h2>'); }
});

// ── API: status do Bling ──────────────────────────────────────────────────────
app.get('/api/bling/status', (req, res) => {
  res.json({
    conectado: !!(blingToken.access_token && Date.now() < blingToken.expires_at),
    expira: blingToken.expires_at ? new Date(blingToken.expires_at).toLocaleString('pt-BR') : null
  });
});

// ── Parser de pedidos Bling (server-side) ─────────────────────────────────────
function parsearPedidoBling(p) {
  const numPedido = String(p.numero || p.id);
  const cliente = p.contato?.nome || '';
  const endereco = p.transporte?.enderecoEntrega;
  const cidade = (endereco?.municipio || '').trim();
  const estado = (endereco?.uf || '').trim().toUpperCase();
  const endStr = endereco
    ? [endereco.endereco, endereco.numero, endereco.bairro].filter(Boolean).join(', ') + ` - ${cidade}/${estado} - CEP: ${endereco.cep||''}`
    : '';
  const cidadeExib = cidade && estado ? `${cidade}/${estado}` : cidade;
  const valor = parseFloat(p.totalVenda || p.total || 0);

  // Formatar datas: API retorna "yyyy-mm-dd" → converter para "dd/mm/yyyy"
  const fmtData = (s) => {
    if (!s) return '';
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? `${m[3]}/${m[2]}/${m[1]}` : s;
  };
  const prazo = fmtData(p.dataPrevisao || p.dataPrevista || '');
  const compra = fmtData(p.data || p.dataCriacao || '');

  // Montar descrição completa dos itens
  const itens = (p.itens || []).map(i => {
    const desc = i.descricao || i.produto?.descricao || '';
    const qtd = parseFloat(i.quantidade || 1);
    return qtd > 1 ? `${desc} (x${qtd})` : desc;
  }).join(' + ');

  // Extrair modelo do texto
  const txt = itens.toUpperCase();
  const isPres = /PRESIDENTIAL\s*MOLAS/i.test(itens);
  const sizes = [
    {r:/193\s*X\s*203/i, v:'King 193x203'},
    {r:/158\s*X\s*198/i, v:'Queen 158x198'},
    {r:/138\s*X\s*188/i, v:'Casal 138x188'},
    {r:/128\s*X\s*188/i, v:'Viúva 128x188'},
    {r:/088\s*X\s*188/i, v:'Solteiro 088x188'},
    {r:/88\s*X\s*188/i,  v:'Solteiro 088x188'},
  ];
  let modelo = '';
  for (const s of sizes) { if (s.r.test(itens)) { modelo = (isPres?'Presidential Molas ':'')+s.v; break; } }
  if (!modelo) modelo = itens.slice(0,80);

  // Kit
  const kitsR = [
    {r:/ELEGANCE\s+CROMOTERAPIA/i, v:'Elegance Cromoterapia'},
    {r:/ELEGANCE\s+SINGLE/i,       v:'Elegance Single'},
    {r:/CROMOTERAPIA/i,            v:'Cromoterapia'},
    {r:/SINGLE/i,             v:'Single'},
  ];
  let kit = '';
  for (const k of kitsR) { if (k.r.test(itens)) { kit = k.v; break; } }

  // Cor — pega o que está entre parênteses
  const corM = itens.match(/\(([A-ZÁÀÂÃÉÊÍÓÔÕÚÜÇ\s]+)\)/);
  let cor = corM ? corM[1].trim() : '';
  const coresValidas = ['CINZA','PRETO','BEGE','MARROM','TABACO','BRANCO','CAFE','NUDE'];
  if (!coresValidas.includes(cor.toUpperCase())) cor = '';
  else cor = cor.charAt(0).toUpperCase() + cor.slice(1).toLowerCase();

  // Terceiros
  const t2 = [];
  if (/BOX\s*BA[ÚU]/i.test(itens)) t2.push('BASE BOX BAÚ');
  else if (/BASE\s*BOX/i.test(itens)) t2.push('BASE BOX');
  if (/CABECEIRA/i.test(itens)) t2.push('CABECEIRA');
  if (/RECAMIER/i.test(itens)) t2.push('RECAMIER');
  if (/TRAVESSEIRO/i.test(itens)) t2.push('TRAVESSEIROS');
  if (/PULSEIRA/i.test(itens)) t2.push('PULSEIRA');

  // Freteiro por cidade/estado
  const c = cidade.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'');
  const arw = ['curitiba','sao jose dos pinhais','colombo','araucaria','almirante tamandare','campo largo','pinhais','piraquara','fazenda rio grande'];
  let freteiro = '';
  if (arw.some(x => c.includes(x))) freteiro = 'ARW';
  else if (estado === 'SC') freteiro = 'GUILHERME SC';
  else if (estado === 'SP') freteiro = 'GUILHERME SP';
  else if (estado === 'RS') freteiro = 'WALDECI-SP';
  else if (['PONTA GROSSA','CASTRO','TELEMACO BORBA','TIBAGI','CARAMBEÍ'].some(x => c.includes(x.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'')))) freteiro = 'JOEL';

  // Forma de pagamento
  const obs = (p.observacoes || '').toUpperCase();
  let formaPagto = 'pix';
  if (/12X|12\s*VEZES/i.test(obs+itens)) formaPagto = 'credito12';
  else if (/10X|10\s*VEZES/i.test(obs+itens)) formaPagto = 'credito10';
  else if (/6X|6\s*VEZES/i.test(obs+itens)) formaPagto = 'credito6';
  else if (/3X|3\s*VEZES/i.test(obs+itens)) formaPagto = 'credito3';

  return {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2,5) + numPedido,
    pedidoNum: numPedido,
    nome: cliente,
    modelo,
    kit,
    cor,
    terceiro: t2.join(' + '),
    freteiro,
    costureiro: 'ORTO PREMIUM',
    status: 'pendente',
    valor,
    prazo,
    compra,
    end: endStr,
    cidadeExib,
    obs: p.observacoes || '',
    formaPagto,
    origem: 'bling_api',
    importadoEm: new Date().toISOString()
  };
}

// ── API: sincronizar pedidos do Bling ─────────────────────────────────────────
app.get('/api/bling/sync', async (req, res) => {
  const token = await getBlingToken();
  if (!token) return res.status(401).json({ ok:false, erro:'Bling não conectado. Acesse /auth/bling para autorizar.' });

  try {
    const data = await httpsGet('www.bling.com.br',
      '/Api/v3/pedidos/vendas?limite=100&pagina=1&idsSituacoes[]=6&idsSituacoes[]=9&idsSituacoes[]=15',
      { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' });

    if (!data.data) return res.json({ ok:false, erro: 'Resposta inesperada do Bling', raw: data });

    const db = await lerDB();
    let novos = 0, atualizados = 0;

    for (const pedBling of data.data) {
      const det = await httpsGet('www.bling.com.br', `/Api/v3/pedidos/vendas/${pedBling.id}`,
        { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' });
      if (!det.data) continue;

      const numPedido = String(det.data.numero || det.data.id);
      const jaExiste = db.pedidos.find(x => x.pedidoNum === numPedido);
      if (jaExiste) { atualizados++; continue; }

      db.pedidos.push(parsearPedidoBling(det.data));
      novos++;
    }

    if (novos > 0) await salvarDB(db);
    res.json({ ok:true, novos, atualizados, total: data.data.length });
  } catch(e) {
    res.status(500).json({ ok:false, erro: e.message });
  }
});

// ── API dados / salvar (igual antes) ─────────────────────────────────────────
app.get('/api/dados', async (req, res) => {
  try {
    const db = await lerDB();
    // Restaurar token do banco se em memória estiver vazio
    if (!blingToken.access_token && db.blingToken?.access_token) {
      blingToken = db.blingToken;
    }
    res.json(db);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

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
  } catch(e) { res.status(500).json({ ok: false, erro: e.message }); }
});

// Catch-all — serve index.html para qualquer rota não reconhecida (deve ficar no final!)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Orto Premium rodando na porta ${PORT}`);
  console.log(`Banco: ${USE_JSONBIN ? 'JSONBin.io ✅' : 'local ⚠️'}`);
});
