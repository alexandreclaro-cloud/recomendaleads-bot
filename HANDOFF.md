# HANDOFF.md — Estado da última sessão de trabalho

> Atualizado em 2026-11-23 porque o Alexandre vai trocar de conta Claude e a
> conta nova **não terá acesso ao histórico das conversas nem à memória** das
> sessões anteriores. Este arquivo é a ponte. Leia junto com
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
- **Landing de captação de parceiros** em `/parceiro` (`parceiro.html`).
  ⚠️ **Esse arquivo fica SEMPRE fora dos commits** — o Alexandre edita por
  fora (está modificado no working tree de propósito; não commitar).

## 2. O que foi feito nas sessões mais recentes (mais novo primeiro)

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
5. **Emojis corretos por nicho** — adicionado 🐶 (pet-shop) e 🍽️ (restaurante)
   no `NICHOS_EMOJI` (`admin.html` e `minha-empresa-configurar.html`). **No ar.**

Validação de tudo: `node --check server.js` + check dos scripts inline dos
HTML. Push sempre com confirmação explícita do Alexandre.

## 3. O que ficou pela metade ou com problema

- **Canal Evolution completo + failover híbrido (PRÓXIMO GRANDE PASSO).** Só o
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

1. **Evolution:** Alexandre roda o "Testar envio Evolution" no painel → com o
   formato confirmado, construir o canal completo e depois o failover híbrido.
2. **Follow-up longo** pra reter clientes (começar pela Studio Carly), usando
   template da API Oficial pros toques fora da janela de 24h.
3. **Página de vendas:** se ele decidir, tratar os 3 pontos (mostrar preço /
   reforçar CTA de fechamento / enxugar repetições) — 1 por vez.
4. **Migrações Z-API → API Oficial** seguindo a regra "um número = um
   sistema" (não deixar o mesmo número ativo nos dois, senão a mensagem some).
5. Novo nicho/card de demonstração: já nasce no padrão visual atual (grid,
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
  site ao vivo.

## 6. Outros projetos do Alexandre (NÃO são este repositório)

Tocados em paralelo, cada um em pasta separada, **sem relação de código com
este repo**: "**80+**" (longevidade, `~/projeto-80mais`), "**ProspectAI**"
(CRM de prospecção B2B, `~/Downloads/prospectai-project`), "**Aquecimento de
chip**" (`~/aquecimento-chip`) e "**Visita Vet**" (visitavet.com.br). Se
aparecer um desses nomes, **não é este projeto** — não misturar.
