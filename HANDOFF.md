# HANDOFF.md — Estado da última sessão de trabalho

> Atualizado em 2026-11-25. Uma conta nova **não tem acesso ao histórico das
> conversas** das sessões anteriores. Este arquivo é a ponte. Leia junto com
> [`CLAUDE.md`](./CLAUDE.md) (regras e estrutura do projeto) e
> [`PROJETO.md`](./PROJETO.md) (arquitetura e modelo de dados completos).
> **Tudo descrito aqui como "no ar" já está commitado na `main` e em produção
> no Render**, salvo quando dito o contrário.

---

## 1. Visão geral — o que a plataforma já faz hoje (funcionalidades no ar)

Além do CRM/Kanban e do bot básico de recomendação (descritos no PROJETO.md),
estas funcionalidades mais recentes **já estão em produção**:

- **Fluxo curto do recomendador (GLOBAL).** Constante `FLUXO_CURTO_GLOBAL = true`
  em `server.js` (~linha 2938). Encurta a conversa pra: agradecimento → nome →
  contatos → prêmio na hora → 1 lembrete → fim. Elimina o "Modo Full" e **todas
  as perguntas de "já avisou os amigos?"** (follow-up/confirmação/enviei) pra
  reduzir abandono. A pergunta "Quem te atendeu?" (vendedor) foi **mantida
  condicional** (só pergunta se a empresa tem vendedores cadastrados). É
  reversível: basta trocar a constante pra `false`. Vale pra todos os funis.
- **Diagnóstico de não-entrega (shadow ban) + Teste de entrega.** A causa real
  da "mensagem enviada mas não entregue" no Z-API foi confirmada como
  **SHADOW_BAN do WhatsApp** (não é bug de código/plano/conexão). Há um botão
  **"🧪 Teste de entrega"** no painel (`minha-empresa-configurar.html`) +
  endpoint `POST /minha-entrega/testar` + captura do `DeliveryCallback`
  (`guardarStatusCallback`, ~linha 1666) que mostra o `errorCode` real
  (ex.: `SHADOW_BAN`). **Fix definitivo = API Oficial / modelo inbound**, não
  tem conserto no não-oficial.
- **WhatsApp API Oficial (Meta) — pronta e testada.** Migração validada:
  número de produção, token permanente, template real `recomenda_amigos`
  (Marketing), recebe+responde OK. **Loose end conhecido:** a Meta bloqueia
  com erro **131049 "Re-engagement message"** quem **nunca abre/responde** —
  é filtro POR NÚMERO (não por conta). Pra testar entrega, use sempre um
  número que você realmente abre/responde, senão parece que "não entregou".
- **Canal Evolution (iFinZap) — passo 1 feito.** Botão "🧪 Testar envio
  Evolution" + endpoint `POST /minha-evolution/testar` (~linha 7970) que bate
  na instância real, testa os 2 formatos de `sendText` e mostra o estado da
  conexão. **Objetivo: travar o formato certo antes de construir o canal
  completo.** (Ver seção "Pela metade" abaixo.)
- **Follow-up do recomendador.** Motor `cadenciaFollowupRecomendado` + engine
  `agendarProximoFollowup` (processador ~linha 11518): até N lembretes pro
  recomendador avisar os amigos; para sozinho se a pessoa responde. **Default
  hoje = 1 toque (1440 min).** Painel liga/edita/testa. Default OFF por empresa.
- **Atendimento pós-fluxo (IA).** O robô responde dúvidas do cliente
  (endereço/horário/site) com IA Claude usando **só** as infos cadastradas na
  seção "Informações do negócio". Default OFF.
- **Anti-ban.** Escalonamento com jitter, humanização, opt-out e rotação de
  saudações (3 versões). Denúncia é o maior gatilho de ban → follow-up ajuda.
- **Pré-pago + disparo em massa (API Oficial).** Cobra por mensagem
  (mkt ~R$0,35 / utility ~R$0,05 / serviço 24h grátis), bloqueia no saldo
  zero; admin lança recarga; cliente tem aba "Disparo em massa".
- **Onboarding/venda.** Autocadastro do cliente (link fixo `/cliente/cadastro`),
  contrato com preço real, **Pix automático via Asaas** libera o acesso na
  hora. Programa de Representantes/Afiliados no `/admin` (comissão 20%, paga
  manual) com CTA pra criar conta no Asaas.
