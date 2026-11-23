# HANDOFF.md — Estado da última sessão de trabalho

> Escrito em 2026-11-23 porque o Alexandre vai trocar de conta Claude e a
> conta nova não vai ter acesso ao histórico desta conversa. Lido junto com
> [`CLAUDE.md`](./CLAUDE.md) (regras e estrutura do projeto) e
> [`PROJETO.md`](./PROJETO.md) (arquitetura completa).

## O que foi feito nas últimas sessões (mais recente primeiro)

1. **Paridade visual vendedor ↔ dono** (commit `2225c07`) — os cards de
   demonstração por nicho no painel do vendedor (`admin.html`, função
   `carregarNichosDemoVendedor`) estavam com UI antiga/feia comparada ao
   painel do dono (`minha-empresa-configurar.html`, `renderNichosLinks`).
   Reescrito pra usar exatamente o mesmo grid, padding, emoji e o botão
   "🔗 Copiar link" que faltava no lado do vendedor. **Status: no ar.**
2. **Reversão completa do overlay de QR Code sobre a foto do banner**
   (commits `f33456b` revertendo `f2b1173`/`596b913`/`abb3366`) — tinha sido
   construída uma solução de posição configurável/arrastável do QR por
   cima da imagem de fundo (`bannerFundoQrX/Y/W`, caixa verde arrastável,
   botão de pré-visualização). **O Alexandre rejeitou essa abordagem por
   completo** ("isso vai ficar uma bosta") — ele mesmo monta a arte final
   (foto + QR já desenhado) fora do sistema e só faz upload do resultado
   pronto. Tudo foi revertido: `server.js` (campos no `CAMPOS_NICHO`),
   `admin.html` e `minha-empresa-configurar.html` voltaram ao estado onde,
   com `bannerFundo` configurado, o sistema **só exibe a imagem**, sem
   desenhar nada por cima. **Não reintroduzir essa ideia de overlay.**
   **Status: no ar, revertido e confirmado.**
3. **Emojis corretos por nicho** — `NICHOS_EMOJI` em `admin.html` e
   `minha-empresa-configurar.html` não tinha entradas pra `pet-shop` nem
   `restaurante` (caía no genérico 🎯). Adicionado 🐶 e 🍽️. **Status: no
   ar.**
4. **Banner "totem" em tela cheia** (sizing) — ajuste de dimensionamento do
   banner em tela cheia (`abrirQrTelaCheia`/`abrirQrTelaCheiaVendedor`),
   feito e confirmado antes dos itens acima.

Todos os itens acima foram validados com `node --check` (backend e scripts
inline extraídos dos HTML) e testados visualmente via preview estático
antes do push. Push feito com confirmação explícita do Alexandre a cada
rodada.

## O que está funcionando / no ar agora

- Banner "totem" por nicho (tela cheia), com ou sem `bannerFundo` próprio,
  nos dois lados (dono e vendedor), com o mesmo visual.
- Emojis corretos nos cards de demonstração de todos os nichos cadastrados
  até agora (barbearia, cabeleireiro, dentista, estética, pet-shop,
  restaurante).
- Painel do vendedor (`/vendedor` em `admin.html`) com UI de nichos igual à
  do dono, incluindo "Copiar link".

## O que ficou pela metade ou com problema

- **Backup no pen drive (`BACKUP-ALEXANDRE`) falhou parcialmente** na
  última tentativa desta sessão — o Lexar parece ter desconectado no meio
  da cópia (erros de I/O em objetos `.git`, "Permission denied" criando a
  pasta do `prospectai-project`, `ULTIMA-ATUALIZACAO.txt` não foi escrito).
  O script loga "ok" no final mesmo assim (não usa `set -e`), então o
  status de sucesso **não é confiável sozinho** — sempre checar o log em
  `~/Documents/Backup Claude/ultimo-backup-pendrive.log`. Nesta sessão
  (2026-11-23), com o pen drive montado de novo, o backup foi re-executado
  como parte deste handoff — **confirmar o resultado olhando o log depois**.
- Itens de dívida técnica/pendências mais antigos, ainda válidos (ver
  seção 12 do `PROJETO.md` para o histórico completo):
  - Duplicação de configuração entre `crm.html` e
    `minha-empresa-configurar.html` ainda não foi totalmente centralizada
    (só "Conversa do cliente" foi migrada).
  - Revogação de token JWT antes de expirar (30 dias) não existe.
  - Sem testes automatizados, sem monitoramento (Sentry/health check).
  - Relatório de mensagens enviadas × abertas × respondidas foi cogitado,
    não construído.

## Próximos passos (ordem de prioridade sugerida)

1. **Confirmar que o backup do pen drive realmente completou** nesta
   rodada (ver log citado acima) — se falhar de novo, investigar se é o
   cabo/porta USB ou o próprio disco Lexar com problema de hardware (os
   erros de I/O e "unexpected end of file" sugerem conexão instável, não
   erro do script).
2. Continuar recebendo fotos de banner por nicho do Alexandre — lembrar
   que ele mesmo embute o QR Code na imagem antes de mandar pra upload; o
   sistema não deve tentar compor nada em cima.
3. Seguir a direção já combinada de centralizar configuração duplicada em
   `minha-empresa-configurar.html` (por partes, uma seção por vez).
4. Qualquer novo niche/card de demonstração: já nasce no padrão visual
   atual (grid, emoji específico, botão "Copiar link") nos dois painéis
   (dono e vendedor) ao mesmo tempo — não só num dos dois.

## Outros projetos do Alexandre (não ficam neste repositório)

Ele tem outros projetos sendo tocados em paralelo, cada um numa pasta
separada e **sem relação de código com este repo**: "80+" (longevidade,
~/projeto-80mais), "ProspectAI" (CRM de prospecção B2B,
~/Downloads/prospectai-project), "Aquecimento de chip" (~/aquecimento-chip)
e "Visita Vet" (visitavet.com.br). Se alguém mencionar um desses nomes,
não é este projeto.
