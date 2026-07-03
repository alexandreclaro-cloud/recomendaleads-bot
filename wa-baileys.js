// ============================================================
// WhatsApp via Baileys (conexão própria por QR — alternativa grátis ao Z-API)
// ------------------------------------------------------------
// - Uma sessão (socket) por empresa, mantida em memória.
// - Estado de autenticação salvo no FIRESTORE (sobrevive a reinício do Render).
// - Mensagens recebidas são entregues ao server.js via callback `onMessage`,
//   no MESMO formato do webhook Z-API, pra reaproveitar todo o fluxo do bot.
// ============================================================

const makeWASocket = require('@whiskeysockets/baileys').default;
const {
  initAuthCreds,
  BufferJSON,
  proto,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore
} = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');

// Logger silencioso no formato que o Baileys espera (pino-like, com .child()).
const _waLogger = {
  level: 'silent',
  trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {},
  child() { return _waLogger; }
};

let _db = null;
let _onMessage = null;
const sessoes = {}; // empresaId -> { sock, status, qr, qrDataUrl, numero, iniciandoEm }
// Diagnóstico: último erro por empresa (sobrevive à queda da sessão) + contador
// de tentativas de reconexão pra detectar loop (connect→close→connect sem QR).
const _ultimoErro = {};   // empresaId -> string
const _tentativas = {};   // empresaId -> number

// Buffer de diagnóstico: últimas mensagens recebidas (todas as empresas), pra
// investigar por que o bot não respondeu (vê remoteJid, @lid, senderPn, etc).
const _recebidasDebug = [];
function _pushDebug(entry) {
  _recebidasDebug.push({ ts: new Date().toISOString(), ...entry });
  while (_recebidasDebug.length > 40) _recebidasDebug.shift();
}
function getDebug(empresaId) {
  const lista = empresaId ? _recebidasDebug.filter(e => e.empresaId === empresaId) : _recebidasDebug;
  return lista.slice(-20).reverse();
}

function init(db, onMessage) {
  _db = db;
  _onMessage = onMessage;
}

// ---- Estado de auth no Firestore ----------------------------------------
async function useFirestoreAuthState(empresaId) {
  const base = _db.collection('wa_sessions').doc(empresaId);
  const keysCol = base.collection('keys');

  let creds;
  const credsDoc = await base.get();
  if (credsDoc.exists && credsDoc.data().creds) {
    creds = JSON.parse(credsDoc.data().creds, BufferJSON.reviver);
  } else {
    creds = initAuthCreds();
  }

  const keys = {
    get: async (type, ids) => {
      const result = {};
      await Promise.all(ids.map(async (id) => {
        const d = await keysCol.doc(`${type}--${id}`).get();
        if (d.exists && d.data().v != null) {
          let val = JSON.parse(d.data().v, BufferJSON.reviver);
          if (type === 'app-state-sync-key' && val) {
            val = proto.Message.AppStateSyncKeyData.fromObject(val);
          }
          result[id] = val;
        }
      }));
      return result;
    },
    set: async (data) => {
      const batch = _db.batch();
      let n = 0;
      for (const type in data) {
        for (const id in data[type]) {
          const value = data[type][id];
          const ref = keysCol.doc(`${type}--${id}`);
          if (value) batch.set(ref, { v: JSON.stringify(value, BufferJSON.replacer) });
          else batch.delete(ref);
          n++;
          // Firestore: máx 500 ops por batch
          if (n % 450 === 0) { await batch.commit(); }
        }
      }
      await batch.commit();
    }
  };

  const saveCreds = async () => {
    await base.set({ creds: JSON.stringify(creds, BufferJSON.replacer), atualizadoEm: new Date().toISOString() }, { merge: true });
  };

  return { state: { creds, keys }, saveCreds };
}

// Apaga toda a sessão salva (usado no logout/reset).
async function limparSessaoFirestore(empresaId) {
  const base = _db.collection('wa_sessions').doc(empresaId);
  try {
    const keysSnap = await base.collection('keys').get();
    const batch = _db.batch();
    keysSnap.forEach(d => batch.delete(d.ref));
    batch.delete(base);
    await batch.commit();
  } catch (e) { console.error('[BAILEYS] erro ao limpar sessão:', e.message); }
}