- **Rankings da iFinc (Mesa e Head)** — placar de vendas para a TV, com
  lançamento diário e acumulado do mês (`rankingmesa.js` +
  `ranking-mesa.html`). **No ar:**
  - Mesa (TV): https://recomendaleads.com.br/rankingmesa
  - Mesa (lançar): https://recomendaleads.com.br/rankingmesa/admin
  - Head (TV): https://recomendaleads.com.br/rankinghead
  - Head (lançar): https://recomendaleads.com.br/rankinghead/admin

  Os dados começaram com a planilha "IFinc Mesa (Respostas)" de 22/10/2026,
  e desde então o lançamento é feito direto no `/admin`. O `/admin` abre
  **sem senha**, porque não há `RANKINGMESA_SENHA` no Render. Quem tiver o
  link pode alterar os números, então só o link da TV deve ser compartilhado.
- **Pagamentos e comissões (revisados em 24 e 25/11/2026).** Regras vigentes:
  - **O desconto sai de quem fecha a venda**, nunca da empresa (R$ 200):

    | Venda | Empresa | Representante | Afiliado |
    |---|---|---|---|
    | Direta R$ 397 | 200 | 197 | — |
    | Direta R$ 347 | 200 | 147 | — |
    | Direta R$ 297 | 200 | 97 | — |
    | Com Afiliado R$ 397 | 200 | 97 | 100 |
    | Com Afiliado R$ 347 | 200 | 97 | 50 |

    Cálculo em `calcularComissaoCentavos`. Quem recebe por percentual não muda.
    Contrato do Representante/Afiliado (Anexo I) na **versão 1.1-2026-11-24**.
  - **Cadastrar Afiliado** fica no `/vendedor` (só Representante vê; Afiliado
    não recruta Afiliado) e em Minha Empresa → Cadastro de cliente.
  - **Pix da adesão** (`POST /assinar/adesao`): CPF/CNPJ conferido antes de
    criar a conta; sem CNPJ usa o CPF do sócio; erro mostra o motivo ou a etapa
    (`COBRANCA`, `QRCODE`); "Tentar de novo" reaproveita a cobrança em aberto.
  - **Cartão:** o botão depois do cadastro leva `?empresa=ID` e a assinatura
    entra nessa empresa (`garantirContaSignup`, em transação).
  - **Webhook `/webhook-asaas`:** no cartão a Asaas avisa o mesmo pagamento 2x
    (CONFIRMED e, ~30 dias depois, RECEIVED). O prazo conta da data do pagamento
    e nunca encurta; a comissão tem ID fixo por pagamento + vendedor.
  - O bloqueio por falta de pagamento encontrado é **só no painel** (leva o
    gestor pra Assinatura); não foi achada trava por pagamento no robô.
- **Landing de captação de parceiros** em `/parceiro` (`parceiro.html`).
  ⚠️ **Esse arquivo fica SEMPRE fora dos commits** — o Alexandre edita por
  fora (está modificado no working tree de propósito; não commitar).

## 2. O que foi feito nas sessões mais recentes (mais novo primeiro)

0. **Afiliado, comissões, Pix e cartão (24 e 25/11/2026). Tudo no ar:**
   - `363a9e4` card "Cadastrar Afiliado" no `/vendedor` (visto pelo Alexandre).
   - `3fc138b` desconto do Afiliado + Anexo I versão 1.1.
   - `c7241e8` Pix mais robusto + desconto da venda direta. **QR real gerado**
     na página `/assinar` (não pago).
   - `5017a18` conta duplicada no cartão.
   - `2998340` renovação do acesso em toda mensalidade.
   - `9fd3fbc` uma comissão por pagamento.

   ⚠️ Cartão, renovação e comissão foram testados **só com Asaas e banco
   simulados**. O caminho do Pix pelo cadastro do cliente também. Os 3 links de
   cartão (397/347/297) foram abertos na Asaas, sem pagar.
1. **Revisão da página de vendas (2026-11-23, sem alterar nada).** Revisamos a
   `landing-nova.html` (servida na raiz `recomendaleads.com.br`, rota
   `app.get('/')` ~linha 6082) ao vivo. **Nenhuma mudança feita** — ficou
   acordado que eu só analisaria. Três pontos levantados pra ele decidir:
   (a) **a página não mostra preço em lugar nenhum** (R$500 adesão + R$397/mês
   só aparecem no `/assinar`) — decisão consciente pendente; (b) os 2 CTAs do
   topo levam pra *demonstração* e *calculadora*, e o CTA de **fechar só
   aparece no rodapé** — falta caminho direto de compra no meio; (c) há
   **seções repetidas** (WhatsApp+painel 2×, Simulação+Calculadora 2×) — dá
   pra encurtar ~20%. **Nada decidido ainda.**
