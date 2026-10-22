// Ranking Mesa iFinc — placar mensal dos closers (rankingmesa.recomendaleads.com.br)
// Dados no Firestore: rankingmesa_closers (cadastro) e rankingmesa_lancamentos (um doc por dia+closer).
// Mesmo motor para a Head (rankinghead.recomendaleads.com.br): coleções rankinghead_*.
// Leitura do ranking é aberta (tela da TV); lançar e cadastrar exigem a senha do painel.
const fs = require('fs');
const path = require('path');

const CAMPOS = ['pastas_abertas', 'valor_abertas', 'pastas_fechadas', 'valor_fechadas', 'contratos', 'valor_contratos'];

const slug = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'closer';
const ehDia = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const ehMes = (s) => /^\d{4}-\d{2}$/.test(String(s || ''));
const num = (v) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : 0; };

// Carga inicial: closers da mesa e os números da planilha de 22/10/2026.
const SEMENTE_MESA = [
  ['Vinicius', 5, 1060000, 3, 470000, 0, 0],
  ['Jaqueline Ferreira da Silva', 6, 4390000, 0, 0, 0, 0],
  ['Lucas Rodrigues', 9, 1760000, 1, 350000, 0, 0],
  ['Amanda Mendes', 0, 0, 0, 0, 0, 0],
  ['Rogério Sousa Jordão Silva', 5, 1500000, 6, 1420000, 0, 0],
  ['Gabriel Biazebetti', 4, 650000, 5, 1045000, 0, 0],
  ['Reinaldo da Silva', 0, 0, 9, 4456000, 1, 106622.09],
  ['Juliana Gomes Rodrigues de Lima', 4, 15580000, 2, 345000, 0, 0],
  ['Eline Cristina Rossi Correa', 7, 20930000, 4, 1710000, 0, 0],
  ['Jonathan Araujo', 5, 1130000, 5, 1980000, 0, 0],
];

// Carga inicial da Head: último envio de cada vendedor na planilha de 22/10/2026.
const SEMENTE_HEAD = [
  ['Rafael', 14, 40141600, 15, 19960000, 1, 500000],
  ['Bryan', 22, 46500000, 3, 820000, 2, 3400000],
  ['Lucca Andrade', 17, 23575000, 9, 11450000, 1, 1135000],
];

const PAINEIS = [
  { slug: 'rankingmesa', host: 'rankingmesa.recomendaleads.com.br', titulo: 'Ranking de Closers', termo: 'Closer', termoPlural: 'Closers', senhaEnv: ['RANKINGMESA_SENHA'], semente: SEMENTE_MESA },
  { slug: 'rankinghead', host: 'rankinghead.recomendaleads.com.br', titulo: 'Ranking Head', termo: 'Vendedor', termoPlural: 'Vendedores', senhaEnv: ['RANKINGHEAD_SENHA', 'RANKINGMESA_SENHA'], semente: SEMENTE_HEAD },
];

module.exports = function montarRankings(app, db, rateLimit) {
  for (const cfg of PAINEIS) montarPainel(app, db, rateLimit, cfg);
};

