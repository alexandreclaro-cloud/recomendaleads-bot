// ============================================================
// RECOMENDALEADS BOT — Servidor de automação via Z-API
// VERSÃO 2 — Persistência em Firestore (não perde dados em redeploy)
// ============================================================
// Este servidor recebe mensagens do WhatsApp via webhook da Z-API
// e conduz o roteiro de neurovendas do Método Poder da Recomendação.

const express = require('express');
const axios = require('axios');
const admin = require('firebase-admin');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// ============================================================
// CONFIGURAÇÃO — Z-API
// ============================================================
const ZAPI_INSTANCE_ID = process.env.ZAPI_INSTANCE_ID || 'COLOQUE_SEU_ID_AQUI';
const ZAPI_TOKEN = process.env.ZAPI_TOKEN || 'COLOQUE_SEU_TOKEN_AQUI';
const ZAPI_CLIENT_TOKEN = process.env.ZAPI_CLIENT_TOKEN || 'COLOQUE_SEU_CLIENT_TOKEN_AQUI';
const ZAPI_BASE_URL = `https://api.z-api.io/instances/${ZAPI_INSTANCE_ID}/token/${ZAPI_TOKEN}`;

// ============================================================
// CONFIGURAÇÃO — Firebase Admin / Firestore
// ============================================================
let serviceAccount;
try {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} catch (err) {
  console.error('ERRO: FIREBASE_SERVICE_CCOUNT não está configurada corretamente.', err.message);
}

if (serviceAccount) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    storageBucket: 'recomendaleads-8063e.firebasestorage.app'
  });
}

const db = admin.apps.length ? admin.firestore() : null;

const EMPRESA_DOC = () => db.collection('config').doc('empresa');
const SESSOES_COL = () => db.collection('sessoes');
const LEADS_COL = () => db.collection('leads');
const SESSOES_RECOMENDADO_COL = () => db.collection('sessoes_recomendado');
const AGENDAMENTOS_COL = () => db.collection('agendamentos');
const MENSAGENS_PROCESSADAS_COL = () => db.collection('mensagens_processadas');
const NUMEROS_PAUSADOS_COL = () => db.collection('numeros_pausados');

async function numeroEstaPausado(telefone) {
  const snap = await NUMEROS_PAUSADOS_COL().doc(telefone).get();
  return snap.exists;
}

async function pausarNumero(telefone) {
  await NUMEROS_PAUSADOS_COL().doc(telefone).set({ pausadoEm: new Date().toISOString() });
}

async function despausarNumero(telefone) {
  await NUMEROS_PAUSADOS_COL().doc(telefone).delete();
}

const EMPRESAS_COL = () => db.collection('empresas_login');

const PALAVRAS_POSITIVAS = [
  'sim', 'pode', 'claro', 'ok', 'okay', 'manda', 'pode falar', 'pode sim',
  'com certeza', 'isso', 'aham', 'uhum', 'beleza', 'blz', 'vai', 'fala',
  'diga', 'segue', 'continua', 'quero', 'demorou'
];

function respostaEhPositiva(texto) {
  if (!texto) return false;
  const normalizado = texto.toLowerCase().trim();
  return PALAVRAS_POSITIVAS.some(palavra => normalizado.includes(palavra));
}

const JWT_SECRET = process.env.JWT_SECRET || 'recomendaleads-segredo-trocar-em-producao';
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'troque-esta-chave';

// ============================================================
// CONFIGURAÇÃO — API Claude (interpretação de respostas do recomendado)
// ============================================================
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';

const EMPRESA_ID_PDN = 'MFMcfVJfqv35dA9MotLK';

// ============================================================
// SEED — configuração padrão da empresa
// ============================================================
const EMPRESA_PADRAO = {
  nome: 'Empresa Demo',
  mensagemAgradecimento: 'Olá! Muito obrigado por ser nosso cliente e confiar no nosso trabalho. 🙏',
  vendedores: ['Carla Mendes', 'Roberto Lima', 'Juliana Alves'],
  faixasBonus: [
    { quantidade: 5, premio: 'Cupom de 10% de desconto na próxima compra', arquivo: null, link: null, texto: null },
    { quantidade: 10, premio: 'Brinde exclusivo + 15% de desconto', arquivo: null, link: null, texto: null },
    { quantidade: 15, premio: 'Vale-presente de R$ 50', arquivo: null, link: null, texto: null },
    { quantidade: 20, premio: 'Status de Embaixador + kit especial', arquivo: null, link: null, texto: null }
  ],
  premioRecomendado: 'Desconto de 10% na primeira compra, cortesia de quem te recomendou',
  arquivoRecomendado: null,
  linkRecomendado: null,
  ctaRecomendado: 'Gostaria de vir retirar?',
  mensagemInicialRecomendado: 'Oi {nomeRecomendado}, aqui é {vendedor} da {empresa} e seu amigo(a) {recomendador} me recomendou você... Posso falar?',
  mensagemAguardandoConfirmacao: 'Posso te contar mais sobre isso?',
  cadenciaFollowupRecomendado: [
    { esperaMin: 1440, texto: 'Oi, só passando pra saber se você viu minha mensagem 🙂' },
    { esperaMin: 4320, texto: 'Seu presente ainda está disponível! Posso te contar mais?' }
  ],
  tempoEsperaConversaoMin: 60,
  tempoFollowupMin: 30,
  etapasKanban: [
    { id: 'recebeu_mensagem', nome: 'Recebeu Mensagem' },
    { id: 'aceitou_mensagem', nome: 'Aceitou Mensagem' },
    { id: 'agendou', nome: 'Agendou' },
    { id: 'comprou', nome: 'Comprou' },
    { id: 'nao_respondeu', nome: 'Não respondeu' },
    { id: 'nao_tem_interesse', nome: 'Não tem interesse' }
  ]
};

// Configuração especial para empresa de teste — faixa 1 com apenas 1 recomendação
const EMPRESA_TESTE_CONFIG = {
  ...EMPRESA_PADRAO,
  nome: 'PDN Teste',
  faixasBonus: [
    { quantidade: 1, premio: 'Prêmio de teste — 1 recomendação', arquivo: null, link: null, texto: null }
  ],
  tempoEsperaConversaoMin: 1
};

async function getEmpresa() {
  const snap = await EMPRESAS_COL().doc(EMPRESA_ID_PDN).get();
  if (snap.exists && snap.data().configuracao) {
    return { ...EMPRESA_PADRAO, ...snap.data().configuracao };
  }
  const snapDemo = await EMPRESA_DOC().get();
  if (!snapDemo.exists) {
    await EMPRESA_DOC().set(EMPRESA_PADRAO);
    return { ...EMPRESA_PADRAO };
  }
  return snapDemo.data();
}

async function saveEmpresa(empresa) {
  await EMPRESA_DOC().set(empresa, { merge: true });
}