2. **Explicação do formulário Pix do `/assinar`.** O Alexandre perguntou por
   que o Pix pede Nome/CPF-CNPJ/E-mail/WhatsApp. Resposta: é cobrança
   registrada pela **Asaas**, que **exige criar um "customer" (nome +
   CPF/CNPJ obrigatórios)** antes de gerar o QR — ver `garantirAsaasCustomerPix`
   (`server.js` ~linha 220). E-mail/WhatsApp servem pra criar/liberar a conta
   e mandar o acesso. **Ele decidiu deixar como está.**
3. **Paridade visual vendedor ↔ dono** (commit `2225c07`) — cards de
   demonstração por nicho no `/vendedor` (`admin.html`) reescritos pra ficar
   idênticos ao painel do dono (`minha-empresa-configurar.html`), com o botão
   "🔗 Copiar link" que faltava. **No ar.**
4. **Reversão completa do overlay de QR sobre a foto do banner** (`f33456b`
   revertendo `f2b1173`/`596b913`/`abb3366`). Tinha sido feita posição
   configurável/arrastável do QR por cima da imagem; **o Alexandre rejeitou
   por completo** ("isso vai ficar uma bosta"). Ele monta a arte final (foto +
   QR já embutido) por fora e só faz upload. Com `bannerFundo`, o sistema **só
   exibe a imagem**, sem desenhar nada por cima. **NÃO reintroduzir overlay.**
5. **Rankings iFinc (outubro a novembro de 2026).** O ranking começou como
   painel no Claude lendo o Google Sheets e virou um módulo do site.
   Também foram feitos: TV e admin separados, desempate pelas pastas abertas
   (caso Jaqueline), tudo numa tela só (TV e "Ver ranking" no admin), `/admin`
   sem senha e a versão Head, que usa o mesmo motor. Em 11/11 o Alexandre só
   pediu os links, sem mudanças.
6. **Emojis corretos por nicho** — adicionado 🐶 (pet-shop) e 🍽️ (restaurante)
   no `NICHOS_EMOJI` (`admin.html` e `minha-empresa-configurar.html`). **No ar.**

Validação de tudo: `node --check server.js` + check dos scripts inline dos
HTML. Push sempre com confirmação explícita do Alexandre.

## 3. O que ficou pela metade ou com problema

- **Conferir o primeiro pagamento real no cartão:** assinatura na empresa certa,
  sem outra empresa criada, e **uma** comissão por pessoa. Conferir também a
  primeira renovação. Em 25/11 não havia nenhuma comissão registrada.
- **Decisões que são do Alexandre (25/11/2026):**
  - Testes vencidos: **Studio Carly** (30/09) e **Poder do Network** (27/10), as
    duas sem assinatura no cartão.
  - **CEN**: WhatsApp caído há mais de 130 dias.
  - Limpeza: empresa "teste pizza" e o "Teste Fluxo Novo" na lista de
    Representantes (a *empresa* com esse nome já foi excluída).
  - Formalizar por escrito o Anexo I 1.1 com os Representantes que aceitaram a
    versão 1.0 (cláusula 5.4). Não havia Afiliado cadastrado até 24/11.
  - Semestral/anual: a comissão fixa é registrada **uma vez só**, sem multiplicar
    pelos meses.
  - Rankings Mesa e Head estavam **zerados em novembro** em 24/11.
- **Limites conhecidos do cartão:** o link de Minha Empresa → Cadastro de cliente
  é pra cliente NOVO (quem já tem conta e usa esse link ainda cria outra); links
  enviados antes de 25/11, 10h, não têm o vínculo; contas já duplicadas não foram
  juntadas; CNPJ com letras não é aceito pela máscara (usar o CPF do sócio).
- **Canal Evolution completo + failover híbrido — EM PAUSA.** Em 24/11 o
  Alexandre mandou **esquecer o iFinZap**, que era o servidor dos testes; sem
  ele não há servidor Evolution. Não retomar sem ele pedir. Contexto: só o
  botão/endpoint de teste foi feito. Falta, depois de o Alexandre rodar o teste
  e confirmar o formato do `sendText`: construir `whatsappTipo: 'evolution'`
  (config, send de texto/imagem/documento, webhook
  `/webhook-evolution/:empresaId` com parser do payload real) e **depois** a
  lógica de **failover híbrido** (2 não-oficiais trabalhando juntos + 1 oficial
  de backup; trocar o número **no início de conversa nova**, nunca no meio).
  ⚠️ Evolution também é não-oficial (Baileys) → sofre o **mesmo shadow ban**;
  espalha/dá resiliência, não elimina.
