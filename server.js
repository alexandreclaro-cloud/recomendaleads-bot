// ============================================================
// RECOMENDALEADS BOT — Servidor de automação via Z-API
// ============================================================
// Este servidor recebe mensagens do WhatsApp via webhook da Z-API
// e conduz o roteiro de neurovendas do Método Poder da Recomendação.

const express = require('express');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// ============================================================
// CONFIGURAÇÃO — preencher com os dados da sua instância Z-API
// ============================================================
const ZAPI_INSTANCE_ID = process.env.ZAPI_INSTANCE_ID || 'COLOQUE_SEU_ID_AQUI';
const ZAPI_TOKEN = process.env.ZAPI_TOKEN || 'COLOQUE_SEU_TOKEN_AQUI';
const ZAPI_CLIENT_TOKEN = process.env.ZAPI_CLIENT_TOKEN || 'COLOQUE_SEU_CLIENT_TOKEN_AQUI';
const ZAPI_BASE_URL = `https://api.z-api.io/instances/${ZAPI_INSTANCE_ID}/token/${ZAPI_TOKEN}`;

// ============================================================
// BANCO DE DADOS SIMPLES EM ARQUIVO (db.json)
// ============================================================
const DB_PATH = path.join(__dirname, 'db.json');

function loadDB() {
  if (!fs.existsSync(DB_PATH)) {
    const seed = {
      empresa: {
        nome: 'Empresa Demo',
        mensagemAgradecimento: 'Olá! Muito obrigado por ser nosso cliente e confiar no nosso trabalho. 🙏',
        vendedores: ['Carla Mendes', 'Roberto Lima', 'Juliana Alves'],
        faixasBonus: [
          { quantidade: 5, premio: 'Cupom de 10% de desconto na próxima compra' },
          { quantidade: 10, premio: 'Brinde exclusivo + 15% de desconto' },
          { quantidade: 15, premio: 'Vale-presente de R$ 50' },
          { quantidade: 20, premio: 'Status de Embaixador + kit especial' }
        ],
        premioRecomendado: 'Desconto de 10% na primeira compra, cortesia de quem te recomendou',
        ctaRecomendado: 'Gostaria de vir retirar?',
        tempoEsperaConversaoMin: 60,
        tempoFollowupMin: 30
      },
      sessoes: {} // chave: telefone do cliente -> estado da conversa
    };
    fs.writeFileSync(DB_PATH, JSON.stringify(seed, null, 2));
    return seed;
  }
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
}

function saveDB(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

let DB = loadDB();

// ============================================================
// HELPERS DE ENVIO — Z-API
// ============================================================

async function sendText(phone, message) {
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (ZAPI_CLIENT_TOKEN && ZAPI_CLIENT_TOKEN !== 'COLOQUE_SEU_CLIENT_TOKEN_AQUI') {
      headers['Client-Token'] = ZAPI_CLIENT_TOKEN;
    }
    await axios.post(`${ZAPI_BASE_URL}/send-text`, { phone, message }, { headers });
    console.log(`[ENVIADO] para ${phone}: ${message.slice(0, 60)}...`);
  } catch (err) {
    console.error('Erro ao enviar texto:', err.response?.data || err.message);
  }
}

async function sendDocument(phone, base64OrUrl, fileName, extension) {
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (ZAPI_CLIENT_TOKEN && ZAPI_CLIENT_TOKEN !== 'COLOQUE_SEU_CLIENT_TOKEN_AQUI') {
      headers['Client-Token'] = ZAPI_CLIENT_TOKEN;
    }
    await axios.post(`${ZAPI_BASE_URL}/send-document/${extension}`, {
      phone, document: base64OrUrl, fileName
    }, { headers });
    console.log(`[DOCUMENTO ENVIADO] para ${phone}: ${fileName}`);
  } catch (err) {
    console.error('Erro ao enviar documento:', err.response?.data || err.message);
  }
}

// ============================================================
// PARSER DE VCARD — extrai nome e telefone do contato compartilhado
// ============================================================

function parseVCard(vCardString) {
  const nomeMatch = vCardString.match(/FN:(.*)/);
  const telMatch = vCardString.match(/waid=(\d+)/);
  return {
    nome: nomeMatch ? nomeMatch[1].trim() : 'Contato sem nome',
    telefone: telMatch ? telMatch[1].trim() : null
  };
}

// ============================================================
// ESTADO DA CONVERSA — máquina de estados simples por telefone
// ============================================================
// etapas: aguardando_nome -> aguardando_vendedor -> coletando_contatos -> finalizado

function getSessao(telefone) {
  if (!DB.sessoes[telefone]) {
    DB.sessoes[telefone] = {
      etapa: 'aguardando_nome',
      clienteNome: null,
      vendedorNome: null,
      contatos: [],
      criadoEm: new Date().toISOString()
    };
    saveDB(DB);
  }
  return DB.sessoes[telefone];
}

