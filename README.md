# RecomendaLeads Bot

Servidor de automação WhatsApp que conduz o roteiro de neurovendas do
Método Poder da Recomendação, integrado à Z-API.

## Variáveis de ambiente necessárias

Configure estas 3 variáveis no painel do Render (ou no arquivo `.env` localmente):

- `ZAPI_INSTANCE_ID` — ID da sua instância Z-API
- `ZAPI_TOKEN` — Token da sua instância Z-API
- `ZAPI_CLIENT_TOKEN` — Client-Token (Security Token) da sua conta Z-API,
  encontrado em "Segurança" no painel da Z-API

## Como configurar o webhook na Z-API

1. No painel da Z-API, vá em "Webhooks e configurações gerais"
2. Em "Ao receber", cole a URL exibida no painel admin de cada empresa
   (formato `https://www.recomendaleads.com.br/webhook/ID-DA-EMPRESA`)
3. Salve

## Rotas disponíveis

- `GET /` — health check, confirma que o servidor está no ar
- `GET /status` — mostra a configuração da empresa e as sessões ativas
- `POST /config` — atualiza a configuração da empresa (vendedores, faixas de bônus, mensagens)
- `POST /webhook` — recebida pela Z-API a cada mensagem nova

## Roteiro implementado

1. Cliente envia "quero meu presente" (ou qualquer mensagem, se for o primeiro contato)
2. Bot agradece e pergunta o nome
3. Bot pergunta quem atendeu (lista numerada de vendedores)
4. Bot pede recomendações até atingir a primeira faixa de bônus configurada
5. Bot aceita contatos via cartão da agenda (vCard) ou texto livre ("Nome - telefone")
6. Ao atingir a meta, bot entrega o voucher e avisa para o cliente avisar os amigos
7. Após o tempo configurado (padrão 60 min), cada amigo recebe a mensagem de conversão
   automaticamente, citando quem o recomendou e o presente que ganhou

## Limitações desta primeira versão

- Armazenamento em arquivo local (`db.json`) — funciona para validar, mas os dados
  não persistem entre deploys no Render free tier (o disco é efêmero). Para uso em
  produção real, migrar para um banco como Firebase Firestore ou PostgreSQL.
- Suporta uma única empresa por instância (não é multi-tenant ainda).
- Followup automático por inatividade ainda não implementado nesta versão.