- **Follow-up mais longo (Studio Carly / Joyce Carly).** O Alexandre quer
  cadência mais longa pra manter clientes ativos (hoje é 1 toque). Plano:
  estender `cadenciaFollowupRecomendado` pra multi-toque (ex.: 1d/3d/7d/14d)
  com textos distintos. ⚠️ Passos fora da janela de 24h exigem **template da
  API Oficial** — não dá pra mandar texto livre.
- **Subdomínios dos rankings** (`rankingmesa.` e
  `rankinghead.recomendaleads.com.br`) **ainda não foram cadastrados** no
  Render (Settings → Custom Domains) nem no DNS (CNAME). Até isso ser feito,
  use os endereços `/rankingmesa` e `/rankinghead`. Se quiser senha no
  `/admin` de novo, basta criar `RANKINGMESA_SENHA` no Render, sem mexer no
  código.
- **Melhorias da página de vendas** — levantadas (preço, CTAs, repetição),
  **nenhuma decidida nem implementada**.
- **Backup no pen drive (`BACKUP-ALEXANDRE`)** já falhou parcialmente em
  sessão anterior (Lexar desconectando no meio, erros de I/O). O script loga
  "ok" mesmo quando o rsync falha (`set -uo pipefail`, sem `-e`) → **conferir
  sempre o log** em `~/Documents/Backup Claude/ultimo-backup-pendrive.log`.
- Dívida técnica antiga ainda válida (seção 12 do `PROJETO.md`): config
  duplicada entre `crm.html` e `minha-empresa-configurar.html` só parcialmente
  centralizada; sem revogação de JWT antes dos 30 dias; sem testes
  automatizados nem monitoramento (Sentry/health check).

## 4. Próximos passos (ordem de prioridade sugerida)

1. **Conferir o primeiro pagamento real no cartão** (ver seção 3).
2. **Follow-up longo** pra reter clientes (começar pela Studio Carly, que já está
   na API Oficial), com template pros toques fora da janela de 24h. Em 24/11 ele
   disse "agora não".
3. **Página de vendas:** se ele decidir, tratar os 3 pontos (mostrar preço /
   reforçar CTA de fechamento / enxugar repetições) — 1 por vez.
4. **Migrações Z-API → API Oficial** seguindo a regra "um número = um
   sistema" (não deixar o mesmo número ativo nos dois, senão a mensagem some).
5. **Rankings iFinc:** se o Alexandre quiser, apontar os subdomínios
   (Render + DNS) e decidir se o `/admin` volta a ter senha.
6. **Evolution:** em pausa, só se o Alexandre pedir.
7. Novo nicho/card de demonstração: já nasce no padrão visual atual (grid,
   emoji específico, "Copiar link") **nos dois painéis** ao mesmo tempo.

## 5. Como continuar com segurança (resumo das regras — detalhe no CLAUDE.md)

- **Sempre em português.** Avançar **1 funcionalidade por vez**. Mandar prints
  → analisar a imagem antes de propor fix.
- **Nunca `git push` sem o "sim" explícito** dele (main = produção, sem
  staging).
- **`parceiro.html` nunca entra em commit.** Overlay de QR sobre foto:
  **rejeitado, não reintroduzir.** Copy sempre "**recomendar**", nunca
  "indicar".
- Rodar o `server.js` local é arriscado (cron jobs mandam WhatsApp real) e
  exige segredos que só estão no Render → usar preview estático ou olhar o
  site ao vivo. ⚠️ O `http.server` serve a pasta inteira, **inclusive o `.env`**:
  sempre com `--bind 127.0.0.1` e desligar ao terminar.
- O navegador do Claude **bloqueia caixas de confirmação** (`confirm`): exclusões
  no `/admin` o Alexandre faz no navegador dele.
- Deploy que só muda o `server.js`: confirmar pelo `last-modified` de qualquer
  página no ar.

## 6. Outros projetos do Alexandre (NÃO são este repositório)

Tocados em paralelo, cada um em pasta separada, **sem relação de código com
este repo**: "**80+**" (longevidade, `~/projeto-80mais`), "**ProspectAI**"
(CRM de prospecção B2B, `~/Downloads/prospectai-project`), "**Aquecimento de
chip**" (`~/aquecimento-chip`) e "**Visita Vet**" (visitavet.com.br). Também em paralelo estão o
**iFincZap**, um CRM central para os 20 números de WhatsApp Business dos
consultores da iFinc, em planejamento, e os negócios de fotos temáticas e de
música personalizada. (Só os **Rankings iFinc** e o teste do Evolution
"iFinZap" moram neste repo.) Se
aparecer um desses nomes, **não é este projeto** — não misturar.
