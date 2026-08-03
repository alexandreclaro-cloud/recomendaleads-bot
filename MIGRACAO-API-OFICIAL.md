# Migração para a API Oficial do WhatsApp (Meta Cloud API)

> Guia de execução. O **código já está pronto** (modo `whatsappTipo: 'oficial'`,
> commit `f40ee4c`), isolado do Z-API. Quando decidirem migrar um cliente,
> basta seguir os passos abaixo. Nada aqui afeta quem está no Z-API hoje.

## Decisão de rota (já tomada)
- **Direto na Meta Cloud API** (sem BSP). Mais barato: só paga conversa
  (serviço = grátis; template ao recomendado ~R$ 0,35). Sem mensalidade.
- Onboarding **MVP por credenciais manuais**. O "1-clique" (Embedded Signup)
  fica pra fase 2, quando virarmos Tech Provider da Meta.

## Custos de referência (Brasil, 2026)
- Conversa de **serviço** (cliente chama e responde em 24h): **grátis** (1.000/mês grátis + serviço isento).
- **Utility**: ~R$ 0,04–0,08 · **Marketing/Template**: ~R$ 0,35.
- Acesso à API: grátis. Cobrança nativa em BRL prevista p/ 2º sem/2026.

---

## Passo a passo (por cliente)

### 1. Setup na Meta (feito pelo cliente / por nós com acesso)
1. Criar conta no **Meta Business** e **verificar a empresa** (documentos).
2. Criar um **App** em developers.facebook.com → produto **WhatsApp**.
3. Criar/associar a **WhatsApp Business Account (WABA)**.
4. Adicionar o **número** (sai do app normal do WhatsApp) e verificar por SMS/ligação.
5. Gerar um **token permanente** (System User no Business Manager, com permissões
   `whatsapp_business_messaging` + `whatsapp_business_management`).
6. Anotar: **Phone Number ID** e **WABA ID** (ficam na tela do WhatsApp no app).

### 2. Aprovar o template do recomendado (obrigatório)
Na Meta (WhatsApp Manager → Modelos de mensagem), criar um template **Utility ou
Marketing**, categoria à escolha, idioma **pt_BR**, com **3 variáveis no corpo, nesta ordem**:
- `{{1}}` = nome do recomendado
- `{{2}}` = quem recomendou
- `{{3}}` = empresa

Exemplo de corpo (ajustar à marca):
> Olá {{1}}! O(a) {{2}} recomendou você para receber um presente da {{3}} 🎁
> Posso te explicar rapidinho?

Aguardar **aprovação** da Meta (minutos a horas). Anotar o **nome** do template.

### 3. Configurar no painel RecomendaLeads
Logado como a empresa → **WhatsApp → "API Oficial"**:
- **Phone Number ID**, **Token de acesso (permanente)**, **Verify Token** (você
  escolhe uma frase qualquer, ex.: `recomendaleads-2026`), **WABA ID** (opcional),
  **Nome do template do recomendado**.
- Copiar a **URL de Webhook** mostrada (formato `.../webhook-oficial/<empresaId>`).
- Clicar **Salvar API Oficial** → isso ativa o modo `oficial`.

### 4. Configurar o webhook no app da Meta
No App da Meta → WhatsApp → Configuração → **Webhook**:
- **Callback URL**: a URL copiada no passo 3.
- **Verify Token**: o mesmo do passo 3.
- **Assinar** o campo **`messages`**.

### 5. Testar ponta a ponta
- Cliente manda "quero meu presente" pro número → bot responde (conversa de serviço, grátis).
- Fluxo completo até o recomendado → a 1ª msg ao recomendado sai como **template**.
- Verificar no CRM se o card move (Recebeu Mensagem → Recebeu o Prêmio).

---

## Referência técnica (o que já existe no código)
- Envio: `sendText` / `sendImage` / `sendDocument` têm branch `oficial` (Cloud API + upload de mídia).
- `sendTemplate(phone, nome, [p1,p2,p3])` — usado em `iniciarConversaRecomendado` no modo oficial.
- Webhook: `GET/POST /webhook-oficial/:empresaId` (verificação + tradução do payload; anti-forja por `phone_number_id`).
- Credenciais por empresa: `oficialPhoneId`, `oficialToken`, `oficialVerifyToken`, `oficialWabaId`, `oficialTemplateRecomendado`.
- Endpoint de salvar: `POST /minha-whatsapp/oficial`. Status: `GET /minha-whatsapp`.
- Versão da Graph API: env `META_GRAPH_VERSION` (default `v21.0`).

## Fase 2 (quando escalar) — Embedded Signup 1-clique
Virar **Tech Provider** da Meta (revisão de app) e embutir o Embedded Signup no
painel, pro cliente conectar o número com login do Facebook, sem colar credencial.
