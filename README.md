# Zap Hub

Aplicação local de clientes, cobranças mensais e lembretes de pagamento pelo WhatsApp. Backend Node.js 24 + Express, SQLite e interface responsiva em português, sem dependência de serviço de banco externo.

## Iniciar

```powershell
cd 'D:\Sistemas Paratech\IntegraZap\Zap_Hub'
npm install
npm start
```

Acesse http://127.0.0.1:3090 e crie a senha de administrador (mínimo de 10 caracteres). O primeiro acesso deve ser local ao servidor. O banco inicia vazio e o modo padrão é **simulação**, com a rotina automática pausada.

1. Cadastre nome, empresa, WhatsApp internacional (55 + DDD + número) e CPF válido.
2. Crie uma cobrança com nome da fatura, valor, dia de vencimento, início e término.
3. Personalize os lembretes e confira a prévia com campos substituíveis.
4. Execute uma simulação e confira o histórico.
5. Configure Uazapi e InfinitePay, ative o modo real e, quando desejar, a rotina automática.

## Regras de cobrança

- Referência automática por mês, como 01/2026 e 02/2026. Uma fatura por cobrança e referência; valores armazenados em centavos.
- Geração desde o início da cobrança até o término, limitada ao mês atual + 2. Um cadastro retroativo também gera faturas passadas. Confira-as e registre as já pagas antes de ativar envios reais.
- Dias 29–31 são ajustados ao último dia dos meses curtos.
- As datas de início e término limitam vencimentos **e envios**. Um aviso anterior ao início só se torna elegível no início. Após o término, nenhum aviso é enviado, inclusive de atraso.
- Alterar uma cobrança só afeta faturas ainda não geradas. Para corrigir faturas emitidas, cancele-as e cadastre uma nova cobrança com o período correto. Cancelamento não estorna pagamento nem invalida checkout no provedor.
- Lembretes globais, aplicados a todas as cobranças: negativos antes do vencimento, zero no dia, positivos após. Padrões: -5, 0 e +5 dias. Cada intervalo permite um lembrete ativo; novos lembretes no mesmo dia são rejeitados.
- Cada lembrete é processado uma vez por fatura e modo. Editar seu texto não reenvia lembretes já processados. Se o servidor ficar indisponível, recupera apenas o lembrete mais recente elegível para cada fatura.
- Simulações não chamam provedores e não impedem o envio real posterior.
- Faturas pagas/canceladas, clientes inativos e cobranças pausadas não recebem mensagens.
- A automação roda a cada minuto, na janela configurada até 20h, no fuso America/Sao_Paulo. Execução manual ignora a janela e a pausa da rotina.
- O aviso de bloqueio é apenas comunicação. Não existe bloqueio automático de serviços externos.
- Falhas ficam no histórico. Respostas incertas não são reenviadas automaticamente: confira no provedor e libere nova tentativa pelo histórico. Aceitação pela Uazapi não comprova entrega ou leitura.

## Campos de mensagem

`{{nome_cliente}}`, `{{empresa}}`, `{{whatsapp}}`, `{{cpf}}`, `{{nome_fatura}}`, `{{numero_fatura}}`, `{{valor}}`, `{{referencia}}`, `{{vencimento}}`, `{{link_pagamento}}`, `{{inicio_cobranca}}`, `{{termino_cobranca}}`, `{{dias_atraso}}`.

## Integrações

**Uazapi:** informe URL HTTPS do servidor (sem caminho) e token da instância já conectada. O teste de conexão consulta `/instance/status`; envios usam `/send/text` com `number`, `text` e cabeçalho `token`. Tokens nunca são devolvidos ao navegador, e são armazenados usando AES-256-GCM.

**InfinitePay:** habilite Checkout Integrado na conta e informe sua InfiniteTag, sem `$`. A URL pública HTTPS do Zap Hub precisa estar acessível pela Internet para retorno e webhook. Links usam `POST https://api.checkout.infinitepay.io/links`; a confirmação usa `POST /payment_check`. Cada fatura preserva a InfiniteTag usada na criação do link.