async function getSessao(telefone) {
  const snap = await SESSOES_COL().doc(telefone).get();
  if (!snap.exists) {
    const novaSessao = {
      etapa: 'aguardando_nome',
      clienteNome: null,
      vendedorNome: null,
      contatos: [],
      criadoEm: new Date().toISOString()
    };
    await SESSOES_COL().doc(telefone).set(novaSessao);
    return novaSessao;
  }
  return snap.data();
}

async function saveSessao(telefone, sessao) {
  await SESSOES_COL().doc(telefone).set(sessao, { merge: true });
}

async function resetSessao(telefone) {
  await SESSOES_COL().doc(telefone).delete();
}

async function getTodasSessoes() {
  const snap = await SESSOES_COL().get();
  const sessoes = {};
  snap.forEach(doc => { sessoes[doc.id] = doc.data(); });
  return sessoes;
}

// ============================================================
// CRM KANBAN — leads recomendados (coleção "leads")
// ============================================================

async function criarLead({ nomeRecomendado, telefoneRecomendado, nomeRecomendador, telefoneRecomendador, vendedor, empresaId }) {
  const empresa = await getEmpresa();
  const etapas = (empresa.etapasKanban && empresa.etapasKanban.length > 0)
    ? empresa.etapasKanban
    : EMPRESA_PADRAO.etapasKanban;
  const etapaInicial = etapas[0].id;

  const lead = {
    nomeRecomendado: nomeRecomendado || 'Contato sem nome',
    telefoneRecomendado: telefoneRecomendado || null,
    nomeRecomendador: nomeRecomendador || null,
    telefoneRecomendador: telefoneRecomendador || null,
    vendedor: vendedor || null,
    empresaId: empresaId || null,
    etapa: etapaInicial,
    bonusPago: false,
    criadoEm: new Date().toISOString(),
    historico: [{ etapa: etapaInicial, em: new Date().toISOString() }]
  };
  const ref = await LEADS_COL().add(lead);
  return { id: ref.id, ...lead };
}

async function getTodosLeads() {
  const snap = await LEADS_COL().orderBy('criadoEm', 'desc').get();
  const leads = [];
  snap.forEach(doc => leads.push({ id: doc.id, ...doc.data() }));
  return leads;
}

async function getLeadsPorEmpresa(empresaId) {
  const snap = await LEADS_COL().where('empresaId', '==', empresaId).orderBy('criadoEm', 'desc').get();
  const leads = [];
  snap.forEach(doc => leads.push({ id: doc.id, ...doc.data() }));
  return leads;
}

async function atualizarLead(id, dados) {
  const ref = LEADS_COL().doc(id);
  const snap = await ref.get();
  if (!snap.exists) return null;

  const atual = snap.data();
  const atualizado = { ...atual, ...dados };

  if (dados.etapa && dados.etapa !== atual.etapa) {
    atualizado.historico = [...(atual.historico || []), { etapa: dados.etapa, em: new Date().toISOString() }];
  }

  await ref.set(atualizado, { merge: true });
  return { id, ...atualizado };
}

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