function resetSessao(telefone) {
  delete DB.sessoes[telefone];
  saveDB(DB);
}

// ============================================================
// LÓGICA PRINCIPAL DO ROTEIRO DE NEUROVENDAS
// ============================================================

async function iniciarConversa(telefone) {
  const sessao = getSessao(telefone);
  await sendText(telefone, DB.empresa.mensagemAgradecimento);
  await sendText(telefone, 'Pra começar, qual é o seu nome?');
}

async function processarMensagem(telefone, texto, vCard, contatosMultiplos) {
  const sessao = getSessao(telefone);

  // ETAPA 1: aguardando nome do cliente
  if (sessao.etapa === 'aguardando_nome') {
    sessao.clienteNome = (texto || '').trim();
    sessao.etapa = 'aguardando_vendedor';
    saveDB(DB);

    const listaVendedores = DB.empresa.vendedores.map((v, i) => `${i + 1}️⃣ ${v}`).join('\n');
    await sendText(telefone, `Prazer, ${sessao.clienteNome.split(' ')[0]}! E me diz, quem te atendeu hoje?\n\n${listaVendedores}\n\nResponda com o número ou o nome.`);
    return;
  }

  // ETAPA 2: aguardando escolha do vendedor
  if (sessao.etapa === 'aguardando_vendedor') {
    const escolha = (texto || '').trim();
    let vendedor = null;

    const numeroEscolhido = parseInt(escolha);
    if (!isNaN(numeroEscolhido) && DB.empresa.vendedores[numeroEscolhido - 1]) {
      vendedor = DB.empresa.vendedores[numeroEscolhido - 1];
    } else {
      vendedor = DB.empresa.vendedores.find(v => v.toLowerCase().includes(escolha.toLowerCase()));
    }

    if (!vendedor) {
      await sendText(telefone, 'Não encontrei esse vendedor. Pode digitar o número da lista ou o nome certinho?');
      return;
    }

    sessao.vendedorNome = vendedor;
    sessao.etapa = 'coletando_contatos';
    saveDB(DB);

    const primeiraFaixa = DB.empresa.faixasBonus[0];
    await sendText(telefone, `Show! Agora me envie o contato dos seus amigos para você receber ${primeiraFaixa.premio.toLowerCase()}.`);
    await sendText(telefone, `Me envie ${primeiraFaixa.quantidade} recomendações e já garanta seu presente.\n\nVocê pode mandar o contato direto da sua agenda (toque em 📎 → Contato) ou digitar nome e telefone. Então, qual é a primeira pessoa que vem na sua mente? Lembrando que ela também vai ganhar um presente nosso 🎁`);
    return;
  }

  // ETAPA 3: coletando contatos recomendados
  if (sessao.etapa === 'coletando_contatos') {
    let novosContatos = [];

    if (contatosMultiplos && contatosMultiplos.length > 0) {
      novosContatos = contatosMultiplos.filter(c => c && c.nome);
    } else if (vCard) {
      const c = parseVCard(vCard);
      if (c && c.nome) novosContatos = [c];
    } else if (texto) {
      const partes = texto.split(/[-,]/).map(p => p.trim());
      novosContatos = [{
        nome: partes[0] || texto.trim(),
        telefone: partes[1] || null
      }];
    }

    if (novosContatos.length > 0) {
      sessao.contatos.push(...novosContatos);
      saveDB(DB);

      const metaAtual = DB.empresa.faixasBonus.find(f => f.quantidade >= sessao.contatos.length) || DB.empresa.faixasBonus[DB.empresa.faixasBonus.length - 1];
      const faltam = metaAtual.quantidade - sessao.contatos.length;

      if (faltam > 0) {
        const nomesAdicionados = novosContatos.map(c => c.nome).join(', ');
        await sendText(telefone, `Anotado, ${nomesAdicionados}! ✅ Faltam ${faltam} recomendações para você garantir "${metaAtual.premio}". Quem mais vem na sua mente?`);
      } else {
        await finalizarFaixa(telefone, sessao, metaAtual);
      }
    } else {
      await sendText(telefone, 'Não consegui identificar o contato. Pode mandar de novo, direto da sua agenda ou digitando nome e telefone?');
    }
    return;
  }

  // ETAPA 4: já finalizado — reinicia se mandar mensagem de novo
  if (sessao.etapa === 'finalizado') {
    resetSessao(telefone);
    await iniciarConversa(telefone);
    return;
  }
}

async function finalizarFaixa(telefone, sessao, faixa) {
  await sendText(telefone, `🎉 Perfeito! Você completou ${sessao.contatos.length} recomendações.`);
  await sendText(telefone, `Seu presente: ${faixa.premio}`);
  await sendText(telefone, `Só uma coisa importante: avise seus amigos que vamos entrar em contato com eles em breve, combinado? Assim eles já esperam nossa mensagem 😉`);

  sessao.etapa = 'finalizado';
  sessao.faixaFinal = faixa;
  saveDB(DB);

  const esperaMs = DB.empresa.tempoEsperaConversaoMin * 60 * 1000;
  sessao.contatos.forEach((contato) => {
    setTimeout(() => {
      contatarRecomendado(contato, sessao);
    }, esperaMs);
  });

  console.log(`[SESSÃO FINALIZADA] ${sessao.clienteNome} via ${sessao.vendedorNome} — ${sessao.contatos.length} contatos`);
}