O checkout hospedado aceita Pix e cartão. A documentação consultada não fornece um parâmetro para restringir apenas ao Pix. As mensagens orientam Pix. Não há geração local de QR Code/copia e cola, Pix automático, estorno ou cobrança automática na conta do cliente.

Webhook: `POST /webhooks/infinitepay`. Retorno do checkout: `GET /pagamento`. Recebimentos são colocados em fila persistente, e **só são baixados após confirmação servidor a servidor de pedido e valor**. Eventos repetidos são idempotentes. Falhas de confirmação são tentadas até 20 vezes com espera crescente, e depois registradas no painel. O retorno do navegador, isoladamente, nunca comprova pagamento. Se nenhum evento chegar, utilize o comprovante do provedor para a baixa manual. A confirmação depende de servidor online e configuração pública correta.

Fontes consultadas:

- https://docs.uazapi.com/openapi-bundled.json
- https://ajuda.infinitepay.io/pt-BR/articles/10766888-como-usar-o-checkout-integrado-da-infinitepay

## Operação e dados

### Publicação no Railway

O `Dockerfile` utiliza Node.js 24 e o `railway.toml` define uma réplica com verificação em `/healthz`. No serviço, monte um volume persistente em `/data` e mantenha o modo de suspensão desativado para a rotina de lembretes funcionar sem visitas ao site.

Configure `PORT=3000` e um `SETUP_TOKEN` aleatório nas variáveis do Railway. O primeiro acesso pede esse código e permite que o administrador escolha sua senha. Depois de criar o acesso, o código não é mais usado para login. Não coloque o código no GitHub. Os demais padrões de produção (host público, diretório de dados e cookie seguro) estão no Dockerfile.

No Windows deste projeto, `scripts/railway.ps1` utiliza exclusivamente a credencial do Zap_Hub, protegida por DPAPI em `%LOCALAPPDATA%/ZapHub/railway-token.dpapi`, e preserva o login global. Exemplo: `./scripts/railway.ps1 status --json`. Para operações que exigem destino explícito, use o projeto `9632c69c-16f1-42ca-94ea-d694a01f6886`, ambiente `64799ecb-eef2-447b-a88e-3d1e24f0c47c` e o serviço configurado no Railway.

- Copie `.env.example` para `.env` para alterar host e porta. Acesso local padrão: `127.0.0.1:3090`.
- Para publicar, utilize um processo Node supervisionado e proxy reverso HTTPS; defina `COOKIE_SECURE=true`. Não publique o diretório `data` nem a porta do servidor diretamente. Em instalação remota, configure `SETUP_TOKEN` antes de abrir o primeiro acesso.
- Esta versão é para um administrador e uma instância de processo. Sessões expiram em 12 horas e são invalidadas ao reiniciar o processo. Não execute várias réplicas sobre o mesmo arquivo SQLite.
- Preserve todo o diretório `data`: banco `zap-hub.sqlite`, arquivos WAL/SHM quando presentes e `secret.key`. A chave é necessária para descriptografar o token. Para backup simples e consistente, pare o servidor e copie a pasta inteira. Proteja o diretório com permissões do sistema operacional. Dados cadastrais não têm criptografia integral em disco.
- Não há credenciais reais embutidas, dados demonstrativos no banco normal ou mensagens enviadas durante os testes.
- O servidor precisa permanecer ligado para gerar novas referências e enviar os avisos.

## Verificação

```powershell
npm run check
npm test
```

Os testes cobrem datas, validação, recorrência, substituição de campos, duplicações, pausas, baixa de pagamento, falhas de envio, autenticação e proteção do token. Provedores são simulados; homologação com sua conta e um número de teste ainda é necessária.

`node tests/preview-server.js` inicia uma instância descartável na porta 3091 para QA visual, com dados fictícios, senha de teste `Visual-Test-2026` e provedores desativados. Encerre com Ctrl+C. Nunca utilize essa instância em produção.