async function sendImage(phone, imageUrl, caption) {
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (ZAPI_CLIENT_TOKEN && ZAPI_CLIENT_TOKEN !== 'COLOQUE_SEU_CLIENT_TOKEN_AQUI') {
      headers['Client-Token'] = ZAPI_CLIENT_TOKEN;
    }
    await axios.post(`${ZAPI_BASE_URL}/send-image`, {
      phone, image: imageUrl, caption: caption || ''
    }, { headers });
    console.log(`[IMAGEM ENVIADA] para ${phone}`);
  } catch (err) {
    console.error('Erro ao enviar imagem:', err.response?.data || err.message);
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
// HELPER — converte link do Google Drive em link de download direto
// ============================================================

function converterLinkDrive(url) {
  if (!url) return url;
  const match = url.match(/\/d\/([a-zA-Z0-9_-]+)/) || url.match(/id=([a-zA-Z0-9_-]+)/);
  if (match && match[1]) {
    return `https://drive.google.com/uc?export=download&id=${match[1]}`;
  }
  return url;
}

// ============================================================
// PARSER DE VCARD
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
// IDEMPOTÊNCIA DO WEBHOOK — evita reprocessar a mesma mensagem
// ============================================================

async function jaProcessadaOuMarcar(messageId) {
  if (!messageId) return false;
  const ref = MENSAGENS_PROCESSADAS_COL().doc(messageId);
  const snap = await ref.get();
  if (snap.exists) return true;
  await ref.set({ processadoEm: new Date().toISOString() });
  return false;
}

function mensagemNaoEntendiPorEtapa(etapa, empresa) {
  if (etapa === 'aguardando_nome') {
    return 'Acho que não entendi essa última mensagem 🙂 Pra começar, qual é o seu nome?';
  }
  if (etapa === 'aguardando_vendedor') {
    const listaVendedores = empresa.vendedores.map((v, i) => `${i + 1}️⃣ ${v}`).join('\n');
    return `Não entendi essa última mensagem. Pode me dizer quem te atendeu hoje?\n\n${listaVendedores}\n\nResponda com o número ou o nome.`;
  }
  if (etapa === 'coletando_contatos') {
    return 'Acho que não entendi essa última mensagem 🙂 Pode mandar o contato direto da sua agenda (toque em 📎 → Contato), ou digitar no formato "Nome - telefone com DDD"?';
  }
  if (etapa === 'aguardando_autorizacao_proxima_faixa') {
    return 'Não entendi essa última mensagem. Você quer liberar o próximo prêmio? Pode responder com sim ou não.';
  }
  return null;
}

// ============================================================
// LÓGICA PRINCIPAL DO ROTEIRO DE NEUROVENDAS
// ============================================================

async function iniciarConversa(telefone) {
  const empresa = await getEmpresa();
  await getSessao(telefone);
  await sendText(telefone, empresa.mensagemAgradecimento);
  await sendText(telefone, 'Pra começar, qual é o seu nome?');
}

async function processarMensagem(telefone, texto, vCard, contatosMultiplos) {
  const empresa = await getEmpresa();
  const sessao = await getSessao(telefone);

  if (sessao.etapa === 'aguardando_nome') {
    sessao.clienteNome = (texto || '').trim();
    sessao.etapa = 'aguardando_vendedor';
    await saveSessao(telefone, sessao);

    const listaVendedores = empresa.vendedores.map((v, i) => `${i + 1}️⃣ ${v}`).join('\n');
    await sendText(telefone, `Prazer, ${sessao.clienteNome.split(' ')[0]}! E me diz, quem te atendeu hoje?\n\n${listaVendedores}\n\nResponda com o número ou o nome.`);
    return;
  }

  if (sessao.etapa === 'aguardando_vendedor') {
    const escolha = (texto || '').trim();
    let vendedor = null;

    const numeroEscolhido = parseInt(escolha);
    if (!isNaN(numeroEscolhido) && empresa.vendedores[numeroEscolhido - 1]) {
      vendedor = empresa.vendedores[numeroEscolhido - 1];
    } else {
      vendedor = empresa.vendedores.find(v => v.toLowerCase().includes(escolha.toLowerCase()));
    }

    if (!vendedor) {
      await sendText(telefone, 'Não encontrei esse vendedor. Pode digitar o número da lista ou o nome certinho?');
      return;
    }

    sessao.vendedorNome = vendedor;
    sessao.etapa = 'coletando_contatos';
    sessao.indiceFaixaAtual = 0;
    sessao.contatosFaixaAtual = [];
    await saveSessao(telefone, sessao);

    const primeiraFaixa = empresa.faixasBonus[0];
    await sendText(telefone, `Show! Agora me envie o contato dos seus amigos para você receber ${primeiraFaixa.premio.toLowerCase()}.`);
    await sendText(telefone, `Me envie ${primeiraFaixa.quantidade} recomendações e já garanta seu presente.\n\nVocê pode mandar o contato direto da sua agenda (toque em 📎 → Contato) ou digitar nome e telefone. Então, qual é a primeira pessoa que vem na sua mente? Lembrando que ela também vai ganhar um presente nosso 🎁`);
    return;
  }

  if (sessao.etapa === 'coletando_contatos') {
    let novosContatos = [];

    if (contatosMultiplos && contatosMultiplos.length > 0) {
      novosContatos = contatosMultiplos.filter(c => c && c.nome);
    } else if (vCard) {
      const c = parseVCard(vCard);
      if (c && c.nome) novosContatos = [c];
    } else if (texto) {
      const matchTelefone = texto.match(/\+?\d[\d\s().-]{8,15}\d/);
      const ehUrlOuCodigo = /https?:\/\/|\.com|\.br\//.test(texto);

      if (matchTelefone && !ehUrlOuCodigo) {
        const telefoneCru = matchTelefone[0].replace(/[^\d]/g, '');
        const telefoneValido = telefoneCru.length >= 10 && telefoneCru.length <= 13;
        const tamanhoPlausivel = texto.length <= telefoneCru.length + 60;

        if (telefoneValido && tamanhoPlausivel) {
          const nome = texto.replace(matchTelefone[0], '').replace(/[-,]/g, ' ').trim();
          novosContatos = [{
            nome: nome || 'Contato sem nome',
            telefone: telefoneCru
          }];
        }
      }
    }

    if (novosContatos.length > 0) {
      const faixaAtual = empresa.faixasBonus[sessao.indiceFaixaAtual];
      const contatosFaixaAtual = [...(sessao.contatosFaixaAtual || []), ...novosContatos];

      sessao.contatos = [...(sessao.contatos || []), ...novosContatos];

      if (contatosFaixaAtual.length < faixaAtual.quantidade) {
        sessao.contatosFaixaAtual = contatosFaixaAtual;
        await saveSessao(telefone, sessao);

        const faltam = faixaAtual.quantidade - contatosFaixaAtual.length;
        const nomesAdicionados = novosContatos.map(c => c.nome).join(', ');
        await sendText(telefone, `Anotado, ${nomesAdicionados}! ✅ Faltam ${faltam} recomendações para você garantir "${faixaAtual.premio}". Quem mais vem na sua mente?`);
      } else {
        const contatosDestaFaixa = contatosFaixaAtual.slice(0, faixaAtual.quantidade);
        const excedente = contatosFaixaAtual.slice(faixaAtual.quantidade);

        sessao.contatosFaixaAtual = [];
        await finalizarFaixa(telefone, sessao, faixaAtual, empresa, contatosDestaFaixa, excedente);
      }
    } else {
      await sendText(telefone, 'Não consegui identificar um contato aí. Pode mandar o contato direto da sua agenda (toque em 📎 → Contato), ou digitar no formato "Nome - telefone com DDD"?');
    }
    return;
  }

  if (sessao.etapa === 'aguardando_autorizacao_proxima_faixa') {
    if (respostaEhPositiva(texto)) {
      const proximoIndice = sessao.indiceFaixaAtual + 1;
      const proximaFaixa = empresa.faixasBonus[proximoIndice];
      const excedentePendente = sessao.excedentePendente || [];

      sessao.indiceFaixaAtual = proximoIndice;
      sessao.contatosFaixaAtual = excedentePendente;
      sessao.excedentePendente = [];
      sessao.etapa = 'coletando_contatos';

      if (excedentePendente.length >= proximaFaixa.quantidade) {
        const contatosDestaFaixa = excedentePendente.slice(0, proximaFaixa.quantidade);
        const novoExcedente = excedentePendente.slice(proximaFaixa.quantidade);
        sessao.contatosFaixaAtual = [];
        await finalizarFaixa(telefone, sessao, proximaFaixa, empresa, contatosDestaFaixa, novoExcedente);
      } else {
        await saveSessao(telefone, sessao);
        const faltam = proximaFaixa.quantidade - excedentePendente.length;
        await sendText(telefone, `Show! Faltam ${faltam} recomendações para você garantir "${proximaFaixa.premio}". Quem mais vem na sua mente?`);
      }
    } else {
      sessao.excedentePendente = [];
      sessao.etapa = 'finalizado';
      await saveSessao(telefone, sessao);
      await sendText(telefone, 'Sem problemas! Muito obrigado por participar e por confiar na gente 🙏');
    }
    return;
  }

  if (sessao.etapa === 'finalizado') {
    return;
  }
}

async function finalizarFaixa(telefone, sessao, faixa, empresa, contatosDestaFaixa, excedente) {
  await sendText(telefone, `🎉 Perfeito! Você completou ${contatosDestaFaixa.length} recomendações.`);
  await sendText(telefone, `Seu presente: ${faixa.premio}`);

  if (faixa.texto) {
    await sendText(telefone, faixa.texto);
  }

  if (faixa.arquivo) {
    const linkDownload = converterLinkDrive(faixa.arquivo);
    const extensao = (faixa.arquivo.match(/\.(\w+)(\?|$)/) || [])[1] || 'pdf';
    const ehImagem = ['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(extensao.toLowerCase());

    if (ehImagem) {
      await sendImage(telefone, linkDownload, faixa.premio);
    } else {
      await sendDocument(telefone, linkDownload, `Voucher - ${faixa.premio}`, extensao);
    }
  }

  if (faixa.link) {
    await sendText(telefone, faixa.link);
  }

  await sendText(telefone, `Só uma coisa importante: avise seus amigos que vamos entrar em contato com eles em breve, combinado? Assim eles já esperam nossa mensagem 😉`);

  for (const contato of contatosDestaFaixa) {
    try {
      await criarLead({
        nomeRecomendado: contato.nome,
        telefoneRecomendado: contato.telefone,
        nomeRecomendador: sessao.clienteNome,
        telefoneRecomendador: telefone,
        vendedor: sessao.vendedorNome,
        empresaId: EMPRESA_ID_PDN
      });
    } catch (err) {
      console.error('Erro ao criar lead no CRM:', err.message);
    }
  }

  const proximaFaixa = empresa.faixasBonus[sessao.indiceFaixaAtual + 1];

  if (!proximaFaixa) {
    sessao.etapa = 'finalizado';
    sessao.faixaFinal = faixa;
    await saveSessao(telefone, sessao);
    await sendText(telefone, 'Muito obrigado por participar e por confiar na gente! 🙏');
  } else {
    sessao.etapa = 'aguardando_autorizacao_proxima_faixa';
    sessao.excedentePendente = excedente;
    await saveSessao(telefone, sessao);

    if (excedente.length > 0) {
      const palavraContato = excedente.length === 1 ? 'contato' : 'contatos';
      await sendText(telefone, `E olha, você já mandou ${excedente.length} ${palavraContato} a mais! Quer completar mais ${proximaFaixa.quantidade - excedente.length} recomendações e ganhar "${proximaFaixa.premio}"?`);
    } else {
      const incremento = proximaFaixa.quantidade - faixa.quantidade;
      await sendText(telefone, `Quer liberar o próximo prêmio? São +${incremento} recomendações e o prêmio é "${proximaFaixa.premio}". Quer continuar?`);
    }
  }

  const executarEm = new Date(Date.now() + empresa.tempoEsperaConversaoMin * 60 * 1000).toISOString();
  for (const contato of contatosDestaFaixa) {
    try {
      await criarAgendamento({
        tipo: 'iniciar_conversa_recomendado',
        executarEm,
        dados: {
          contato,
          nomeRecomendador: sessao.clienteNome,
          vendedorNome: sessao.vendedorNome
        }
      });
    } catch (err) {
      console.error('Erro ao criar agendamento para recomendado:', err.message);
    }
  }

  console.log(`[FAIXA FINALIZADA] ${sessao.clienteNome} via ${sessao.vendedorNome} — ${contatosDestaFaixa.length} contatos nesta faixa, ${excedente.length} excedentes pendentes`);
}

// ============================================================
// ROTEIRO DO RECOMENDADO — etapas com confirmação e cadência
// ============================================================

function substituirVariaveis(template, variaveis) {
  if (!template) return '';
  // Aceita {recomendado} como alias de {nomeRecomendado} para compatibilidade
  // com mensagens configuradas antes da variável ser renomeada
  const variaveisExpandidas = { ...variaveis, recomendado: variaveis.nomeRecomendado };
  return template.replace(/\{(\w+)\}/g, (match, chave) => variaveisExpandidas[chave] ?? match);
}

async function getSessaoRecomendado(telefone) {
  const snap = await SESSOES_RECOMENDADO_COL().doc(telefone).get();
  return snap.exists ? snap.data() : null;
}

async function saveSessaoRecomendado(telefone, sessao) {
  await SESSOES_RECOMENDADO_COL().doc(telefone).set(sessao, { merge: true });
}

async function encerrarSessaoRecomendado(telefone) {
  await SESSOES_RECOMENDADO_COL().doc(telefone).delete();
}

// ============================================================
// AGENDAMENTOS PERSISTIDOS — substituem setTimeout em memória
// ============================================================

async function criarAgendamento({ tipo, executarEm, dados, marcaTempoReferencia }) {
  await AGENDAMENTOS_COL().add({
    tipo,
    executarEm,
    status: 'pendente',
    dados,
    marcaTempoReferencia: marcaTempoReferencia || null,
    criadoEm: new Date().toISOString()
  });
}

async function buscarAgendamentosVencidos() {
  const agora = new Date().toISOString();
  const snap = await AGENDAMENTOS_COL()
    .where('status', '==', 'pendente')
    .where('executarEm', '<=', agora)
    .get();
  const agendamentos = [];
  snap.forEach(doc => agendamentos.push({ id: doc.id, ...doc.data() }));
  return agendamentos;
}

async function marcarAgendamentoConcluido(id) {
  await AGENDAMENTOS_COL().doc(id).update({ status: 'concluido' });
}

async function agendarProximoFollowup(telefone, empresa, marcaTempo, indiceFollowup) {
  const cadencia = empresa.cadenciaFollowupRecomendado || [];
  const proximo = cadencia[indiceFollowup];
  if (!proximo) return;

  const executarEm = new Date(Date.now() + proximo.esperaMin * 60 * 1000).toISOString();
  await criarAgendamento({
    tipo: 'followup_recomendado',
    executarEm,
    marcaTempoReferencia: marcaTempo,
    dados: { telefone, indiceFollowup }
  });
}

async function iniciarConversaRecomendado(contato, nomeRecomendador, vendedorNome, empresa) {
  if (!contato.telefone) {
    console.log(`[AVISO] Contato "${contato.nome}" sem telefone válido — não foi possível iniciar conversa.`);
    return;
  }

  const primeiroNomeRecomendado = (contato.nome && contato.nome.trim() && contato.nome !== 'Contato sem nome')
    ? contato.nome.split(' ')[0]
    : 'você';
  const variaveis = {
    nomeRecomendado: primeiroNomeRecomendado,
    recomendado: primeiroNomeRecomendado,
    recomendador: nomeRecomendador.split(' ')[0],
    vendedor: vendedorNome,
    empresa: empresa.nome
  };

  const mensagemInicial = substituirVariaveis(empresa.mensagemInicialRecomendado, variaveis);
  await sendText(contato.telefone, mensagemInicial);

  const marcaTempo = new Date().toISOString();
  await saveSessaoRecomendado(contato.telefone, {
    etapa: 'aguardando_confirmacao',
    nomeRecomendado: contato.nome,
    telefoneRecomendado: contato.telefone,
    nomeRecomendador: nomeRecomendador,
    vendedorNome: vendedorNome,
    ultimaMensagemEm: marcaTempo,
    criadoEm: marcaTempo
  });

  await agendarProximoFollowup(contato.telefone, empresa, marcaTempo, 0);
  console.log(`[ROTEIRO RECOMENDADO INICIADO] ${contato.nome} (${contato.telefone})`);
}

async function enviarPremioRecomendado(telefone, sessao, empresa) {
  await sendText(telefone, `Por ter sido recomendado pelo seu amigo, você ganhou ${empresa.premioRecomendado}.`);
  await sendText(telefone, `E já estou te enviando agora mesmo seu presente 🎁`);

  if (empresa.arquivoRecomendado) {
    const linkDownload = converterLinkDrive(empresa.arquivoRecomendado);
    const extensao = (empresa.arquivoRecomendado.match(/\.(\w+)(\?|$)/) || [])[1] || 'pdf';
    const ehImagem = ['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(extensao.toLowerCase());

    if (ehImagem) {
      await sendImage(telefone, linkDownload, empresa.premioRecomendado || '');
    } else {
      await sendDocument(telefone, linkDownload, `Voucher - ${empresa.premioRecomendado || 'presente'}`, extensao);
    }
  }

  if (empresa.linkRecomendado) {
    await sendText(telefone, empresa.linkRecomendado);
  }

  const marcaTempo = new Date().toISOString();
  await saveSessaoRecomendado(telefone, { etapa: 'aguardando_reacao', ultimaMensagemEm: marcaTempo });
  await agendarProximoFollowup(telefone, empresa, marcaTempo, 0);
}

async function enviarCtaRecomendado(telefone, sessao, empresa) {
  await sendText(telefone, empresa.ctaRecomendado);
  await saveSessaoRecomendado(telefone, { etapa: 'aguardando_fechamento' });
  console.log(`[ROTEIRO RECOMENDADO - CTA ENVIADO, AGUARDANDO RESPOSTA FINAL] ${sessao.nomeRecomendado} (${telefone})`);
}

// ============================================================
// INTERPRETAÇÃO DA RESPOSTA DO RECOMENDADO — via API Claude
// ============================================================

async function interpretarRespostaRecomendado(texto, empresa, contextoEtapa) {
  if (!ANTHROPIC_API_KEY) {
    return {
      classificacao: respostaEhPositiva(texto) ? 'positiva' : 'negativa',
      respostaSugerida: null
    };
  }

  const informacoesDisponiveis = [
    `Nome da empresa: ${empresa.nome}`,
    `Prêmio oferecido ao recomendado: ${empresa.premioRecomendado}`,
    `Chamada para ação (CTA): ${empresa.ctaRecomendado}`
  ].join('\n');

  const systemPrompt = `Você ajuda a interpretar respostas de WhatsApp em uma conversa de recomendação comercial (etapa: ${contextoEtapa}).

Informações que você PODE usar para responder perguntas:
${informacoesDisponiveis}

Regras estritas:
- NUNCA invente informações fora do que foi listado acima (preço, endereço, prazo, qualquer dado não fornecido).
- Se a pessoa perguntar algo que você não tem informação, responda de forma breve e natural dizendo que não tem esse detalhe aí, mas que a equipe vai falar mais sobre isso em breve.
- Responda SEMPRE em JSON puro, sem markdown, no formato exato: {"classificacao": "positiva" | "negativa" | "pergunta", "respostaSugerida": "texto curto em português, ou null"}.
- "positiva": a pessoa topou continuar a conversa (ex: sim, pode, claro, ok). respostaSugerida deve ser null. Use esta classificação também quando a etapa for "aguardando resposta final de fechamento, depois do CTA" — nesse caso, gere uma respostaSugerida breve e calorosa de encerramento (ex: "Combinado! Estamos te esperando 😊" ou "Perfeito, qualquer coisa é só chamar!").
- "negativa": SOMENTE quando a pessoa explicitamente não quer continuar (ex: "não quero", "não tenho interesse", "para de me mandar mensagem", "não conheço você", "me tira da lista"). Aqui respostaSugerida é OBRIGATÓRIA: escreva uma despedida breve, gentil e humana. Nunca insista ou pressione.
- "pergunta": quando a pessoa faz uma pergunta, pede mais informações, diz que está ocupada agora mas pode depois (ex: "estou no trabalho", "pode ser outra hora", "qual o assunto?", "quem é você?", "quem te passou meu número?"). respostaSugerida é obrigatória — responda de forma breve e amigável, incentivando a continuar.
- respostaSugerida deve ter no máximo 2 frases curtas, tom natural e amigável, em português do Brasil.`;

  try {
    const resp = await axios.post('https://api.anthropic.com/v1/messages', {
      model: ANTHROPIC_MODEL,
      max_tokens: 200,
      system: systemPrompt,
      messages: [{ role: 'user', content: texto || '' }]
    }, {
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      timeout: 4000
    });

    const textoResposta = resp.data?.content?.[0]?.text || '';
    const parsed = JSON.parse(textoResposta);

    if (!['positiva', 'negativa', 'pergunta'].includes(parsed.classificacao)) {
      throw new Error('Classificação inesperada retornada pela IA');
    }

    return {
      classificacao: parsed.classificacao,
      respostaSugerida: parsed.respostaSugerida || null
    };
  } catch (err) {
    console.error('Erro ao interpretar resposta via IA, usando fallback de palavras-chave:', err.message);
    return {
      classificacao: respostaEhPositiva(texto) ? 'positiva' : 'negativa',
      respostaSugerida: null
    };
  }
}

async function processarMensagemRecomendado(telefone, texto, empresa) {
  const sessao = await getSessaoRecomendado(telefone);
  if (!sessao) return false;

  if (sessao.etapa === 'aguardando_confirmacao') {
    // PALAVRAS-CHAVE PRIMEIRO — respostas simples e positivas respondem
    // imediatamente sem chamar a IA, eliminando o delay de 2-4 segundos
    // para os casos mais comuns ("Sim", "Pode", "Posso", "Claro", etc.)
    if (respostaEhPositiva(texto)) {
      const marcaTempo = new Date().toISOString();
      await saveSessaoRecomendado(telefone, { ultimaMensagemEm: marcaTempo });
      await enviarPremioRecomendado(telefone, sessao, empresa);
      return true;
    }

    // Só chama a IA para casos ambíguos (perguntas, respostas longas, contexto incerto)
    const interpretacao = await interpretarRespostaRecomendado(texto, empresa, 'aguardando confirmação para falar do prêmio');

    if (interpretacao.classificacao === 'positiva') {
      const marcaTempo = new Date().toISOString();
      await saveSessaoRecomendado(telefone, { ultimaMensagemEm: marcaTempo });
      await enviarPremioRecomendado(telefone, sessao, empresa);
    } else if (interpretacao.classificacao === 'negativa') {
      const despedida = interpretacao.respostaSugerida || 'Sem problemas! Foi só um engano da nossa parte, desculpe incomodar 🙂';
      await sendText(telefone, despedida);
      await saveSessaoRecomendado(telefone, { etapa: 'finalizado_negativo' });
      console.log(`[ROTEIRO RECOMENDADO ENCERRADO - RESPOSTA NEGATIVA] ${sessao.nomeRecomendado} (${telefone})`);
    } else {
      const marcaTempo = new Date().toISOString();
      await saveSessaoRecomendado(telefone, { ultimaMensagemEm: marcaTempo });
      await sendText(telefone, interpretacao.respostaSugerida || empresa.mensagemAguardandoConfirmacao);
      await agendarProximoFollowup(telefone, empresa, marcaTempo, 0);
    }
    return true;
  }

  if (sessao.etapa === 'aguardando_reacao') {
    // Qualquer resposta avança para o CTA — atualiza marca de tempo imediatamente
    const marcaReacao = new Date().toISOString();
    await saveSessaoRecomendado(telefone, { ultimaMensagemEm: marcaReacao });
    // Só chama IA se a resposta parecer uma pergunta (texto longo ou com "?")
    const parecePerguntar = texto && (texto.includes('?') || texto.split(' ').length > 4);
    if (parecePerguntar) {
      const interpretacao = await interpretarRespostaRecomendado(texto, empresa, 'aguardando reação ao prêmio, antes do CTA final');
      if (interpretacao.classificacao === 'pergunta' && interpretacao.respostaSugerida) {
        await sendText(telefone, interpretacao.respostaSugerida);
      }
    }
    await enviarCtaRecomendado(telefone, sessao, empresa);
    return true;
  }

  if (sessao.etapa === 'aguardando_fechamento') {
    const interpretacao = await interpretarRespostaRecomendado(texto, empresa, 'aguardando resposta final de fechamento, depois do CTA');
    const fechamento = interpretacao.respostaSugerida || 'Combinado! Estamos à disposição 😊';
    await sendText(telefone, fechamento);
    await saveSessaoRecomendado(telefone, { etapa: 'finalizado' });
    console.log(`[ROTEIRO RECOMENDADO FINALIZADO] ${sessao.nomeRecomendado} (${telefone})`);
    return true;
  }

  return true;
}

// ============================================================
// WEBHOOK — recebe mensagens da Z-API
// ============================================================

app.post('/webhook', async (req, res) => {
  try {
    if (!db) {
      console.error('Firestore não inicializado — verifique FIREBASE_SERVICE_ACCOUNT');
      return res.sendStatus(500);
    }

    const body = req.body;
    console.log('[WEBHOOK] keys recebidas:', Object.keys(body).join(', '));

    if (body.fromMe) {
      return res.sendStatus(200);
    }

    if (body.isGroup) {
      return res.sendStatus(200);
    }

    const messageId = body.messageId || null;
    if (await jaProcessadaOuMarcar(messageId)) {
      console.log(`[WEBHOOK] Mensagem duplicada ignorada (messageId: ${messageId})`);
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
    if (!vCard && body.vCard) vCard = body.vCard;
    if (!vCard && body.vcard) vCard = body.vcard;

    console.log('[WEBHOOK] texto extraído:', texto);
    console.log('[WEBHOOK] vCard extraído:', vCard);
    console.log('[WEBHOOK] contatosMultiplos extraído:', JSON.stringify(contatosMultiplos));

    // ============================================================
    // COMANDOS DE PAUSA MANUAL — "stop1" / "play1"
    // ============================================================
    // stop1: pausa IMEDIATAMENTE o bot para esse número.
    //   - Cancela qualquer sessão ativa (recomendador e recomendado)
    //   - Cancela agendamentos pendentes para esse número
    //   - Bot só responde novamente se a pessoa mandar "quero meu presente"
    // play1: reativa o bot para esse número (volta ao comportamento normal)
    const textoNormalizado = (texto || '').toLowerCase().trim();

    // ============================================================
    // COMANDOS ADMINISTRATIVOS — stop1 / play1 com número alvo
    // ============================================================
    // Qualquer número pode mandar estes comandos (inclusive o próprio dono
    // do bot). O número alvo é passado junto ao comando:
    //   stop1 5511999998888  → pausa o bot para aquele número
    //   play1 5511999998888  → reativa o bot para aquele número
    // Se nenhum número for passado, o alvo é o próprio remetente
    // (comportamento antigo, mantido para compatibilidade).

    const matchStop = textoNormalizado.match(/^stop1(?:\s+(\d+))?$/);
    const matchPlay = textoNormalizado.match(/^play1(?:\s+(\d+))?$/);

    if (matchStop) {
      const alvo = matchStop[1] || telefone;

      await pausarNumero(alvo);
      await resetSessao(alvo);

      const sessaoRec = await getSessaoRecomendado(alvo);
      if (sessaoRec) {
        await saveSessaoRecomendado(alvo, { etapa: 'finalizado_negativo' });
      }

      try {
        const snap = await AGENDAMENTOS_COL()
          .where('status', '==', 'pendente')
          .get();
        const batch = db.batch();
        snap.forEach(doc => {
          const d = doc.data();
          const telefoneAgendamento =
            d.dados?.contato?.telefone ||
            d.dados?.telefone ||
            null;
          if (telefoneAgendamento === alvo) {
            batch.update(doc.ref, { status: 'cancelado' });
          }
        });
        await batch.commit();
      } catch (err) {
        console.error('Erro ao cancelar agendamentos no stop1:', err.message);
      }

      console.log(`[PAUSA MANUAL] Bot pausado para ${alvo} (comando enviado por ${telefone})`);
      return res.sendStatus(200);
    }

    if (matchPlay) {
      const alvo = matchPlay[1] || telefone;
      await despausarNumero(alvo);
      console.log(`[PAUSA MANUAL] Bot reativado para ${alvo} (comando enviado por ${telefone})`);
      return res.sendStatus(200);
    }

    // Se o número está pausado, só reage ao gatilho "quero meu presente"
    const ehGatilhoInicialParaPausa = texto && texto.toLowerCase().includes('quero meu presente');
    if (!ehGatilhoInicialParaPausa && await numeroEstaPausado(telefone)) {
      console.log(`[PAUSA MANUAL] Mensagem ignorada — ${telefone} está pausado`);
      return res.sendStatus(200);
    }

    const ehEventoVazio = !texto && !vCard && !contatosMultiplos;
    if (ehEventoVazio) {
      const sessaoExistenteSnap = await SESSOES_COL().doc(telefone).get();
      if (sessaoExistenteSnap.exists) {
        const sessao = sessaoExistenteSnap.data();
        const empresa = await getEmpresa();
        const msg = mensagemNaoEntendiPorEtapa(sessao.etapa, empresa);
        if (msg) await sendText(telefone, msg);
      } else {
        const sessaoRecomendado = await getSessaoRecomendado(telefone);
        if (sessaoRecomendado && sessaoRecomendado.etapa !== 'finalizado' && sessaoRecomendado.etapa !== 'finalizado_negativo') {
          await sendText(telefone, 'Acho que não entendi essa última mensagem 🙂 Pode me responder em texto?');
        }
      }
      return res.sendStatus(200);
    }

    const sessaoExistenteSnap = await SESSOES_COL().doc(telefone).get();
    const sessaoExiste = sessaoExistenteSnap.exists;
    const ehGatilhoInicial = texto && texto.toLowerCase().includes('quero meu presente');

    if (ehGatilhoInicial) {
      await resetSessao(telefone);
      await iniciarConversa(telefone);
    } else if (sessaoExiste) {
      await processarMensagem(telefone, texto, vCard, contatosMultiplos);
    } else {
      const empresa = await getEmpresa();
      await processarMensagemRecomendado(telefone, texto, empresa);
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('Erro no webhook:', err);
    res.sendStatus(500);
  }
});

// ============================================================
// ROTAS DE ADMINISTRAÇÃO
// ============================================================

app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="pt-BR">
    <head>
      <meta charset="UTF-8">
      <title>RecomendaLeads</title>
      <style>
        body { font-family: -apple-system, sans-serif; background: #0a1628; color: #e8edf4; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
        .box { text-align: center; }
        h1 { color: #f0d878; margin-bottom: 6px; }
        p { color: #9aabc0; margin-bottom: 28px; }
        a { display: inline-block; margin: 6px; padding: 12px 22px; background: #d4af37; color: #0a1628; font-weight: 700; border-radius: 8px; text-decoration: none; }
        a:hover { opacity: 0.9; }
      </style>
    </head>
    <body>
      <div class="box">
        <h1>✅ RecomendaLeads Bot</h1>
        <p>Servidor rodando — escolha um painel:</p>
        <a href="/crm">📋 CRM Kanban</a>
        <a href="/configurar-vouchers">⚙️ Configurações</a>
        <a href="/login">🔑 Login da Empresa</a>
      </div>
    </body>
    </html>
  `);
});

app.get('/configurar-vouchers', (req, res) => {
  res.sendFile(path.join(__dirname, 'configurar-vouchers.html'));
});

app.get('/minha-empresa/configurar', (req, res) => {
  res.sendFile(path.join(__dirname, 'minha-empresa-configurar.html'));
});

app.get('/crm', (req, res) => {
  res.sendFile(path.join(__dirname, 'crm.html'));
});

// ============================================================
// SISTEMA DE LOGIN
// ============================================================

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'login.html'));
});

app.post('/login', async (req, res) => {
  try {
    const { email, senha } = req.body;
    if (!email || !senha) {
      return res.status(400).json({ ok: false, erro: 'Informe email e senha' });
    }

    const snap = await EMPRESAS_COL().where('email', '==', email).limit(1).get();
    if (snap.empty) {
      return res.status(401).json({ ok: false, erro: 'Email ou senha incorretos' });
    }

    const doc = snap.docs[0];
    const empresaLogin = { id: doc.id, ...doc.data() };

    const senhaValida = await bcrypt.compare(senha, empresaLogin.senhaHash);
    if (!senhaValida) {
      return res.status(401).json({ ok: false, erro: 'Email ou senha incorretos' });
    }

    const token = jwt.sign({ empresaLoginId: empresaLogin.id }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ ok: true, token, empresa: { id: empresaLogin.id, nome: empresaLogin.nome, email: empresaLogin.email } });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

app.get('/admin/criar-empresa', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin-criar-empresa.html'));
});

// ============================================================
// MIDDLEWARE DE LOGIN
// ============================================================

async function exigirLoginEmpresa(req, res, next) {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) {
      return res.status(401).json({ ok: false, erro: 'Não autenticado' });
    }

    const payload = jwt.verify(token, JWT_SECRET);
    const doc = await EMPRESAS_COL().doc(payload.empresaLoginId).get();
    if (!doc.exists) {
      return res.status(401).json({ ok: false, erro: 'Empresa não encontrada' });
    }

    req.empresaLogin = { id: doc.id, ...doc.data() };
    next();
  } catch (err) {
    return res.status(401).json({ ok: false, erro: 'Sessão inválida ou expirada' });
  }
}

app.get('/minha-config', exigirLoginEmpresa, async (req, res) => {
  try {
    const configuracao = req.empresaLogin.configuracao || { ...EMPRESA_PADRAO, nome: req.empresaLogin.nome };
    res.json({ ok: true, empresa: configuracao });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

app.post('/minha-config', exigirLoginEmpresa, async (req, res) => {
  try {
    const configuracaoAtual = req.empresaLogin.configuracao || { ...EMPRESA_PADRAO, nome: req.empresaLogin.nome };
    const novaConfiguracao = { ...configuracaoAtual, ...req.body };

    await EMPRESAS_COL().doc(req.empresaLogin.id).set({ configuracao: novaConfiguracao }, { merge: true });
    res.json({ ok: true, empresa: novaConfiguracao });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

app.post('/minha-config/faixa', exigirLoginEmpresa, async (req, res) => {
  try {
    const { quantidade, novaQuantidade, arquivo, link, texto, premio } = req.body;
    const configuracao = req.empresaLogin.configuracao || { ...EMPRESA_PADRAO, nome: req.empresaLogin.nome };

    const faixa = configuracao.faixasBonus.find(f => f.quantidade === quantidade);
    if (!faixa) {
      return res.status(404).json({ ok: false, erro: 'Faixa não encontrada para essa quantidade' });
    }
    if (arquivo !== undefined) faixa.arquivo = arquivo;
    if (link !== undefined) faixa.link = link;
    if (texto !== undefined) faixa.texto = texto;
    if (premio !== undefined) faixa.premio = premio;
    if (novaQuantidade && novaQuantidade !== quantidade) {
      faixa.quantidade = novaQuantidade;
    }

    await EMPRESAS_COL().doc(req.empresaLogin.id).set({ configuracao }, { merge: true });
    res.json({ ok: true, faixa });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// ============================================================
// LEADS ISOLADOS POR EMPRESA
// ============================================================

app.get('/minha-leads', exigirLoginEmpresa, async (req, res) => {
  try {
    const leads = await getLeadsPorEmpresa(req.empresaLogin.id);
    res.json({ ok: true, leads });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

app.patch('/minha-leads/:id', exigirLoginEmpresa, async (req, res) => {
  try {
    const { id } = req.params;

    const ref = LEADS_COL().doc(id);
    const snap = await ref.get();
    if (!snap.exists || snap.data().empresaId !== req.empresaLogin.id) {
      return res.status(404).json({ ok: false, erro: 'Lead não encontrado' });
    }

    const { etapa, vendedor, bonusPago } = req.body;
    const dados = {};
    if (etapa !== undefined) dados.etapa = etapa;
    if (vendedor !== undefined) dados.vendedor = vendedor;
    if (bonusPago !== undefined) dados.bonusPago = bonusPago;

    const lead = await atualizarLead(id, dados);
    if (!lead) {
      return res.status(404).json({ ok: false, erro: 'Lead não encontrado' });
    }
    res.json({ ok: true, lead });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// ============================================================
// ROTA DE CRIAÇÃO DE EMPRESA (admin)
// ============================================================

app.post('/admin/empresas', async (req, res) => {
  try {
    const chaveAdmin = req.headers['x-admin-key'];
    if (!chaveAdmin || chaveAdmin !== ADMIN_SECRET) {
      return res.status(401).json({ ok: false, erro: 'Chave administrativa inválida' });
    }

    const { nome, email, senha, migrarConfigPrincipal, empresaTeste } = req.body;
    if (!nome || !email || !senha) {
      return res.status(400).json({ ok: false, erro: 'Informe nome, email e senha' });
    }

    const existenteSnap = await EMPRESAS_COL().where('email', '==', email).limit(1).get();
    if (!existenteSnap.empty) {
      return res.status(409).json({ ok: false, erro: 'Já existe uma empresa cadastrada com este email' });
    }

    let configuracaoInicial = { ...EMPRESA_PADRAO, nome };

    if (empresaTeste) {
      // Empresa de teste: faixa 1 com quantidade = 1 e tempo de espera = 1 min
      // para validar todo o fluxo rapidamente sem precisar mandar 5 contatos
      configuracaoInicial = { ...EMPRESA_TESTE_CONFIG, nome };
    } else if (migrarConfigPrincipal) {
      const empresaReal = await getEmpresa();
      configuracaoInicial = { ...empresaReal };
    }

    const senhaHash = await bcrypt.hash(senha, 10);
    const ref = await EMPRESAS_COL().add({
      nome,
      email,
      senhaHash,
      criadoEm: new Date().toISOString(),
      configuracao: configuracaoInicial
    });

    res.json({ ok: true, empresa: { id: ref.id, nome, email, empresaTeste: !!empresaTeste } });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// ============================================================
// UPLOAD DE ARQUIVO — Firebase Storage
// ============================================================

const uploadMiddleware = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const tiposPermitidos = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'application/pdf'];
    if (tiposPermitidos.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Tipo de arquivo não permitido. Use JPEG, PNG, WebP ou PDF.'));
    }
  }
});

app.post('/upload-arquivo', exigirLoginEmpresa, uploadMiddleware.single('arquivo'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ ok: false, erro: 'Nenhum arquivo enviado.' });
    }

    const empresaId = req.empresaLogin.id;
    const timestamp = Date.now();
    const nomeArquivo = `vouchers/${empresaId}/${timestamp}_${req.file.originalname.replace(/\s+/g, '_')}`;

    const bucket = admin.storage().bucket();
    const fileRef = bucket.file(nomeArquivo);

    await fileRef.save(req.file.buffer, {
      metadata: { contentType: req.file.mimetype }
    });

    const [url] = await fileRef.getSignedUrl({
      action: 'read',
      expires: '01-01-2125'
    });

    res.json({ ok: true, url });
  } catch (err) {
    console.error('Erro ao fazer upload:', err.message);
    res.status(500).json({ ok: false, erro: err.message });
  }
});

app.get('/status', async (req, res) => {
  try {
    const empresa = await getEmpresa();
    const sessoes = await getTodasSessoes();
    res.json({
      empresa: empresa.nome,
      sessoesAtivas: Object.keys(sessoes).length,
      sessoes
    });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

app.get('/config', async (req, res) => {
  try {
    const empresa = await getEmpresa();
    res.json({ ok: true, empresa });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

app.post('/config', async (req, res) => {
  try {
    const empresaAtual = await getEmpresa();
    const novaEmpresa = { ...empresaAtual, ...req.body };
    await saveEmpresa(novaEmpresa);
    res.json({ ok: true, empresa: novaEmpresa });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

app.post('/config/faixa', async (req, res) => {
  try {
    const { quantidade, arquivo, link, texto, premio } = req.body;
    const empresa = await getEmpresa();
    const faixa = empresa.faixasBonus.find(f => f.quantidade === quantidade);
    if (!faixa) {
      return res.status(404).json({ ok: false, erro: 'Faixa não encontrada para essa quantidade' });
    }
    if (arquivo !== undefined) faixa.arquivo = arquivo;
    if (link !== undefined) faixa.link = link;
    if (texto !== undefined) faixa.texto = texto;
    if (premio !== undefined) faixa.premio = premio;
    await saveEmpresa(empresa);
    res.json({ ok: true, faixa });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// ============================================================
// ROTAS DO CRM KANBAN (antigas — sem login)
// ============================================================

app.get('/leads', async (req, res) => {
  try {
    const leads = await getTodosLeads();
    res.json({ ok: true, leads });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

app.patch('/leads/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { etapa, vendedor, bonusPago } = req.body;
    const dados = {};
    if (etapa !== undefined) dados.etapa = etapa;
    if (vendedor !== undefined) dados.vendedor = vendedor;
    if (bonusPago !== undefined) dados.bonusPago = bonusPago;

    const lead = await atualizarLead(id, dados);
    if (!lead) {
      return res.status(404).json({ ok: false, erro: 'Lead não encontrado' });
    }
    res.json({ ok: true, lead });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

app.post('/leads', async (req, res) => {
  try {
    const { nomeRecomendado, telefoneRecomendado, nomeRecomendador, telefoneRecomendador, vendedor } = req.body;
    const lead = await criarLead({ nomeRecomendado, telefoneRecomendado, nomeRecomendador, telefoneRecomendador, vendedor });
    res.json({ ok: true, lead });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// ============================================================
// EXECUTOR DE AGENDAMENTOS — roda a cada 3 minutos
// ============================================================

async function processarAgendamento(agendamento) {
  const empresa = await getEmpresa();

  if (agendamento.tipo === 'iniciar_conversa_recomendado') {
    const { contato, nomeRecomendador, vendedorNome } = agendamento.dados;

    // ✅ CORREÇÃO: verifica se o número está pausado antes de iniciar
    // Se stop1 foi enviado após o agendamento ser criado, não inicia a conversa
    if (contato.telefone && await numeroEstaPausado(contato.telefone)) {
      console.log(`[AGENDAMENTO IGNORADO] ${contato.telefone} está pausado (stop1) — conversa não iniciada`);
      return;
    }

    await iniciarConversaRecomendado(contato, nomeRecomendador, vendedorNome, empresa);
    return;
  }

  if (agendamento.tipo === 'followup_recomendado') {
    const { telefone, indiceFollowup } = agendamento.dados;

    // ✅ CORREÇÃO: verifica se o número está pausado antes de enviar follow-up
    if (await numeroEstaPausado(telefone)) {
      console.log(`[AGENDAMENTO IGNORADO] ${telefone} está pausado (stop1) — follow-up não enviado`);
      return;
    }

    const sessaoAtual = await getSessaoRecomendado(telefone);

    if (!sessaoAtual || sessaoAtual.ultimaMensagemEm !== agendamento.marcaTempoReferencia) {
      return;
    }

    const cadencia = empresa.cadenciaFollowupRecomendado || [];
    const proximo = cadencia[indiceFollowup];
    if (!proximo) return;

    await sendText(telefone, proximo.texto);
    const novaMarca = new Date().toISOString();
    await saveSessaoRecomendado(telefone, { ultimaMensagemEm: novaMarca });
    await agendarProximoFollowup(telefone, empresa, novaMarca, indiceFollowup + 1);
    return;
  }

  console.log(`[AGENDAMENTO] Tipo desconhecido ignorado: ${agendamento.tipo}`);
}

async function executarAgendamentosPendentes() {
  if (!db) return;
  try {
    const pendentes = await buscarAgendamentosVencidos();
    for (const agendamento of pendentes) {
      try {
        await processarAgendamento(agendamento);
      } catch (err) {
        console.error(`Erro ao processar agendamento ${agendamento.id}:`, err.message);
      } finally {
        await marcarAgendamentoConcluido(agendamento.id);
      }
    }
  } catch (err) {
    console.error('Erro ao buscar agendamentos pendentes:', err.message);
  }
}

function iniciarExecutorAgendamentos() {
  const INTERVALO_EXECUTOR_MS = 1 * 60 * 1000;
  executarAgendamentosPendentes();
  setInterval(executarAgendamentosPendentes, INTERVALO_EXECUTOR_MS);
}

// ============================================================
// INICIALIZAÇÃO DO SERVIDOR
// ============================================================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`RecomendaLeads Bot v2 (Firestore) rodando na porta ${PORT}`);
  console.log(`Webhook disponível em: /webhook`);
  console.log(`Firestore inicializado: ${db ? 'SIM' : 'NÃO — verifique FIREBASE_SERVICE_ACCOUNT'}`);
  iniciarExecutorAgendamentos();
  console.log('Executor de agendamentos iniciado (checagem a cada 1 min)');
});