// ---- Conexão -------------------------------------------------------------
async function iniciarSessao(empresaId) {
  if (sessoes[empresaId] && sessoes[empresaId].sock) return sessoes[empresaId];

  const sessao = sessoes[empresaId] = { sock: null, status: 'conectando', qr: null, qrDataUrl: null, numero: null, iniciandoEm: Date.now(), jids: {}, erro: null };
  _ultimoErro[empresaId] = null;

  let state, saveCreds;
  try {
    ({ state, saveCreds } = await useFirestoreAuthState(empresaId));
  } catch (e) {
    const m = 'Falha ao ler a sessão no banco: ' + e.message;
    console.error(`[BAILEYS] ${empresaId} ${m}`);
    sessao.status = 'erro'; sessao.erro = m; _ultimoErro[empresaId] = m;
    delete sessoes[empresaId];
    throw e;
  }
  let version;
  try { ({ version } = await fetchLatestBaileysVersion()); }
  catch (e) { console.error(`[BAILEYS] ${empresaId} fetchLatestBaileysVersion falhou (usando versão padrão): ${e.message}`); }

  let sock;
  try {
  sock = makeWASocket({
    version,
    logger: _waLogger,
    auth: {
      creds: state.creds,
      // Cache das chaves de sinal — recomendado no Baileys 7.x; melhora a
      // resolução de sessões @lid e a descriptografia das mensagens.
      keys: makeCacheableSignalKeyStore(state.keys, _waLogger)
    },
    printQRInTerminal: false,
    browser: ['RecomendaLeads', 'Chrome', '1.0.0'],
    markOnlineOnConnect: false,
    syncFullHistory: false
  });
  sessao.sock = sock;
  } catch (e) {
    const m = 'Falha ao iniciar o WhatsApp: ' + e.message;
    console.error(`[BAILEYS] ${empresaId} ${m}`);
    sessao.status = 'erro'; sessao.erro = m; _ultimoErro[empresaId] = m;
    delete sessoes[empresaId];
    throw e;
  }

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (u) => {
    const { connection, lastDisconnect, qr } = u;
    if (qr) {
      sessao.qr = qr;
      sessao.status = 'qr';
      _tentativas[empresaId] = 0;
      console.log(`[BAILEYS] ${empresaId} QR gerado`);
      try { sessao.qrDataUrl = await QRCode.toDataURL(qr); }
      catch (e) { console.error(`[BAILEYS] ${empresaId} QRCode.toDataURL falhou: ${e.message}`); sessao.erro = 'Falha ao desenhar o QR: ' + e.message; }
    }
    if (connection === 'open') {
      sessao.status = 'conectado';
      sessao.qr = null; sessao.qrDataUrl = null;
      sessao.numero = (sock.user && sock.user.id || '').split(':')[0].replace(/\D/g, '') || null;
      console.log(`[BAILEYS] empresa ${empresaId} conectada (${sessao.numero || '?'})`);
    }
    if (connection === 'close') {
      const code = lastDisconnect && lastDisconnect.error && lastDisconnect.error.output && lastDisconnect.error.output.statusCode;
      const motivo = lastDisconnect && lastDisconnect.error && lastDisconnect.error.message;
      console.log(`[BAILEYS] empresa ${empresaId} desconectou (code ${code}) ${motivo || ''}`);
      _ultimoErro[empresaId] = `Conexão fechou (code ${code || '?'})${motivo ? ': ' + motivo : ''}`;
      const teveQr = !!sessao.qr;
      delete sessoes[empresaId];
      if (code === DisconnectReason.loggedOut) {
        // Número desvinculou — limpa pra permitir novo QR.
        await limparSessaoFirestore(empresaId);
        _tentativas[empresaId] = 0;
      } else {
        // Se a conexão caiu ANTES de gerar QR, é sinal de problema persistente
        // (sessão salva inválida, bloqueio de rede, etc). Limitamos as tentativas
        // pra não entrar em loop infinito e deixamos o erro visível no painel.
        _tentativas[empresaId] = (_tentativas[empresaId] || 0) + 1;
        if (!teveQr && _tentativas[empresaId] >= 5) {
          console.error(`[BAILEYS] ${empresaId} desistindo após ${_tentativas[empresaId]} tentativas sem QR`);
          return;
        }
        // Queda transitória — reconecta sozinho.
        setTimeout(() => { iniciarSessao(empresaId).catch(e => console.error('[BAILEYS] reconexão falhou:', e.message)); }, 4000);
      }
    }
  });

  sock.ev.on('messages.upsert', async (ev) => {
    try {
      if (ev.type !== 'notify') return;
      for (const msg of ev.messages) {
        const k = (msg && msg.key) || {};
        const rawJid = k.remoteJid || '';
        const textoDbg = msg && msg.message && (msg.message.conversation
          || (msg.message.extendedTextMessage && msg.message.extendedTextMessage.text) || '');
        if (!msg.message || k.fromMe) {
          _pushDebug({ empresaId, acao: 'ignorado_fromMe_ou_vazio', rawJid, fromMe: !!k.fromMe, temMessage: !!(msg && msg.message) });
          continue;
        }
        if (rawJid.endsWith('@g.us') || rawJid.endsWith('@broadcast')) {
          _pushDebug({ empresaId, acao: 'ignorado_grupo', rawJid });
          continue; // grupo/status
        }
        // WhatsApp novo entrega mensagens de alguns contatos com um endereço
        // interno "@lid" no remoteJid — que NÃO é o número de telefone. Nesses
        // casos o número real vem em msg.key.senderPn (ex.: 5511...@s.whatsapp.net).
        // Sem isso, extraíamos um número errado e a resposta não chegava.
        const isLid = rawJid.endsWith('@lid');
        const pnRaw = (msg.key && (msg.key.senderPn || msg.key.participantPn)) || '';
        // Identificador do contato. No Baileys 7 as mensagens @lid quase sempre
        // vêm SEM senderPn — mas são válidas. Usamos o senderPn (número real) se
        // vier; caso contrário, os dígitos do próprio @lid como chave estável.
        const baseNumero = pnRaw ? pnRaw.replace(/@.*/, '') : rawJid.replace(/@.*/, '');
        const phone = baseNumero.replace(/\D/g, '');
        if (!phone) {
          _pushDebug({ empresaId, acao: 'ignorado_sem_numero', rawJid, isLid, texto: textoDbg });
          continue;
        }
        // Para onde responder: em chat @lid respondemos no PRÓPRIO jid @lid
        // (endereço canônico do WhatsApp novo, que o Baileys 7 entrega ok);
        // senão, número@s.whatsapp.net.
        const jidResposta = isLid ? rawJid : (phone + '@s.whatsapp.net');
        sessao.jids[phone] = jidResposta;
        if (isLid) console.log(`[BAILEYS] @lid processado: ${rawJid} -> chave ${phone} (responde em ${jidResposta})`);
        _pushDebug({ empresaId, acao: 'processado', rawJid, isLid, senderPn: k.senderPn || null, phoneResolvido: phone, jidResposta, texto: textoDbg });
        const m = msg.message;
        const texto = m.conversation
          || (m.extendedTextMessage && m.extendedTextMessage.text)
          || (m.imageMessage && m.imageMessage.caption)
          || (m.buttonsResponseMessage && m.buttonsResponseMessage.selectedDisplayText)
          || (m.listResponseMessage && m.listResponseMessage.title)
          || '';
        // contatos (vCard) compartilhados
        let contactArray = null;
        if (m.contactMessage) {
          contactArray = [{ vcard: m.contactMessage.vcard, displayName: m.contactMessage.displayName }];
        } else if (m.contactsArrayMessage && Array.isArray(m.contactsArrayMessage.contacts)) {
          contactArray = m.contactsArrayMessage.contacts.map(c => ({ vcard: c.vcard, displayName: c.displayName }));
        }
        const body = {
          phone,
          messageId: msg.key.id,
          fromMe: false,
          isGroup: false,
          text: texto ? { message: texto } : undefined,
          ...(contactArray ? { contactArray } : {})
        };
        if (_onMessage) { _onMessage(empresaId, body).catch(e => console.error('[BAILEYS] onMessage erro:', e.message)); }
      }
    } catch (e) { console.error('[BAILEYS] messages.upsert erro:', e.message); }
  });

  return sessao;
}

