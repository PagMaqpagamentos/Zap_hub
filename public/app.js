const $ = (s) => document.querySelector(s),
  app = $("#app"),
  dialog = $("#dialog");
let state,
  page = "dashboard",
  search = "",
  filter = "all";
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const brl = (n) =>
    (n / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" }),
  date = (s) => s?.split("-").reverse().join("/") || "—";
const ref = (s) => s.split("-").reverse().join("/");
const client = (id) => state.clients.find((c) => c.id === id),
  plan = (id) => state.plans.find((p) => p.id === id);
const status = (i) =>
  i.status === "pending"
    ? i.due < state.today
      ? "overdue"
      : "pending"
    : i.status;
const labels = {
  pending: "Em aberto",
  overdue: "Vencida",
  paid: "Paga",
  cancelled: "Cancelada",
  simulated: "Simulado",
  sent: "Enviado à Uazapi",
  failed: "Falha",
  uncertain: "Verificar envio",
  preparing: "Preparando",
  sending: "Enviando",
  skipped: "Ignorado",
};
const badge = (s, label) =>
  `<span class="pill ${["paid", "sent"].includes(s) ? "green" : ["overdue", "failed", "uncertain"].includes(s) ? "red" : ["pending", "simulation", "simulated"].includes(s) ? "amber" : "gray"}"><span class="dot"></span>${esc(label || labels[s] || s)}</span>`;
const btn = (label, action, id = "", cls = "") =>
  `<button class="${cls}" data-action="${action}" data-id="${esc(id)}">${label}</button>`;
const field = (label, name, value = "", type = "text", extra = "", help = "") =>
  `<label class="field">${label}<input name="${name}" type="${type}" value="${esc(value)}" ${extra}>${help ? `<small>${help}</small>` : ""}</label>`;
const check = (name, label, value) =>
  `<label class="check"><input name="${name}" type="checkbox" ${value ? "checked" : ""}>${label}</label>`;
function toast(text) {
  $("#toast").textContent = text;
  $("#toast").style.display = "block";
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => ($("#toast").style.display = "none"), 5000);
}
async function api(url, body, method = body ? "POST" : "GET") {
  const r = await fetch("/api" + url, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await r
    .json()
    .catch(() => ({ error: "Resposta inválida do servidor" }));
  if (!r.ok) {
    if (r.status === 401) {
      dialog.close();
      await boot();
    }
    throw new Error(data.error || "Operação não concluída");
  }
  return data;
}
async function refresh() {
  state = await api("/state");
  draw();
}
const brand = `<div class="brand"><span class="logo">ϟ</span><span>zap<span>hub</span><small>GESTÃO DE COBRANÇAS</small></span></div>`;
async function boot() {
  const a = await api("/auth");
  if (a.authenticated) {
    await refresh();
    return;
  }
  app.innerHTML = `<div class="auth-wrap"><form id="auth" class="auth-card">${brand}<div class="eyebrow">Bem-vindo ao seu hub</div><h1>${a.setup ? "Vamos começar?" : "Bom ter você de volta."}</h1><p class="muted">${a.setup ? "Crie a senha de administrador para organizar seus clientes e automatizar suas cobranças." : "Entre para acompanhar seus clientes, faturas e lembretes."}</p>${a.setupTokenRequired ? field("Código de configuração", "setupToken", "", "password", 'required autocomplete="off"', "Use o código exclusivo fornecido na instalação.") : ""}${field(a.setup ? "Crie uma senha" : "Senha", "password", "", "password", 'required minlength="10" autocomplete="' + (a.setup ? "new-password" : "current-password") + '"', "Pelo menos 10 caracteres.")}<div class="inline-error" role="alert"></div><button class="primary">${a.setup ? "Criar acesso e entrar" : "Acessar meu painel"} →</button><p class="help">Seus dados ficam armazenados neste servidor.</p></form></div>`;
}
const headings = {
  dashboard: ["Visão geral", "Suas cobranças organizadas. Seu tempo de volta."],
  clients: ["Clientes", "Conexões que fazem o seu negócio crescer."],
  plans: ["Cobranças recorrentes", "Configure uma vez. Acompanhe a cada mês."],
  invoices: ["Faturas", "Cada recebimento, do vencimento à confirmação."],
  rules: ["Mensagens e lembretes", "A mensagem certa, no momento certo."],
  history: ["Histórico de envios", "Acompanhe cada tentativa de comunicação."],
  settings: ["Integrações", "Conecte as ferramentas que movem seu negócio."],
};
function draw() {
  const nav = [
    ["dashboard", "◫", "Visão geral"],
    ["clients", "♧", "Clientes"],
    ["plans", "↻", "Cobranças"],
    ["invoices", "▤", "Faturas"],
    ["rules", "☷", "Lembretes"],
    ["history", "◷", "Histórico"],
    ["settings", "⚙", "Integrações"],
  ];
  const [title, subtitle] = headings[page];
  app.innerHTML = `<div class="shell"><aside class="sidebar">${brand}<div class="nav-label">SEU ESPAÇO DE GESTÃO</div><nav>${nav.map(([id, icon, label]) => `<button data-page="${id}" class="${page === id ? "active" : ""}"><span class="nav-icon">${icon}</span>${label}</button>`).join("")}</nav><div class="side-foot"><strong>Menos tarefas. Mais controle.</strong><br>Clientes, cobranças e WhatsApp<br>em um só lugar.<br><br>PARATECH · ZAP HUB</div></aside><div><header class="topbar"><span>Seu negócio / <strong>${title}</strong></span><div class="right">${badge(state.settings.mode, state.settings.mode === "simulation" ? "Modo simulação" : "Modo real")}<span class="avatar">P</span>${btn("Sair", "logout")}</div></header><main><div class="heading"><div><div class="eyebrow">Organize. Conecte. Receba.</div><h1>${title}</h1><p class="muted">${subtitle}</p></div><div class="actions">${page === "clients" ? btn("＋ Novo cliente", "client", "", "primary") : page === "plans" ? btn("＋ Nova cobrança", "plan", "", "primary") : page === "rules" ? btn("＋ Novo lembrete", "rule", "", "primary") : page === "dashboard" ? btn("＋ Nova cobrança", "plan", "", "primary") : ""}</div></div>${content()}<footer class="footer"><span>Zap Hub · Gestão simples, conexões reais.</span><span>Horário de Brasília · ${date(state.today)}</span></footer></main></div></div>`;
}
function empty(title, description, action, label) {
  return `<div class="empty"><div class="symbol">▤</div><h3>${title}</h3><p>${description}</p>${action ? btn(label, action, "", "primary") : ""}</div>`;
}
function invoiceTable(items) {
  return items.length
    ? `<div class="table-wrap"><table><thead><tr><th>Cliente / Fatura</th><th>Referência</th><th>Vencimento</th><th>Valor</th><th>Status</th><th></th></tr></thead><tbody>${items.map((i) => `<tr><td><strong>${esc(client(i.clientId)?.name)}</strong><small>${esc(i.name)}</small></td><td>${ref(i.reference)}</td><td>${date(i.due)}</td><td><strong>${brl(i.amount)}</strong></td><td>${badge(status(i))}</td><td>${btn("Detalhes ↗", "invoice", i.id)}</td></tr>`).join("")}</tbody></table></div>`
    : empty(
        "Tudo começa com uma cobrança",
        "Cadastre um cliente e crie sua primeira cobrança. As faturas aparecerão aqui.",
        "plan",
        "Criar cobrança",
      );
}
function content() {
  if (page === "dashboard") {
    const invoices = state.invoices,
      month = state.today.slice(0, 7),
      current = invoices.filter((i) => i.reference === month),
      pending = current.filter((i) => i.status === "pending"),
      overdue = invoices.filter((i) => status(i) === "overdue"),
      paid = current.filter((i) => i.status === "paid");
    const sum = (a) => a.reduce((n, i) => n + i.amount, 0);
    return `${state.settings.mode === "simulation" ? '<div class="notice"><span class="notice-icon">◉</span><div><strong>Seu espaço está em modo de simulação</strong>Explore os lembretes sem enviar mensagens. Conecte suas contas em Integrações quando estiver pronto.</div></div>' : ""}<div class="metrics"><div class="metric featured"><div class="label">A receber no mês <span>↗</span></div><div class="value">${brl(sum(pending))}</div><div class="hint">${pending.length} faturas em aberto · ${ref(month)}</div></div><div class="metric"><div class="label">Recebido no mês <span>✓</span></div><div class="value">${brl(sum(paid))}</div><div class="hint">${paid.length} faturas da referência quitadas</div></div><div class="metric"><div class="label">Total em atraso <span>◷</span></div><div class="value">${brl(sum(overdue))}</div><div class="hint">${overdue.length} faturas aguardando pagamento</div></div><div class="metric"><div class="label">Clientes ativos <span>♧</span></div><div class="value">${state.clients
      .filter((c) => c.active)
      .length.toString()
      .padStart(
        2,
        "0",
      )}</div><div class="hint">${state.plans.filter((p) => p.active).length} cobranças recorrentes</div></div></div><div class="grid"><div><section class="card"><div class="card-head"><div><h2>Próximos recebimentos</h2><span class="muted">Faturas em aberto, por vencimento</span></div><button data-page="invoices">Ver todas →</button></div>${invoiceTable(
      invoices
        .filter((i) => i.status === "pending")
        .sort((a, b) => a.due.localeCompare(b.due))
        .slice(0, 6),
    )}</section><section class="card"><div class="card-head"><div><h2>Atividade recente</h2><span class="muted">O que acontece no seu hub</span></div>${badge("gray", state.settings.auto ? "Rotina automática ativa" : "Rotina automática pausada")}</div><div class="card-body">${
      state.logs.length
        ? state.logs
            .slice(0, 4)
            .map(
              (l) =>
                `<div class="activity">${esc(l.message)}<time>${new Date(l.created).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}</time></div>`,
            )
            .join("")
        : '<p class="muted">As atividades de cobrança aparecerão aqui.</p>'
    }</div></section></div><aside><section class="card"><div class="card-body"><div class="eyebrow">Seu fluxo de cobrança</div><h2>Simples, do início ao Pix.</h2><div class="steps">${[
      ["Cadastre seu cliente", "Nome, empresa e WhatsApp sempre à mão."],
      ["Defina sua cobrança", "Valor, período e dia de vencimento."],
      [
        "Personalize os lembretes",
        "Sua mensagem com os dados de cada cliente.",
      ],
      ["Acompanhe o pagamento", "Confirmação do gateway e fim dos avisos."],
    ]
      .map(
        ([a, b], i) =>
          `<div class="step"><span class="step-num">0${i + 1}</span><div><h3>${a}</h3><p>${b}</p></div></div>`,
      )
      .join(
        "",
      )}</div></div></section><section class="card"><div class="card-body"><h2>Automação sob controle</h2><p class="help">${state.settings.mode === "simulation" ? "Simule os avisos e confira os textos no histórico." : "A rotina processa os lembretes elegíveis e envia pelo WhatsApp."}</p>${btn(state.settings.mode === "simulation" ? "▷ Simular agora" : "▷ Executar rotina agora", "run", "", "primary")}<p class="help">Janela automática: ${String(state.settings.sendHour).padStart(2, "0")}h às 20h.</p></div></section></aside></div>`;
  }
  if (page === "clients")
    return `<div class="toolbar"><input id="search" placeholder="Buscar por cliente, empresa ou CPF" value="${esc(search)}" aria-label="Buscar clientes"></div><section class="card">${
      state.clients.length
        ? `<div class="table-wrap"><table><thead><tr><th>Cliente</th><th>Empresa</th><th>WhatsApp</th><th>CPF</th><th>Status</th><th></th></tr></thead><tbody>${state.clients
            .filter((c) =>
              [c.name, c.company, c.cpf]
                .join(" ")
                .toLowerCase()
                .includes(search.toLowerCase()),
            )
            .map(
              (c) =>
                `<tr><td><strong>${esc(c.name)}</strong></td><td>${esc(c.company)}</td><td>+${esc(c.phone)}</td><td>${esc(c.cpf)}</td><td>${badge(c.active ? "paid" : "cancelled", c.active ? "Ativo" : "Inativo")}</td><td>${btn("Editar", "client", c.id)}</td></tr>`,
            )
            .join("")}</tbody></table></div>`
        : empty(
            "Sua carteira de clientes começa aqui",
            "Organize os dados de quem confia no seu trabalho.",
            "client",
            "Cadastrar cliente",
          )
    }</section>`;
  if (page === "plans")
    return `<div class="notice"><span class="notice-icon">↻</span><div><strong>Uma cobrança, várias referências mensais</strong>As faturas são geradas até dois meses à frente. Alterações de valor e vencimento valem para as próximas faturas ainda não geradas.</div></div><section class="card">${state.plans.length ? `<div class="table-wrap"><table><thead><tr><th>Cobrança / Cliente</th><th>Valor mensal</th><th>Vencimento</th><th>Período</th><th>Status</th><th></th></tr></thead><tbody>${state.plans.map((p) => `<tr><td><strong>${esc(p.name)}</strong><small>${esc(client(p.clientId)?.name)}</small></td><td>${brl(p.amount)}</td><td>Dia ${p.day}</td><td>${date(p.start)} → ${date(p.end)}</td><td>${badge(p.active ? "paid" : "cancelled", p.active ? "Ativa" : "Pausada")}</td><td>${btn("Editar", "plan", p.id)}</td></tr>`).join("")}</tbody></table></div>` : empty("Recebimentos mais previsíveis", "Crie uma cobrança mensal com início, término e vencimento.", "plan", "Nova cobrança")}</section>`;
  if (page === "invoices")
    return `<div class="toolbar"><input id="search" value="${esc(search)}" placeholder="Buscar cliente, fatura ou referência" aria-label="Buscar faturas"><select id="filter" aria-label="Filtrar status">${[
      ["all", "Todos os status"],
      ["pending", "Em aberto"],
      ["overdue", "Vencidas"],
      ["paid", "Pagas"],
      ["cancelled", "Canceladas"],
    ]
      .map(
        ([v, l]) =>
          `<option value="${v}" ${filter === v ? "selected" : ""}>${l}</option>`,
      )
      .join(
        "",
      )}</select>${btn("↻ Atualizar faturas", "generate")}</div><section class="card">${invoiceTable(state.invoices.filter((i) => (filter === "all" || status(i) === filter) && [i.name, i.number, ref(i.reference), client(i.clientId)?.name].join(" ").toLowerCase().includes(search.toLowerCase())).sort((a, b) => a.due.localeCompare(b.due)))}</section>`;
  if (page === "rules")
    return `<div class="notice"><span class="notice-icon">☷</span><div><strong>Mensagens com a sua voz</strong>Use os campos disponíveis para personalizar cada aviso. O aviso de bloqueio apenas comunica o cliente; não bloqueia serviços externos.</div></div><div class="rule-list">${state.rules.map((r) => `<article class="rule"><div class="timing">${r.offset < 0 ? `${-r.offset} dias antes do vencimento` : r.offset === 0 ? "No dia do vencimento" : `${r.offset} dias após o vencimento`}</div><h2>${esc(r.name)}</h2><pre>${esc(r.template)}</pre><div class="actions">${badge(r.active ? "paid" : "cancelled", r.active ? "Ativo" : "Pausado")}${btn("Personalizar →", "rule", r.id)}</div></article>`).join("")}</div><p class="help">Cada lembrete é enviado uma vez por fatura. Se o servidor ficar offline, apenas o lembrete mais recente elegível é recuperado. Os avisos param no término da cobrança.</p>`;
  if (page === "history")
    return `<div class="heading"><p class="muted">Últimas 200 tentativas. “Enviado” indica aceitação pela API, sem confirmação de leitura.</p>${btn(state.settings.mode === "simulation" ? "Simular rotina" : "Executar rotina", "run", "", "primary")}</div><section class="card">${state.deliveries.length ? `<div class="table-wrap"><table><thead><tr><th>Cliente / Fatura</th><th>Lembrete</th><th>Data</th><th>Modo</th><th>Status</th><th></th></tr></thead><tbody>${state.deliveries.map((d) => `<tr><td><strong>${esc(d.client)}</strong><small>${esc(d.number)}</small></td><td>${esc(d.rule)}</td><td>${new Date(d.created).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}</td><td>${d.mode === "live" ? "Real" : "Simulação"}</td><td>${badge(d.status)}</td><td>${btn("Ver mensagem", "delivery", d.id)}</td></tr>`).join("")}</tbody></table></div>` : empty("Cada mensagem terá sua história", "Execute uma simulação para conferir os avisos elegíveis.", "run", "Simular rotina")}</section>`;
  if (page === "settings") {
    const s = state.settings;
    return `<form id="settings"><div class="settings-grid"><section class="card"><div class="card-head"><div class="connection"><span class="integrations-logo">◉</span><div><h2>WhatsApp · Uazapi</h2><span class="muted">Sua conexão com o cliente</span></div></div>${badge(s.tokenConfigured ? "paid" : "cancelled", s.tokenConfigured ? "Configurada" : "Pendente")}</div><div class="card-body"><div class="form-grid">${field("URL do servidor Uazapi", "uazapiUrl", s.uazapiUrl, "url", 'placeholder="https://sua-instancia.uazapi.com"')}${field("Token da instância", "uazapiToken", "", "password", `autocomplete="new-password" placeholder="${s.tokenConfigured ? "Salvo • deixe vazio para manter" : "Token da instância"}"`)}</div><p class="help">O token fica criptografado no servidor. Salve as alterações antes de testar a conexão.</p>${btn("Testar conexão", "connection")}</div></section><section class="card"><div class="card-head"><div class="connection"><span class="integrations-logo">∞</span><div><h2>InfinitePay</h2><span class="muted">Checkout com pagamento por Pix</span></div></div>${badge(s.handle && s.publicUrl ? "paid" : "cancelled", s.handle && s.publicUrl ? "Configurada" : "Pendente")}</div><div class="card-body"><div class="form-grid">${field("InfiniteTag (sem $)", "handle", s.handle, "text", 'placeholder="sua-tag"')}${field("URL pública do Zap Hub", "publicUrl", s.publicUrl, "url", 'placeholder="https://cobrancas.suaempresa.com.br"')}</div><p class="help">Habilite o Checkout Integrado na InfinitePay. O checkout oferece Pix e cartão. A URL pública HTTPS é necessária para confirmar os pagamentos.</p><p class="help">Webhook: <strong>${esc(s.publicUrl || "https://seu-dominio.com")}/webhooks/infinitepay</strong></p></div></section><section class="card wide"><div class="card-head"><div><h2>Automação de cobranças</h2><span class="muted">Defina quando seu hub deve agir</span></div></div><div class="card-body"><div class="form-grid"><label class="field">Modo de operação<select name="mode"><option value="simulation" ${s.mode === "simulation" ? "selected" : ""}>Simulação — sem mensagens ou links reais</option><option value="live" ${s.mode === "live" ? "selected" : ""}>Real — gerar links e enviar WhatsApp</option></select></label>${field("A partir de qual hora enviar? (Brasília)", "sendHour", s.sendHour, "number", 'min="0" max="19" required', "A janela encerra às 20h, todos os dias.")}<div>${check("auto", "Ativar rotina automática a cada minuto", s.auto)}</div></div><p class="help">Mantenha o servidor ligado. Com a rotina pausada, você ainda pode executar manualmente. Pagamentos confirmados interrompem os lembretes. Clientes e cobranças pausados não recebem avisos.</p><div class="inline-error" role="alert"></div><div class="form-actions"><button class="primary">Salvar configurações</button></div></div></section></div></form>`;
  }
}
function modal(title, body) {
  dialog.innerHTML = `<div class="dialog-head"><h2>${title}</h2>${btn("✕", "close")}</div><div class="dialog-body">${body}</div>`;
  if (!dialog.open) dialog.showModal();
}
function editor(kind, id) {
  let value = state[kind].find((v) => v.id === id) || {},
    body = "";
  if (kind === "clients")
    body = `${field("Nome do cliente", "name", value.name, "text", 'required maxlength="150"')}${field("Nome da empresa", "company", value.company, "text", 'required maxlength="150"')}${field("WhatsApp", "phone", value.phone || "55", "tel", "required", "55 + DDD + número")}${field("CPF", "cpf", value.cpf, "text", "required", "Informe um CPF válido, com ou sem pontuação.")}`;
  if (kind === "plans") {
    if (!state.clients.length) {
      toast("Cadastre seu primeiro cliente antes da cobrança.");
      editor("clients");
      return;
    }
    body = `<label class="field">Cliente<select name="clientId" required>${state.clients.map((c) => `<option value="${c.id}" ${value.clientId === c.id ? "selected" : ""}>${esc(c.name)} · ${esc(c.company)}</option>`).join("")}</select></label>${field("Nome da fatura", "name", value.name, "text", 'required placeholder="Ex.: Mensalidade do sistema"')}${field("Valor mensal (R$)", "amount", value.amount ? (value.amount / 100).toFixed(2) : "", "number", 'required min="0.01" max="1000000" step="0.01"')}${field("Dia do vencimento", "day", value.day || 10, "number", 'required min="1" max="31"', "Meses curtos usam o último dia disponível.")}${field("Início da cobrança", "start", value.start || state.today, "date", "required")}${field("Término da cobrança", "end", value.end || `${Number(state.today.slice(0, 4)) + 1}${state.today.slice(4)}`, "date", "required")}<div class="field full"><small>Referências mensais são criadas automaticamente (ex.: 01/2026, 02/2026). O início e o término limitam também o envio dos avisos. Faturas já geradas preservam valor, cliente e vencimento originais.</small></div>`;
  }
  if (kind === "rules")
    body = `${field("Nome do lembrete", "name", value.name, "text", "required")}${field("Dias em relação ao vencimento", "offset", value.offset ?? -5, "number", 'required min="-60" max="90"', "Negativo: antes. Zero: no dia. Positivo: após.")}<label class="field full">Mensagem<textarea name="template" required maxlength="4000">${esc(value.template || "Olá, {{nome_cliente}}! Sua fatura {{nome_fatura}}, de {{referencia}}, no valor de {{valor}}, vence em {{vencimento}}. Pague por Pix: {{link_pagamento}}")}</textarea><small>Clique em um campo abaixo para inserir na posição do cursor.</small></label><div class="field full"><div class="tokens">${state.fields.map((f) => btn("{{" + f + "}}", "token", f)).join("")}</div><h3>Prévia ilustrativa</h3><div class="preview" id="template-preview"></div></div>`;
  modal(
    id
      ? "Editar " +
          { clients: "cliente", plans: "cobrança", rules: "lembrete" }[kind]
      : "Novo cadastro · " +
          { clients: "cliente", plans: "cobrança", rules: "lembrete" }[kind],
    `<form id="editor" data-kind="${kind}" data-id="${id || ""}"><div class="form-grid">${body}<div class="field full">${check("active", kind === "clients" ? "Cliente ativo" : kind === "plans" ? "Cobrança ativa" : "Lembrete ativo", value.active !== false)}</div></div><div class="inline-error" role="alert"></div><div class="form-actions">${btn("Cancelar", "close")}<button class="primary">Salvar ${kind === "plans" ? "cobrança" : kind === "rules" ? "lembrete" : "cliente"}</button></div></form>`,
  );
  if (kind === "rules") updatePreview();
}
function updatePreview() {
  const el = $('[name="template"]');
  if (!el) return;
  const samples = {
    nome_cliente: "João Silva",
    empresa: "Empresa Exemplo",
    whatsapp: "5511999999999",
    cpf: "000.000.000-00",
    nome_fatura: "Mensalidade do sistema",
    numero_fatura: "ZH-202610-EXEMPLO",
    valor: "R$ 149,90",
    referencia: ref(state.today.slice(0, 7)),
    vencimento: date(state.today),
    link_pagamento: "[link de pagamento Pix]",
    inicio_cobranca: "01/01/2026",
    termino_cobranca: "31/12/2026",
    dias_atraso: "5",
  };
  $("#template-preview").textContent = el.value.replace(
    /{{\s*(\w+)\s*}}/g,
    (_, k) => samples[k] || "[campo desconhecido]",
  );
}
async function invoiceDetail(id) {
  const i = state.invoices.find((i) => i.id === id),
    previews = await api("/preview/" + id);
  modal(
    "Detalhes da fatura",
    `<div class="detail-list"><div><small>Cliente</small>${esc(client(i.clientId)?.name)}</div><div><small>Número</small>${esc(i.number)}</div><div><small>Referência / Vencimento</small>${ref(i.reference)} · ${date(i.due)}</div><div><small>Valor / Status</small>${brl(i.amount)} ${badge(status(i))}</div></div>${i.paymentUrl ? `<p><a href="${esc(i.paymentUrl)}" target="_blank" rel="noopener noreferrer">Abrir link de pagamento ↗</a></p>` : ""}${i.note ? `<p class="help">Justificativa: ${esc(i.note)}</p>` : ""}<div class="actions">${i.status === "pending" ? btn("Gerar link de pagamento", "link", i.id) + btn("Registrar pagamento", "paid", i.id) + btn("Cancelar fatura", "cancelled", i.id, "danger") : ""}</div><div class="subsection">Prévias das mensagens</div>${previews.map((p) => `<h3>${esc(p.name)}</h3><div class="preview">${esc(p.text)}</div>`).join("")}`,
  );
}
document.addEventListener("click", async (e) => {
  const nav = e.target.closest("[data-page]");
  if (nav) {
    page = nav.dataset.page;
    search = "";
    filter = "all";
    draw();
    return;
  }
  const button = e.target.closest("[data-action]");
  if (!button) return;
  e.preventDefault();
  const { action, id } = button.dataset;
  try {
    if (action === "close") return dialog.close();
    if (action === "client" || action === "plan" || action === "rule")
      return editor(
        { client: "clients", plan: "plans", rule: "rules" }[action],
        id,
      );
    if (action === "token") {
      const el = $('[name="template"]');
      el.setRangeText(
        "{{" + id + "}}",
        el.selectionStart,
        el.selectionEnd,
        "end",
      );
      el.focus();
      updatePreview();
      return;
    }
    if (action === "invoice") return await invoiceDetail(id);
    if (action === "paid" || action === "cancelled") {
      modal(
        action === "paid" ? "Registrar pagamento manual" : "Cancelar fatura",
        `<form id="status-form" data-id="${id}" data-status="${action}"><p class="help">${action === "paid" ? "Registre somente após conferir o recebimento." : "O cancelamento encerra os lembretes desta fatura."}</p>${field("Justificativa / identificação do comprovante", "note", "", "text", 'required minlength="5" maxlength="300"')}<div class="inline-error" role="alert"></div><div class="form-actions"><button class="primary">Confirmar</button></div></form>`,
      );
      return;
    }
    if (action === "delivery") {
      const d = state.deliveries.find((d) => d.id === id);
      modal(
        esc(d.rule),
        `${badge(d.status)}<div class="preview">${esc(d.text)}</div>${d.error ? `<p class="error">${esc(d.error)}</p>` : ""}${["failed", "uncertain"].includes(d.status) ? `<p class="help">Antes de tentar novamente, confira no WhatsApp se a mensagem já foi enviada. Uma resposta incerta pode ter sido processada pelo provedor.</p>${btn("Conferi o envio; liberar nova tentativa", "retry", d.id)}` : ""}`,
      );
      return;
    }
    button.disabled = true;
    if (action === "logout") {
      await api("/logout", {});
      await boot();
      return;
    }
    if (action === "connection") {
      const r = await api("/uazapi/status", {});
      toast(
        r.connected
          ? "WhatsApp conectado."
          : "API respondeu. Estado: " +
              (typeof r.status === "string"
                ? r.status
                : JSON.stringify(r.status)),
      );
      return;
    }
    if (action === "run") {
      if (
        state.settings.mode === "live" &&
        !confirm("Executar agora os envios reais dos lembretes elegíveis?")
      )
        return;
      const r = await api("/run", {});
      toast(
        r.busy
          ? "A rotina já está em execução."
          : `${r.sent} lembretes processados · ${r.failed} falhas · ${r.generated} novas faturas`,
      );
    }
    if (action === "generate") {
      const r = await api("/generate", {});
      toast(`${r.generated} novas faturas geradas.`);
    }
    if (action === "link") {
      await api("/invoices/" + id + "/link", {});
      await refresh();
      await invoiceDetail(id);
      toast("Link de pagamento gerado.");
      return;
    }
    if (action === "retry") {
      await api("/deliveries/" + id + "/retry", {});
      dialog.close();
      toast("Nova tentativa liberada para a próxima execução da rotina.");
    }
    await refresh();
  } catch (err) {
    toast(err.message);
  } finally {
    button.disabled = false;
  }
});
document.addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.target,
    fd = new FormData(form),
    data = Object.fromEntries(fd),
    button = form.querySelector("button:not([data-action])"),
    error = form.querySelector(".inline-error");
  if (error) error.textContent = "";
  if (button) button.disabled = true;
  try {
    if (form.id === "auth") {
      await api("/auth", data);
      await refresh();
      return;
    }
    if (form.id === "editor") {
      const { kind, id } = form.dataset;
      data.active = fd.has("active");
      if (kind === "plans") {
        data.amount = Math.round(Number(data.amount) * 100);
        data.day = Number(data.day);
      }
      if (kind === "rules") data.offset = Number(data.offset);
      if (id && kind !== "rules") data.id = id;
      await api(
        "/" + kind + (id && kind === "rules" ? "/" + id : ""),
        data,
        id && kind === "rules" ? "PUT" : "POST",
      );
      dialog.close();
      await refresh();
      toast("Cadastro salvo com sucesso.");
    }
    if (form.id === "status-form") {
      await api("/invoices/" + form.dataset.id + "/status", {
        status: form.dataset.status,
        note: data.note,
      });
      dialog.close();
      await refresh();
      toast("Fatura atualizada.");
    }
    if (form.id === "settings") {
      data.sendHour = Number(data.sendHour);
      data.auto = fd.has("auto");
      if (
        data.mode === "live" &&
        state.settings.mode !== "live" &&
        !confirm(
          "Ativar modo real? As execuções da rotina passarão a gerar links e enviar mensagens aos clientes.",
        )
      )
        return;
      await api("/settings", data, "PUT");
      await refresh();
      toast("Configurações salvas.");
    }
  } catch (err) {
    if (error) error.textContent = err.message;
    else toast(err.message);
  } finally {
    if (button) button.disabled = false;
  }
});
document.addEventListener("input", (e) => {
  if (e.target.name === "template") updatePreview();
  if (e.target.id === "search") {
    const pos = e.target.selectionStart;
    search = e.target.value;
    draw();
    $("#search").focus();
    $("#search").setSelectionRange(pos, pos);
  }
});
document.addEventListener("change", (e) => {
  if (e.target.id === "filter") {
    filter = e.target.value;
    draw();
  }
});
boot().catch((e) => {
  app.innerHTML =
    '<div class="auth-wrap"><div class="auth-card"><h1>Não foi possível conectar</h1><p>Verifique se o servidor Zap Hub está em execução e recarregue a página.</p></div></div>';
  toast(e.message);
});
