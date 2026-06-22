<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Minha Empresa — RecomendaLeads</title>
<style>
  :root {
    --navy: #0a1628;
    --navy-light: #132338;
    --gold: #d4af37;
    --gold-light: #f0d878;
    --text: #e8edf4;
    --text-dim: #9aabc0;
    --success: #3ddc97;
    --error: #ff6b6b;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
    background: linear-gradient(160deg, var(--navy) 0%, #060d18 100%);
    color: var(--text);
    min-height: 100vh;
    padding: 24px 16px 60px;
  }
  .wrap { max-width: 760px; margin: 0 auto; }
  header { text-align: center; margin-bottom: 32px; }
  header h1 { font-size: 1.5rem; margin: 0 0 6px; color: var(--gold-light); }
  header p { color: var(--text-dim); margin: 0; font-size: 0.9rem; }

  .top-bar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 24px;
    font-size: 0.85rem;
    color: var(--text-dim);
  }
  .logout-btn {
    background: transparent;
    border: 1px solid rgba(255,107,107,0.3);
    color: var(--error);
    padding: 6px 14px;
    border-radius: 8px;
    cursor: pointer;
    font-size: 0.8rem;
  }
  .logout-btn:hover { background: rgba(255,107,107,0.08); }

  .card {
    background: var(--navy-light);
    border: 1px solid rgba(212,175,55,0.18);
    border-radius: 14px;
    padding: 22px;
    margin-bottom: 20px;
  }
  .card h2 { font-size: 1.05rem; margin: 0 0 14px; color: var(--text); }
  label { display: block; font-size: 0.82rem; color: var(--text-dim); margin: 12px 0 5px; }
  input[type="text"], textarea {
    width: 100%;
    background: #0e1a2c;
    border: 1px solid rgba(255,255,255,0.12);
    border-radius: 8px;
    padding: 10px 12px;
    color: var(--text);
    font-size: 0.92rem;
    font-family: inherit;
    resize: vertical;
  }
  input:focus, textarea:focus { outline: none; border-color: var(--gold); }
  .hint { font-size: 0.76rem; color: var(--text-dim); margin-top: 4px; opacity: 0.8; }
  .row-save { display: flex; align-items: center; gap: 12px; margin-top: 16px; }
  button.save-btn {
    background: var(--gold);
    color: var(--navy);
    border: none;
    font-weight: 700;
    font-size: 0.9rem;
    padding: 10px 20px;
    border-radius: 8px;
    cursor: pointer;
  }
  button.save-btn:hover { opacity: 0.92; }
  button.save-btn:disabled { opacity: 0.5; cursor: default; }
  .status-msg { font-size: 0.85rem; font-weight: 600; }
  .status-msg.ok { color: var(--success); }
  .status-msg.err { color: var(--error); }

  .card-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
  .badge { background: var(--gold); color: var(--navy); font-weight: 700; font-size: 0.85rem; padding: 4px 12px; border-radius: 20px; }

  .load-msg { text-align: center; color: var(--text-dim); padding: 40px; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>⚙️ Minha Empresa</h1>
    <p>Configurações protegidas por login — etapa de teste.</p>
  </header>

  <div class="top-bar">
    <span id="empresaLogadaNome">Carregando...</span>
    <button class="logout-btn" id="logoutBtn">Sair</button>
  </div>

  <div id="loadMsg" class="load-msg">Carregando configuração...</div>

  <div id="conteudo" style="display:none">
    <div class="card">
      <h2>Dados da empresa</h2>

      <label>Nome da empresa</label>
      <input type="text" id="empresaNomeInput">

      <label>Mensagem de agradecimento (primeira mensagem enviada ao cliente)</label>
      <textarea id="empresaMsgInput" rows="2"></textarea>

      <label>Vendedores (um por linha)</label>
      <textarea id="empresaVendedoresInput" rows="4"></textarea>

      <div class="row-save">
        <button class="save-btn" id="salvarEmpresaBtn">Salvar dados da empresa</button>
        <span class="status-msg" id="statusEmpresa"></span>
      </div>
    </div>

    <div id="faixasContainer"></div>
  </div>
</div>

<script>
const API_BASE = window.location.origin;
const TOKEN = localStorage.getItem('recomendaleads_token');

if (!TOKEN) {
  window.location.href = '/login';
}

async function fetchAutenticado(url, options = {}) {
  const resp = await fetch(url, {
    ...options,
    headers: { ...(options.headers || {}), 'Authorization': `Bearer ${TOKEN}` }
  });
  if (resp.status === 401) {
    localStorage.removeItem('recomendaleads_token');
    localStorage.removeItem('recomendaleads_empresa');
    window.location.href = '/login';
    throw new Error('Sessão expirada');
  }
  return resp;
}

let configuracaoAtual = null;

async function carregarConfiguracao() {
  const loadMsg = document.getElementById('loadMsg');
  try {
    const resp = await fetchAutenticado(`${API_BASE}/minha-config`);
    const data = await resp.json();

    if (!resp.ok || !data.ok) throw new Error(data.erro || 'Falha ao carregar configuração');

    configuracaoAtual = data.empresa;
    loadMsg.style.display = 'none';
    document.getElementById('conteudo').style.display = 'block';

    const empresaSalva = JSON.parse(localStorage.getItem('recomendaleads_empresa') || '{}');
    document.getElementById('empresaLogadaNome').textContent = `Logado como: ${empresaSalva.nome || configuracaoAtual.nome}`;

    document.getElementById('empresaNomeInput').value = configuracaoAtual.nome || '';
    document.getElementById('empresaMsgInput').value = configuracaoAtual.mensagemAgradecimento || '';
    document.getElementById('empresaVendedoresInput').value = (configuracaoAtual.vendedores || []).join('\n');

    renderFaixas(configuracaoAtual.faixasBonus || []);
  } catch (err) {
    loadMsg.textContent = 'Não foi possível carregar a configuração.';
  }
}

document.getElementById('salvarEmpresaBtn').addEventListener('click', async () => {
  const btn = document.getElementById('salvarEmpresaBtn');
  const statusEl = document.getElementById('statusEmpresa');

  const nome = document.getElementById('empresaNomeInput').value.trim();
  const mensagemAgradecimento = document.getElementById('empresaMsgInput').value.trim();
  const vendedores = document.getElementById('empresaVendedoresInput').value
    .split('\n').map(v => v.trim()).filter(v => v.length > 0);

  btn.disabled = true;
  statusEl.textContent = 'Salvando...';
  statusEl.className = 'status-msg';

  try {
    const resp = await fetchAutenticado(`${API_BASE}/minha-config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nome, mensagemAgradecimento, vendedores })
    });
    const data = await resp.json();

    if (resp.ok && data.ok) {
      statusEl.textContent = '✅ Salvo!';
      statusEl.className = 'status-msg ok';
      configuracaoAtual = data.empresa;
    } else {
      statusEl.textContent = '❌ ' + (data.erro || 'Erro ao salvar');
      statusEl.className = 'status-msg err';
    }
  } catch (err) {
    statusEl.textContent = '❌ Erro de conexão';
    statusEl.className = 'status-msg err';
  } finally {
    btn.disabled = false;
    setTimeout(() => { statusEl.textContent = ''; statusEl.className = 'status-msg'; }, 4000);
  }
});

function renderFaixas(faixas) {
  const container = document.getElementById('faixasContainer');
  container.innerHTML = '';

  faixas.forEach((faixa) => {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      <div class="card-head">
        <h2>${faixa.premio}</h2>
        <span class="badge">${faixa.quantidade} recomendações</span>
      </div>
      <label>Prêmio (texto curto mostrado ao cliente)</label>
      <input type="text" data-field="premio" value="${(faixa.premio || '').replace(/"/g, '&quot;')}">
      <label>Arquivo (link do Google Drive)</label>
      <input type="text" data-field="arquivo" value="${(faixa.arquivo || '').replace(/"/g, '&quot;')}" placeholder="https://drive.google.com/file/d/...">
      <label>Link</label>
      <input type="text" data-field="link" value="${(faixa.link || '').replace(/"/g, '&quot;')}" placeholder="https://...">
      <label>Texto de orientação</label>
      <textarea data-field="texto" rows="3">${faixa.texto || ''}</textarea>
      <div class="row-save">
        <button class="save-btn" data-quantidade="${faixa.quantidade}">Salvar faixa de ${faixa.quantidade}</button>
        <span class="status-msg" data-statusfor="${faixa.quantidade}"></span>
      </div>
    `;
    container.appendChild(card);
  });

  container.querySelectorAll('.save-btn').forEach(btn => {
    btn.addEventListener('click', () => salvarFaixa(btn));
  });
}

async function salvarFaixa(btn) {
  const quantidade = parseInt(btn.dataset.quantidade);
  const card = btn.closest('.card');
  const statusEl = card.querySelector(`[data-statusfor="${quantidade}"]`);

  const premio = card.querySelector('[data-field="premio"]').value.trim();
  const arquivo = card.querySelector('[data-field="arquivo"]').value.trim() || null;
  const link = card.querySelector('[data-field="link"]').value.trim() || null;
  const texto = card.querySelector('[data-field="texto"]').value.trim() || null;

  btn.disabled = true;
  statusEl.textContent = 'Salvando...';
  statusEl.className = 'status-msg';

  try {
    const resp = await fetchAutenticado(`${API_BASE}/minha-config/faixa`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quantidade, premio, arquivo, link, texto })
    });
    const data = await resp.json();

    if (resp.ok && data.ok) {
      statusEl.textContent = '✅ Salvo!';
      statusEl.className = 'status-msg ok';
    } else {
      statusEl.textContent = '❌ ' + (data.erro || 'Erro ao salvar');
      statusEl.className = 'status-msg err';
    }
  } catch (err) {
    statusEl.textContent = '❌ Erro de conexão';
    statusEl.className = 'status-msg err';
  } finally {
    btn.disabled = false;
    setTimeout(() => { statusEl.textContent = ''; statusEl.className = 'status-msg'; }, 4000);
  }
}

document.getElementById('logoutBtn').addEventListener('click', () => {
  localStorage.removeItem('recomendaleads_token');
  localStorage.removeItem('recomendaleads_empresa');
  window.location.href = '/login';
});

carregarConfiguracao();
</script>
</body>
</html>