function getStatus(empresaId) {
  const s = sessoes[empresaId];
  if (!s) return { status: 'desconectado', numero: null, erro: _ultimoErro[empresaId] || null, tentativas: _tentativas[empresaId] || 0 };
  return { status: s.status, numero: s.numero, qrDataUrl: s.status === 'qr' ? s.qrDataUrl : null, erro: s.erro || _ultimoErro[empresaId] || null, tentativas: _tentativas[empresaId] || 0 };
}

function conectado(empresaId) {
  const s = sessoes[empresaId];
  return !!(s && s.status === 'conectado' && s.sock);
}

async function desconectar(empresaId) {
  const s = sessoes[empresaId];
  if (s && s.sock) { try { await s.sock.logout(); } catch (e) {} }
  delete sessoes[empresaId];
  await limparSessaoFirestore(empresaId);
}

// ---- Envio ---------------------------------------------------------------
function jidDe(phone) {
  return String(phone).replace(/\D/g, '') + '@s.whatsapp.net';
}

// Descobre o JID certo para enviar:
// 1) se já recebemos mensagem desse número, responde no MESMO jid (resolve @lid);
// 2) senão, valida no WhatsApp via onWhatsApp (resolve o "9" dos números do Brasil);
// 3) por último, monta número@s.whatsapp.net.
async function resolverJid(s, phone) {
  const num = String(phone).replace(/\D/g, '');
  if (s.jids && s.jids[num]) return s.jids[num];
  try {
    const res = await s.sock.onWhatsApp(num);
    if (res && res[0] && res[0].exists && res[0].jid) return res[0].jid;
  } catch (e) { console.error('[BAILEYS] onWhatsApp falhou:', e.message); }
  return num + '@s.whatsapp.net';
}