async function contatarRecomendado(contato, sessao) {
  if (!contato.telefone) {
    console.log(`[AVISO] Contato "${contato.nome}" sem telefone válido — não foi possível enviar conversão.`);
    return;
  }

  const primeiroNomeRecomendado = contato.nome.split(' ')[0];
  const primeiroNomeRecomendador = sessao.clienteNome.split(' ')[0];

  const mensagem = `Olá ${primeiroNomeRecomendado}, somos da ${DB.empresa.nome} e seu amigo ${primeiroNomeRecomendador} recomendou você aqui na nossa empresa.\n\nPor ter sido recomendado, você ganhou ${DB.empresa.premioRecomendado}.\n\n${DB.empresa.ctaRecomendado}`;

  await sendText(contato.telefone, mensagem);
  console.log(`[CONVERSÃO ENVIADA] para ${contato.nome} (${contato.telefone})`);
}

// ============================================================
// WEBHOOK — recebe mensagens da Z-API
// ============================================================

app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;
    console.log('[WEBHOOK] keys recebidas:', Object.keys(body).join(', '));
    console.log('[WEBHOOK] text:', JSON.stringify(body.text));
    console.log('[WEBHOOK] contact:', JSON.stringify(body.contact));
    console.log('[WEBHOOK] contactArray:', JSON.stringify(body.contactArray));
    console.log('[WEBHOOK] vCard direto:', JSON.stringify(body.vCard));
    console.log('[WEBHOOK] image:', JSON.stringify(body.image));
    console.log('[WEBHOOK] document:', JSON.stringify(body.document));

    if (body.fromMe) {
      return res.sendStatus(200);
    }

    if (body.isGroup) {
      return res.sendStatus(200);
    }

    const telefone = body.phone;
    if (!telefone) {
      return res.sendStatus(200);
    }

    let texto = null;
    let vCard = null;
    let contatosMultiplos = null;

    if (body.text && body.text.message) {
      texto = body.text.message;
    }

    if (body.contactArray && Array.isArray(body.contactArray) && body.contactArray.length > 0) {
      contatosMultiplos = body.contactArray.map(c => {
        if (c.vcard || c.vCard) {
          return parseVCard(c.vcard || c.vCard);
        }
        return {
          nome: c.displayName || c.name || c.pushname || 'Contato sem nome',
          telefone: (c.phones && c.phones[0]) || c.phone || c.waid || null
        };
      });
    }

    if (body.contact) {
      vCard = body.contact.vCard || body.contact.vcard || null;
      if (!texto && !vCard && body.contact.displayName) {
        texto = `${body.contact.displayName} - ${body.contact.phones ? body.contact.phones[0] : ''}`;
      }
    }
    if (!vCard && body.vCard) {
      vCard = body.vCard;
    }
    if (!vCard && body.vcard) {
      vCard = body.vcard;
    }

    console.log('[WEBHOOK] texto extraído:', texto);
    console.log('[WEBHOOK] vCard extraído:', vCard);
    console.log('[WEBHOOK] contatosMultiplos extraído:', JSON.stringify(contatosMultiplos));

    const sessaoExistente = DB.sessoes[telefone];
    const ehGatilhoInicial = texto && texto.toLowerCase().includes('quero meu presente');

    if (ehGatilhoInicial || !sessaoExistente) {
      if (!sessaoExistente) {
        await iniciarConversa(telefone);
      } else {
        await processarMensagem(telefone, texto, vCard, contatosMultiplos);
      }
    } else {
      await processarMensagem(telefone, texto, vCard, contatosMultiplos);
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('Erro no webhook:', err);
    res.sendStatus(500);
  }
});

// ============================================================
// ROTAS DE ADMINISTRAÇÃO SIMPLES
// ============================================================

app.get('/', (req, res) => {
  res.send('RecomendaLeads Bot está rodando ✅');
});

app.get('/status', (req, res) => {
  res.json({
    empresa: DB.empresa.nome,
    sessoesAtivas: Object.keys(DB.sessoes).length,
    sessoes: DB.sessoes
  });
});

app.post('/config', (req, res) => {
  DB.empresa = { ...DB.empresa, ...req.body };
  saveDB(DB);
  res.json({ ok: true, empresa: DB.empresa });
});

// ============================================================
// INICIALIZAÇÃO DO SERVIDOR
// ============================================================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`RecomendaLeads Bot rodando na porta ${PORT}`);
  console.log(`Webhook disponível em: /webhook`);
});