function montarPainel(app, db, rateLimit, cfg) {
  const COL_CLOSERS = cfg.slug + '_closers';
  const COL_LANC = cfg.slug + '_lancamentos';
  const SEMENTE = cfg.semente;
  const senhaPainel = () => cfg.senhaEnv.map((k) => process.env[k]).find(Boolean);

  const HOST = cfg.host;
  const limiteSenha = rateLimit({ windowMs: 5 * 60 * 1000, max: 30, prefix: cfg.slug });
  const config = JSON.stringify({ api: '/api/' + cfg.slug, titulo: cfg.titulo, termo: cfg.termo, termoPlural: cfg.termoPlural }).replace(/</g, '\\u003c');
  const enviar = (res) => {
    const html = fs.readFileSync(path.join(__dirname, 'ranking-mesa.html'), 'utf8').replace('__RANKING_CONFIG__', config);
    res.type('html').set('Cache-Control', 'no-cache').send(html);
  };

  // Página: no subdomínio próprio e também em /rankingmesa
  app.get('/', (req, res, next) => (req.hostname === HOST ? enviar(res) : next()));
  app.get('/' + cfg.slug, (req, res) => enviar(res));
  // Área administrativa (lançar dia e cadastrar closers) em endereço separado da tela pública
  app.get('/admin', (req, res, next) => (req.hostname === HOST ? enviar(res) : next()));
  app.get('/' + cfg.slug + '/admin', (req, res) => enviar(res));

  const semDb = (res) => res.status(503).json({ erro: 'Banco de dados indisponível.' });
  const senhaOk = (req) => {
    const senha = senhaPainel();
    return !!senha && String((req.body && req.body.senha) || req.headers['x-ranking-senha'] || '') === senha;
  };
  const exigirSenha = (req, res) => {
    if (!senhaPainel()) { res.status(503).json({ erro: 'Senha de lançamento não configurada no servidor.' }); return false; }
    if (!senhaOk(req)) { res.status(401).json({ erro: 'Senha incorreta.' }); return false; }
    return true;
  };

  let semeado = false;
  async function garantirSemente() {
    if (semeado) return;
    const snap = await db.collection(COL_CLOSERS).limit(1).get();
    if (snap.empty) {
      const batch = db.batch();
      const agora = new Date().toISOString();
      for (const [nome, ...v] of SEMENTE) {
        const id = slug(nome);
        batch.set(db.collection(COL_CLOSERS).doc(id), { nome, ativo: true });
        const doc = { dia: '2026-10-22', mes: '2026-10', closerId: id, em: agora };
        CAMPOS.forEach((k, i) => { doc[k] = v[i]; });
        batch.set(db.collection(COL_LANC).doc('2026-10-22_' + id), doc);
      }
      await batch.commit();
    }
    semeado = true;
  }
  async function listarClosers() {
    const snap = await db.collection(COL_CLOSERS).get();
    return snap.docs.map((d) => ({ id: d.id, nome: d.data().nome, ativo: d.data().ativo !== false }))
      .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
  }
  async function lancMes(mes) {
    const snap = await db.collection(COL_LANC).where('mes', '==', mes).get();
    return snap.docs.map((d) => d.data());
  }

  // Ranking acumulado do mês
  app.get('/api/' + cfg.slug + '/ranking', async (req, res) => {
    if (!db) return semDb(res);
    const mes = ehMes(req.query.mes) ? req.query.mes : new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' }).slice(0, 7);
    try {
      await garantirSemente();
      const [closers, lanc] = await Promise.all([listarClosers(), lancMes(mes)]);
      const mapa = new Map(closers.filter((c) => c.ativo).map((c) => [c.id, { closer: c.nome, ...Object.fromEntries(CAMPOS.map((k) => [k, 0])) }]));
      for (const l of lanc) { const r = mapa.get(l.closerId); if (r) CAMPOS.forEach((k) => { r[k] += Number(l[k]) || 0; }); }
      const linhas = [...mapa.values()].map((r) => { CAMPOS.forEach((k) => { r[k] = Math.round(r[k] * 100) / 100; }); return r; })
        .sort((a, b) => b.valor_contratos - a.valor_contratos || b.pastas_fechadas - a.pastas_fechadas || b.valor_fechadas - a.valor_fechadas
          || b.pastas_abertas - a.pastas_abertas || b.valor_abertas - a.valor_abertas || a.closer.localeCompare(b.closer, 'pt-BR'));
      const dias = [...new Set(lanc.map((l) => l.dia))].sort();
      res.set('Cache-Control', 'no-store').json({ mes, linhas, dias });
    } catch (e) { console.error('[' + cfg.slug + '] ranking', e.message); res.status(500).json({ erro: 'Não foi possível montar o ranking.' }); }
  });

  // Confere a senha (para liberar as abas de lançamento)
  app.post('/api/' + cfg.slug + '/entrar', limiteSenha, (req, res) => { if (exigirSenha(req, res)) res.json({ ok: true }); });

  // Números de um dia
  app.get('/api/' + cfg.slug + '/dia', async (req, res) => {
    if (!db) return semDb(res);
    if (!ehDia(req.query.dia)) return res.status(400).json({ erro: 'Data inválida.' });
    try {
      await garantirSemente();
      const dia = req.query.dia;
      const [closers, lanc] = await Promise.all([listarClosers(), lancMes(dia.slice(0, 7))]);
      const valores = {};
      lanc.filter((l) => l.dia === dia).forEach((l) => { valores[l.closerId] = Object.fromEntries(CAMPOS.map((k) => [k, l[k]])); });
      res.set('Cache-Control', 'no-store').json({ dia, closers: closers.filter((c) => c.ativo), valores, diasMes: [...new Set(lanc.map((l) => l.dia))].sort() });
    } catch (e) { console.error('[' + cfg.slug + '] dia', e.message); res.status(500).json({ erro: 'Não foi possível ler o dia.' }); }
  });

  // Salva um dia: { senha, dia, linhas: [{closerId, pastas_abertas, ...}] } — linha sem valores apaga o lançamento
  app.post('/api/' + cfg.slug + '/dia', limiteSenha, async (req, res) => {
    if (!db) return semDb(res);
    if (!exigirSenha(req, res)) return;
    const { dia, linhas } = req.body || {};
    if (!ehDia(dia) || !Array.isArray(linhas) || linhas.length > 200) return res.status(400).json({ erro: 'Dados inválidos.' });
    try {
      const ids = new Set((await listarClosers()).map((c) => c.id));
      const batch = db.batch();
      const agora = new Date().toISOString();
      for (const l of linhas) {
        if (!ids.has(l.closerId)) continue;
        const ref = db.collection(COL_LANC).doc(dia + '_' + l.closerId);
        const vazio = CAMPOS.every((k) => l[k] === null || l[k] === undefined || l[k] === '');
        if (vazio) { batch.delete(ref); continue; }
        const doc = { dia, mes: dia.slice(0, 7), closerId: l.closerId, em: agora };
        CAMPOS.forEach((k) => { doc[k] = num(l[k]); });
        batch.set(ref, doc);
      }
      await batch.commit();
      res.json({ ok: true });
    } catch (e) { console.error('[' + cfg.slug + '] salvar', e.message); res.status(500).json({ erro: 'Não foi possível salvar.' }); }
  });

  // Closers: listar (com senha), adicionar, renomear, ativar/desativar
  app.post('/api/' + cfg.slug + '/closers/listar', limiteSenha, async (req, res) => {
    if (!db) return semDb(res);
    if (!exigirSenha(req, res)) return;
    try { await garantirSemente(); res.json({ closers: await listarClosers() }); }
    catch (e) { res.status(500).json({ erro: 'Não foi possível listar.' }); }
  });
  app.post('/api/' + cfg.slug + '/closers', limiteSenha, async (req, res) => {
    if (!db) return semDb(res);
    if (!exigirSenha(req, res)) return;
    const { id, nome, ativo } = req.body || {};
    try {
      if (id) {
        const upd = {};
        if (typeof nome === 'string' && nome.trim()) upd.nome = nome.trim().slice(0, 80);
        if (typeof ativo === 'boolean') upd.ativo = ativo;
        await db.collection(COL_CLOSERS).doc(String(id)).update(upd);
      } else {
        const n = String(nome || '').trim().slice(0, 80);
        if (!n) return res.status(400).json({ erro: 'Informe o nome.' });
        let novoId = slug(n);
        if ((await db.collection(COL_CLOSERS).doc(novoId).get()).exists) novoId += '-' + Date.now().toString(36).slice(-4);
        await db.collection(COL_CLOSERS).doc(novoId).set({ nome: n, ativo: true });
      }
      res.json({ ok: true, closers: await listarClosers() });
    } catch (e) { console.error('[' + cfg.slug + '] closers', e.message); res.status(500).json({ erro: 'Não foi possível salvar.' }); }
  });
}