async function enviarTexto(empresaId, phone, message) {
  const s = sessoes[empresaId];
  if (!s || !s.sock || s.status !== 'conectado') throw new Error('WhatsApp (Baileys) não conectado');
  const jid = await resolverJid(s, phone);
  await s.sock.sendMessage(jid, { text: message });
  console.log(`[BAILEYS] texto enviado p/ ${jid} (origem ${phone})`);
}

async function enviarMidia(empresaId, phone, buffer, mimetype, caption, asDocument, fileName) {
  const s = sessoes[empresaId];
  if (!s || !s.sock || s.status !== 'conectado') throw new Error('WhatsApp (Baileys) não conectado');
  const jid = await resolverJid(s, phone);
  if (asDocument) {
    await s.sock.sendMessage(jid, { document: buffer, mimetype: mimetype || 'application/octet-stream', fileName: fileName || 'arquivo', caption: caption || '' });
  } else {
    await s.sock.sendMessage(jid, { image: buffer, caption: caption || '' });
  }
}

// Diagnóstico: tenta enviar e devolve TUDO (achou o número? qual jid? deu erro?).
async function diagnosticarEnvio(empresaId, phone, message) {
  const s = sessoes[empresaId];
  if (!s || !s.sock) return { ok: false, etapa: 'sessao', erro: 'Sessão não está na memória (servidor reiniciou?)', status: s ? s.status : 'desconectado' };
  if (s.status !== 'conectado') return { ok: false, etapa: 'status', erro: 'WhatsApp não está conectado', status: s.status };
  const num = String(phone).replace(/\D/g, '');
  let onw = null;
  try { const r = await s.sock.onWhatsApp(num); onw = (r && r[0]) || null; }
  catch (e) { return { ok: false, etapa: 'onWhatsApp', erro: e.message, status: s.status }; }
  const jid = (s.jids && s.jids[num]) || (onw && onw.jid) || (num + '@s.whatsapp.net');
  try {
    const sent = await s.sock.sendMessage(jid, { text: message });
    return { ok: true, status: s.status, jid, existe: !!(onw && onw.exists), msgId: sent && sent.key && sent.key.id, numeroConectado: s.numero };
  } catch (e) {
    return { ok: false, etapa: 'send', erro: e.message, jid, existe: !!(onw && onw.exists), status: s.status };
  }
}

module.exports = { init, iniciarSessao, getStatus, conectado, desconectar, enviarTexto, enviarMidia, diagnosticarEnvio, getDebug };
