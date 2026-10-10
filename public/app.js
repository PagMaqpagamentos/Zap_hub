import { prepareBillingImage } from "./billing-image.js";
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
const ruleType = (r) =>
  r.kind ||
  { disponivel: "available", vencimento: "due", bloqueio: "overdue" }[r.id] ||
  "custom";
function ruleTiming(r) {
  const kind = ruleType(r);
  if (kind === "available")
    return `Todos os dias, desde ${-r.offset} dias antes até a véspera`;
  if (kind === "due") return "No vencimento, nos horários configurados";
  if (kind === "overdue")
    return `Diário após vencer · bloqueio previsto em +${r.offset} dias`;
  return r.offset < 0
    ? `Somente ${-r.offset} dias antes`
    : r.offset === 0
      ? "Somente no vencimento"
      : `Somente ${r.offset} dias depois`;
}
function timeInputs(times) {
  return times
    .map((t, i) =>
      field(`Horário ${i + 1} (Brasília)`, "sendTime", t, "time", "required"),
    )
    .join("");
}
function scheduleFields(s) {
  const times = s.sendTimes || ["09:00"];
  return `<div class="field full"><label class="field">Quantas vezes por dia, por fatura?<select id="dailyCount" name="dailyCount">${Array.from({ length: 12 }, (_, i) => `<option value="${i + 1}" ${times.length === i + 1 ? "selected" : ""}>${i + 1} ${i ? "vezes" : "vez"} por dia</option>`).join("")}</select></label><div class="form-grid" id="send-times">${timeInputs(times)}</div><small>Todos os dias, nos horários de Brasília. Se o servidor ficar indisponível, recupera somente o último horário por até 30 minutos; não acumula avisos perdidos.</small></div>`;
}
function dailyScheduleCard() {
  return `<section class="card"><div class="card-head"><div><h2>Frequência dos avisos</h2><span class="muted">Uma programação diária para todas as etapas</span></div>${badge("gray", `${(state.settings.sendTimes || ["09:00"]).length} vez(es) por dia`)}</div><form id="schedule" class="card-body"><div class="form-grid">${scheduleFields(state.settings)}</div><div class="inline-error" role="alert"></div><div class="form-actions"><button class="primary">Salvar horários</button></div></form></section>`;
}
const client = (id) => state.clients.find((c) => c.id === id),
  plan = (id) => state.plans.find((p) => p.id === id);
const status = (i) =>
  i.status === "pending"
    ? i.due < state.today
      ? "overdue"
      : "pending"
    : i.status;
const balance = i => i.status === "paid" ? 0 : Math.max(0, i.amount - (i.paidAmount || 0));
function planInvoice(p) {
  const all = state.invoices.filter(i => i.planId === p.id && i.status !== "cancelled").sort((a,b) => a.due.localeCompare(b.due) || a.reference.localeCompare(b.reference));
  const current = all.filter(i => i.due.slice(0,7) <= state.today.slice(0,7));
  return current.find(i => i.status === "pending") || current.at(-1) || all[0];
}
const searchMatch = values => values.join(" ").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().includes(search.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase());
function statusFilter() {
  return `<select id="filter" aria-label="Filtrar status">${[["all","Todos os status"],["pending","Aguardando pagamento"],["overdue","Em atraso"],["paid","Pago"],["cancelled","Cancelada"]].map(([v,l]) => `<option value="${v}" ${filter===v?"selected":""}>${l}</option>`).join("")}</select>`;
}
const labels = {
  pending: "Aguardando pagamento",
  overdue: "Em atraso",
  paid: "Pago",
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
  app.innerHTML = `<div class="shell"><aside class="sidebar">${brand}<div class="nav-label">SEU ESPAÇO DE GESTÃO</div><nav>${nav.map(([id, icon, label]) => `<button data-page="${id}" class="${page === id ? "active" : ""}"><span class="nav-icon">${icon}</span>${label}</button>`).join("")}</nav><div class="side-foot"><strong>Menos tarefas. Mais controle.</strong><br>Clientes, cobranças e WhatsApp<br>em um só lugar.<br><br>PARATECH · ZAP HUB</div></aside><div><header class="topbar"><span>Seu negócio / <strong>${title}</strong></span><div class="right">${badge(state.settings.mode, state.settings.mode === "simulation" ? "Modo simulação" : "Modo real")}<span class="avatar">P</span>${btn("Sair", "logout")}</div></header><main><div class="heading"><div><div class="eyebrow">Organize. Conecte. Receba.</div><h1>${title}</h1><p class="muted">${subtitle}</p></div><div class="actions">${page === "clients" ? btn("Importar clientes", "import-clients") + btn("＋ Novo cliente", "client", "", "primary") : page === "plans" ? btn("＋ Nova cobrança", "plan", "", "primary") : page === "rules" ? btn("＋ Novo lembrete", "rule", "", "primary") : page === "dashboard" ? btn("＋ Nova cobrança", "plan", "", "primary") : ""}</div></div>${content()}<footer class="footer"><span>Zap Hub · Gestão simples, conexões reais.</span><span>Horário de Brasília · ${date(state.today)}</span></footer></main></div></div>`;
}
function empty(title, description, action, label) {
  return `<div class="empty"><div class="symbol">▤</div><h3>${title}</h3><p>${description}</p>${action ? btn(label, action, "", "primary") : ""}</div>`;
}
function invoiceTable(items) {
  return items.length
    ? `<div class="table-wrap"><table><thead><tr><th>Cliente / Fatura</th><th>Referência</th><th>Vencimento</th><th>Valor</th><th>Status</th><th></th></tr></thead><tbody>${items.map((i) => `<tr><td><strong>${esc(client(i.clientId)?.name)}</strong><small>${esc(client(i.clientId)?.company)}</small><small>${esc(i.name)}</small></td><td>${ref(i.reference)}</td><td>${date(i.due)}</td><td><strong>${brl(i.amount)}</strong><small>Recebido: ${brl(i.paidAmount ?? (i.status === "paid" ? i.amount : 0))}</small><small>Saldo: ${brl(balance(i))}</small></td><td>${badge(status(i))}</td><td>${btn("Detalhes ↗", "invoice", i.id)} ${btn("Editar", "invoice-edit", i.id)}</td></tr>`).join("")}</tbody></table></div>`
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
    return `${state.settings.mode === "simulation" ? '<div class="notice"><span class="notice-icon">◉</span><div><strong>Seu espaço está em modo de simulação</strong>Explore os lembretes sem enviar mensagens. Conecte suas contas em Integrações quando estiver pronto.</div></div>' : ""}<div class="metrics"><div class="metric featured"><div class="label">A receber no mês <span>↗</span></div><div class="value">${brl(pending.reduce((n,i)=>n+balance(i),0))}</div><div class="hint">${pending.length} faturas em aberto · ${ref(month)}</div></div><div class="metric"><div class="label">Recebido no mês <span>✓</span></div><div class="value">${brl(state.invoices.filter(i=>i.reference===month).reduce((n,i)=>n+(i.paidAmount ?? (i.status==="paid" ? i.amount : 0)),0))}</div><div class="hint">${paid.length} faturas da referência quitadas</div></div><div class="metric"><div class="label">Total em atraso <span>◷</span></div><div class="value">${brl(overdue.reduce((n,i)=>n+balance(i),0))}</div><div class="hint">${overdue.length} faturas aguardando pagamento</div></div><div class="metric"><div class="label">Clientes ativos <span>♧</span></div><div class="value">${state.clients
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
      )}</div></div></section><section class="card"><div class="card-body"><h2>Automação sob controle</h2><p class="help">${state.settings.mode === "simulation" ? "Simule os avisos e confira os textos no histórico." : "A rotina processa os lembretes elegíveis e envia pelo WhatsApp."}</p>${btn(state.settings.mode === "simulation" ? "▷ Simular agora" : "▷ Executar rotina agora", "run", "", "primary")}<p class="help">Envios diários: ${(state.settings.sendTimes || ["09:00"]).join(" · ")} (Brasília).</p></div></section></aside></div>`;
  }
  if (page === "clients")
    return `<div class="toolbar"><input id="search" placeholder="Buscar por cliente, empresa, CPF/CNPJ ou WhatsApp" value="${esc(search)}" aria-label="Buscar clientes"></div><section class="card">${
      state.clients.filter(c => !c.deletedAt).length
        ? `<div class="table-wrap"><table><thead><tr><th>Cliente</th><th>Empresa</th><th>WhatsApp</th><th>CPF/CNPJ</th><th>Status</th><th></th></tr></thead><tbody>${state.clients
            .filter((c) => !c.deletedAt && ([c.name, c.company, c.cpf, c.phone].join(" ").toLowerCase().includes(search.toLowerCase()) || (search.replace(/\D/g, "").length > 0 && [c.phone, c.cpf].some(v => (v || "").includes(search.replace(/\D/g, ""))))))
            .map(
              (c) =>
                `<tr><td><strong>${esc(c.name)}</strong></td><td>${esc(c.company)}</td><td>${c.phone ? "+" + esc(c.phone) : "Pendente"}</td><td>${esc(c.cpf)}</td><td>${badge(c.active ? "paid" : "cancelled", c.active ? "Ativo" : "Inativo")}</td><td>${btn("Editar", "client", c.id)} ${btn("Excluir", "delete-client", c.id, "danger")}</td></tr>`,
            )
            .join("")}</tbody></table></div>`
        : empty(
            "Sua carteira de clientes começa aqui",
            "Organize os dados de quem confia no seu trabalho.",
            "client",
            "Cadastrar cliente",
          )
    }</section>`;
  if (page === "plans") {
    const plans = state.plans.filter(p => !p.deletedAt && searchMatch([p.name,client(p.clientId)?.name,client(p.clientId)?.company,String(p.day),date(p.start),date(p.end),...state.invoices.filter(i=>i.planId===p.id).flatMap(i=>[i.name,i.number,i.due,date(i.due),ref(i.reference)])]) && (filter === "all" || (planInvoice(p) && status(planInvoice(p)) === filter)));
    const credits = (state.payments || []).filter(p => p.remaining > 0);
    return `<div class="notice"><span class="notice-icon">↻</span><div><strong>Acompanhe cada cobrança e suas faturas</strong>O status considera a primeira fatura aberta até o mês atual. Se estiverem quitadas, mostra Pago; sem fatura nesse período, mostra a próxima. A automação ativa ou pausada aparece separadamente.</div></div><div class="toolbar"><input id="search" value="${esc(search)}" placeholder="Buscar cobrança, vencimento, cliente ou empresa" aria-label="Buscar cobranças">${statusFilter()}</div>${credits.length ? `<section class="card"><div class="card-body"><h2>Créditos de pagamentos</h2>${credits.map(p=>`<p>${esc(client(p.clientId)?.name)} · ${esc(plan(p.planId)?.name)}: ${brl(p.remaining)} disponíveis para as próximas faturas da mesma cobrança.</p>`).join("")}</div></section>` : ""}<section class="card">${plans.length ? `<div class="table-wrap"><table class="plans-table"><thead><tr><th>Cobrança</th><th>Cliente / Empresa</th><th>Valor mensal</th><th>Vencimento / Período</th><th>Pagamento / Referência</th><th>Automação</th><th></th></tr></thead><tbody>${plans.map(p => {const i=planInvoice(p);return `<tr><td><strong>${esc(p.name)}</strong></td><td>${esc(client(p.clientId)?.name)}<small>${esc(client(p.clientId)?.company)}</small></td><td>${brl(p.amount)}</td><td>Dia ${p.day}<small>${date(p.start)} → ${date(p.end)}</small></td><td>${i ? badge(status(i))+`<small>${ref(i.reference)} · vence ${date(i.due)}</small><small>Saldo: ${brl(balance(i))}</small>` : badge("gray","Sem faturas")}</td><td>${badge(p.active ? "paid" : "cancelled",p.active ? "Ativa" : "Pausada")}</td><td>${btn("Faturas", "plan-invoices", p.id)} ${btn("Editar", "plan", p.id)} ${btn("Excluir", "delete-plan", p.id, "danger")}</td></tr>`;}).join("")}</tbody></table></div>` : empty("Nenhuma cobrança encontrada", "Ajuste a busca ou cadastre uma cobrança.", "plan", "Nova cobrança")}</section>`;
  }
  if (page === "invoices")
    return `<div class="toolbar"><input id="search" value="${esc(search)}" placeholder="Buscar fatura, vencimento, cliente ou empresa" aria-label="Buscar faturas">${statusFilter()}${btn("↻ Atualizar faturas", "generate")}</div><section class="card">${invoiceTable(state.invoices.filter(i => (filter === "all" || status(i) === filter) && searchMatch([i.name,i.number,ref(i.reference),i.due,date(i.due),client(i.clientId)?.name,client(i.clientId)?.company])).sort((a,b)=>a.due.localeCompare(b.due)))}</section>`;
  if (page === "rules")
    return `${dailyScheduleCard()}<div class="notice"><span class="notice-icon">☷</span><div><strong>Mensagens com a sua voz</strong>Use os campos disponíveis para personalizar cada aviso. O aviso de bloqueio apenas comunica o cliente; não bloqueia serviços externos.</div></div><div class="rule-list">${state.rules.map((r) => `<article class="rule"><div class="timing">${ruleTiming(r)}</div><h2>${esc(r.name)}</h2><pre>${esc(r.template)}</pre><div class="actions">${badge(r.active ? "paid" : "cancelled", r.active ? "Ativo" : "Pausado")}${btn("Personalizar →", "rule", r.id)}</div></article>`).join("")}</div><p class="help">A mensagem muda conforme a etapa e repete diariamente nos horários escolhidos. No vencimento, o aviso do dia também informa o prazo de bloqueio. Depois, o aviso de atraso continua até pagar ou terminar a cobrança. Um lembrete personalizado substitui a mensagem da etapa no seu dia, sem aumentar a quantidade diária.</p>`;
  if (page === "history")
    return `<div class="heading"><p class="muted">Últimas 200 tentativas. “Enviado” indica aceitação pela API, sem confirmação de leitura.</p>${btn(state.settings.mode === "simulation" ? "Simular rotina" : "Executar rotina", "run", "", "primary")}</div><section class="card">${state.deliveries.length ? `<div class="table-wrap"><table><thead><tr><th>Cliente / Fatura</th><th>Lembrete</th><th>Data</th><th>Modo</th><th>Status</th><th></th></tr></thead><tbody>${state.deliveries.map((d) => `<tr><td><strong>${esc(d.client)}</strong><small>${esc(d.number)}</small></td><td>${esc(d.rule)}</td><td>${new Date(d.created).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}<small>Programado: ${date(d.scheduledDate)} ${esc(d.scheduledSlot?.startsWith("legacy-") ? "histórico" : d.scheduledSlot)}</small></td><td>${d.mode === "live" ? "Real" : "Simulação"}</td><td>${badge(d.status)}</td><td>${btn("Ver mensagem", "delivery", d.id)}</td></tr>`).join("")}</tbody></table></div>` : empty("Cada mensagem terá sua história", "Execute uma simulação para conferir os avisos elegíveis.", "run", "Simular rotina")}</section>`;
  if (page === "settings") {
    const s = state.settings;
    return `<form id="settings"><div class="settings-grid"><section class="card"><div class="card-head"><div class="connection"><span class="integrations-logo">◉</span><div><h2>WhatsApp · Uazapi</h2><span class="muted">Sua conexão com o cliente</span></div></div>${badge(s.tokenConfigured ? "paid" : "cancelled", s.tokenConfigured ? "Configurada" : "Pendente")}</div><div class="card-body"><div class="form-grid">${field("URL do servidor Uazapi", "uazapiUrl", s.uazapiUrl, "url", 'placeholder="https://sua-instancia.uazapi.com"')}${field("Token da instância", "uazapiToken", "", "password", `autocomplete="new-password" placeholder="${s.tokenConfigured ? "Salvo • deixe vazio para manter" : "Token da instância"}"`)}</div><label class="field">Apresentação do pagamento<select name="paymentPresentation"><option value="button" ${s.paymentPresentation !== "link" ? "selected" : ""}>Botão Pagar fatura</option><option value="link" ${s.paymentPresentation === "link" ? "selected" : ""}>Link no texto</option></select></label><label class="field">Imagem da cobrança (opcional)<input type="file" name="billingImageFile" accept="image/png,image/jpeg"></label><p class="help">PNG ou JPEG de até 20 MB. Ajuste automático para até 1280 pixels e 500 KB, sem cortar ou esticar. A imagem acompanha o botão nos testes e lembretes. Salve antes de testar. No modo link, enviamos apenas texto.</p>${s.billingImage ? `<img src="${esc(s.billingImage)}" alt="Imagem atual da cobrança" class="billing-image-preview" style="display:block;width:100%;max-width:320px;height:180px;object-fit:contain">${check("removeBillingImage", "Remover imagem salva", false)}` : ""}<p class="help">O token fica criptografado no servidor. Salve as alterações antes de testar a conexão.</p>${btn("Testar conexão", "connection")}</div></section><section class="card"><div class="card-head"><div class="connection"><span class="integrations-logo">∞</span><div><h2>InfinitePay</h2><span class="muted">Checkout com pagamento por Pix</span></div></div>${badge(s.handle && s.publicUrl ? "paid" : "cancelled", s.handle && s.publicUrl ? "Configurada" : "Pendente")}</div><div class="card-body"><div class="form-grid">${field("InfiniteTag (sem $)", "handle", s.handle, "text", 'placeholder="sua-tag"')}${field("URL pública do Zap Hub", "publicUrl", s.publicUrl, "url", 'placeholder="https://cobrancas.suaempresa.com.br"')}</div><p class="help">Habilite o Checkout Integrado na InfinitePay. O checkout oferece Pix e cartão. A URL pública HTTPS é necessária para confirmar os pagamentos.</p><p class="help">Webhook: <strong>${esc(s.publicUrl || "https://seu-dominio.com")}/webhooks/infinitepay</strong></p></div></section><section class="card wide"><div class="card-head"><div><h2>Automação de cobranças</h2><span class="muted">Defina quando seu hub deve agir</span></div></div><div class="card-body"><div class="form-grid"><label class="field">Modo de operação<select name="mode"><option value="simulation" ${s.mode === "simulation" ? "selected" : ""}>Simulação — sem mensagens ou links reais</option><option value="live" ${s.mode === "live" ? "selected" : ""}>Real — gerar links e enviar WhatsApp</option></select></label>${scheduleFields(s)}<div>${check("auto", "Ativar rotina automática a cada minuto", s.auto)}</div></div><p class="help">Mantenha o servidor ligado. Com a rotina pausada, você ainda pode executar manualmente. Pagamentos confirmados interrompem os lembretes. Clientes e cobranças pausados não recebem avisos.</p><div class="inline-error" role="alert"></div><div class="form-actions"><button class="primary">Salvar configurações</button></div></div></section></div></form>${integrationTestsCard()}`;
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
    body = `${field("Nome do cliente", "name", value.name, "text", 'required maxlength="150"')}${field("Nome da empresa", "company", value.company, "text", 'required maxlength="150"')}${field("WhatsApp", "phone", value.phone ? "+" + value.phone : "+55 ", "tel", "", "Brasil: mantenha +55 e digite DDD e número. Para outro país, substitua +55 pelo código correspondente. Sem telefone, nenhum aviso será enviado.")}${field("CPF/CNPJ", "cpf", value.cpf, "text", "required", "Informe um CPF ou CNPJ válido, com ou sem pontuação.")}`;
  if (kind === "plans") {
    if (!state.clients.filter(c => !c.deletedAt).length) {
      toast("Cadastre seu primeiro cliente antes da cobrança.");
      editor("clients");
      return;
    }
    body = `<label class="field">Cliente<select name="clientId" required>${state.clients.filter(c => !c.deletedAt).map((c) => `<option value="${c.id}" ${value.clientId === c.id ? "selected" : ""}>${esc(c.name)} · ${esc(c.company)}</option>`).join("")}</select></label>${field("Nome da fatura", "name", value.name, "text", 'required placeholder="Ex.: Mensalidade do sistema"')}${field("Valor mensal (R$)", "amount", value.amount ? (value.amount / 100).toFixed(2) : "", "number", 'required min="0.01" max="1000000" step="0.01"')}${field("Dia do vencimento", "day", value.day || 10, "number", 'required min="1" max="31"', "Meses curtos usam o último dia disponível.")}${field("Início da cobrança", "start", value.start || state.today, "date", "required")}${field("Término da cobrança", "end", value.end || `${Number(state.today.slice(0, 4)) + 1}${state.today.slice(4)}`, "date", "required")}<div class="field full"><small>Referências mensais são criadas automaticamente (ex.: 01/2026, 02/2026). O início e o término limitam também o envio dos avisos. Faturas já geradas preservam valor, cliente e vencimento originais.</small></div>`;
  }
  if (kind === "rules")
    body = `${field("Nome do lembrete", "name", value.name, "text", "required")}<label class="field">Etapa do aviso<select name="kind">${[
      ["available", "Disponível — diário antes de vencer"],
      ["due", "Vencimento — somente no dia"],
      ["overdue", "Atraso — diário com prazo de bloqueio"],
      ["custom", "Personalizado — em um dia específico"],
    ]
      .map(
        ([v, l]) =>
          `<option value="${v}" ${ruleType(value) === v ? "selected" : ""}>${l}</option>`,
      )
      .join(
        "",
      )}</select></label>${field("Dias em relação ao vencimento", "offset", value.offset ?? -5, "number", 'required min="-60" max="90"', "Disponível: -5 começa 5 dias antes. Vencimento: 0. Atraso: +5 define o bloqueio para 5 dias depois, com avisos diários desde o dia seguinte ao vencimento.")}<label class="field full">Mensagem<textarea name="template" required maxlength="4000">${esc(value.template || "Olá, {{nome_cliente}}! Sua fatura {{nome_fatura}}, de {{referencia}}, no valor de {{valor}}, vence em {{vencimento}}. Pague por Pix: {{link_pagamento}}")}</textarea><small>Clique em um campo abaixo para inserir na posição do cursor.</small></label><div class="field full"><div class="tokens">${state.fields.map((f) => btn("{{" + f + "}}", "token", f)).join("")}</div><h3>Prévia ilustrativa</h3><div class="preview" id="template-preview"></div></div>`;
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
    data_bloqueio: date(
      new Date(Date.parse(state.today + "T12:00:00Z") + 5 * 86400000)
        .toISOString()
        .slice(0, 10),
    ),
    dias_para_bloqueio: "5",
    aviso_bloqueio:
      "Para evitar o bloqueio previsto em 5 dias, regularize o pagamento.",
  };
  $("#template-preview").textContent = el.value.replace(
    /{{\s*(\w+)\s*}}/g,
    (_, k) => samples[k] || "[campo desconhecido]",
  );
}
function integrationTestsCard() {
  const open = state.invoices.filter(i=>i.status==="pending").sort((a,b)=>a.due.localeCompare(b.due));
  return `<section class="card"><div class="card-head"><div><h2>Testar Pix e WhatsApp</h2><p class="muted">Os testes geram links reais, mesmo no modo simulação. A rotina automática permanece como está.</p></div></div><div class="card-body"><form id="integration-test" data-request-id="${crypto.randomUUID()}"><div class="form-grid"><label class="field">Tipo de teste<select name="kind" id="test-kind"><option value="standalone">Cobrança de teste separada</option><option value="invoice">Pagar uma fatura existente</option></select></label><div id="test-amount">${field("Nome da fatura de teste","name","Fatura de teste","text","maxlength=150")}${field("Valor do teste (R$)","amount","1.00","number","min=0.01 max=1000000 step=0.01 required")}</div><label class="field full" id="test-invoice-field" hidden>Fatura<select name="invoiceId"><option value="">Selecione uma fatura</option>${open.map(i=>`<option value="${i.id}">${esc(client(i.clientId)?.name)} · ${esc(client(i.clientId)?.company)} · ${esc(i.name)} · ${date(i.due)} · saldo ${brl(balance(i))}</option>`).join("")}</select></label>${field("WhatsApp para receber o teste","phone","+55 ","tel","placeholder=+5511999999999","Brasil: +55, DDD e número. Para outro país, altere +55. Obrigatório ao enviar WhatsApp.")}<div>${check("sendWhatsapp","Enviar o link de teste pelo WhatsApp",true)}</div></div><p class="help">O teste separado não cria faturas nem altera saldos dos clientes. Ao escolher uma fatura, será cobrado seu saldo real; o pagamento será aplicado à mais antiga da mesma cobrança, podendo quitar ou abater outras referências. O Pix é pago por você no checkout.</p><div class="inline-error" role="alert"></div><button class="primary">Gerar teste</button></form><div class="subsection">Resultados dos testes</div>${btn("Atualizar resultados","refresh-tests")}${(state.integrationTests||[]).map(t=>{
    const payments=(state.payments||[]).filter(p=>p.orderId===t.orderId);
    const paid=t.status==="paid"||payments.length>0;
    const allocations=payments.flatMap(p=>p.allocations||[]);
    const selected=state.invoices.find(i=>i.id===t.invoiceId);
    return `<article class="notice"><div><strong>${t.kind==="invoice" ? "Fatura existente" : "Teste separado"} · ${brl(t.amount)}</strong> ${badge(paid?"paid":t.status==="failed"?"failed":"pending")}<small>${new Date(t.created).toLocaleString("pt-BR")} · WhatsApp: ${esc({sent:"aceito pela Uazapi",uncertain:"envio incerto — confira no provedor",waiting:"aguardando",not_requested:"não solicitado"}[t.whatsappStatus]||t.whatsappStatus)}</small>${t.paymentUrl?`<p><a href="${esc(t.paymentUrl)}" target="_blank" rel="noopener noreferrer">Abrir checkout InfinitePay e pagar via Pix ↗</a></p>`:""}${t.error?`<p>${esc(t.error)}</p>`:""}${selected?`<p>Fatura selecionada: ${esc(selected.number)} · ${labels[status(selected)]} · saldo ${brl(balance(selected))}</p>`:""}${allocations.map(a=>{const i=state.invoices.find(i=>i.id===a.invoiceId);return `<p>${esc(i?.number || a.invoiceId)} · aplicado ${brl(a.amount)} · ${i ? labels[status(i)]+" · saldo "+brl(balance(i)) : "fatura arquivada"}</p>`;}).join("")}${payments.some(p=>p.remaining>0)?`<p>Crédito restante: ${brl(payments.reduce((n,p)=>n+p.remaining,0))}</p>`:""}${t.kind==="standalone"&&paid?"<p>Pagamento de teste confirmado. Nenhuma fatura de cliente foi alterada.</p>":""}</div></article>`;
  }).join("") || '<p class="muted">Nenhum teste realizado.</p>'}</div></section>`;
}
function invoiceEditor(id) {
  const i = state.invoices.find(i=>i.id===id);
  modal("Editar fatura", `<form id="invoice-editor" data-id="${esc(id)}"><div class="form-grid"><label class="field">Cliente<select name="clientId" id="invoice-client">${state.clients.filter(c=>!c.deletedAt || c.id===i.clientId).map(c=>`<option value="${c.id}" ${c.id===i.clientId?"selected":""}>${esc(c.name)}</option>`).join("")}</select></label>${field("Empresa do cadastro", "companyDisplay", client(i.clientId)?.company, "text", "readonly")}<label class="field full">Cobrança recorrente<select name="planId" id="invoice-plan">${state.plans.filter(p=>!p.deletedAt && p.clientId===i.clientId).map(p=>`<option value="${p.id}" ${p.id===i.planId?"selected":""}>${esc(p.name)}</option>`).join("")}</select></label>${field("Nome da fatura","name",i.name,"text","required maxlength=150")}${field("Número da fatura","number",i.number,"text","required maxlength=150")}${field("Referência","reference",i.reference,"month","required")}${field("Vencimento","due",i.due,"date","required")}${field("Valor total (R$)","amount",(i.amount/100).toFixed(2),"number","required min=0.01 max=1000000 step=0.01")}<label class="field">Status<select name="status">${[["pending","Aguardando pagamento (atraso calculado pelo vencimento)"],["paid","Pago"],["cancelled","Cancelada"]].map(([v,l])=>`<option value="${v}" ${v===i.status?"selected":""}>${l}</option>`).join("")}</select></label>${field("Data do pagamento","paidAt",i.paidAt?.slice(0,10)||"","date")}<label class="field full">Observação / Justificativa<textarea name="note" maxlength="1000">${esc(i.note||"")}</textarea></label><input type="hidden" name="revision" value="${esc(i.revision || i.updatedAt || i.created || "")}"><p class="help full">Recebido: ${brl(i.paidAmount ?? (i.status==="paid" ? i.amount : 0))}. Saldo: ${brl(balance(i))}. As alterações valem apenas para esta fatura. O link será atualizado quando necessário; um link já enviado pode ainda ser pago, e o valor será conciliado pela ordem das faturas. Dados da transação são preservados.</p></div><div class="inline-error" role="alert"></div><div class="form-actions">${btn("Cancelar","close")}<button class="primary">Salvar fatura</button></div></form>`);
}
async function invoiceDetail(id) {
  const i = state.invoices.find((i) => i.id === id),
    previews = await api("/preview/" + id);
  modal(
    "Detalhes da fatura",
    `<div class="detail-list"><div><small>Cliente</small>${esc(client(i.clientId)?.name)}</div><div><small>Empresa</small>${esc(client(i.clientId)?.company)}</div><div><small>Número</small>${esc(i.number)}</div><div><small>Referência / Vencimento</small>${ref(i.reference)} · ${date(i.due)}</div><div><small>Valor / Status</small>${brl(i.amount)} ${badge(status(i))}<small>Recebido: ${brl(i.paidAmount ?? (i.status === "paid" ? i.amount : 0))} · Saldo: ${brl(balance(i))}</small></div></div>${i.paymentUrl ? `<p><a href="${esc(i.paymentUrl)}" target="_blank" rel="noopener noreferrer">Abrir link de pagamento ↗</a></p>` : ""}${i.note ? `<p class="help">Justificativa: ${esc(i.note)}</p>` : ""}<div class="actions">${btn("Editar fatura", "invoice-edit", i.id)}${i.status === "pending" ? btn("Gerar link de pagamento", "link", i.id) + btn("Registrar pagamento", "paid", i.id) + btn("Cancelar fatura", "cancelled", i.id, "danger") : ""}</div><div class="subsection">Prévias das mensagens</div>${previews.map((p) => `<h3>${esc(p.name)}</h3><div class="preview">${esc(p.text)}</div>`).join("")}`,
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
    if (action === "refresh-tests") { await refresh(); return; }
    if (action === "invoice-edit") return invoiceEditor(id);
    if (action === "plan-invoices") return modal("Faturas · " + plan(id).name, invoiceTable(state.invoices.filter(i=>i.planId===id).sort((a,b)=>a.due.localeCompare(b.due))));
    if (action === "import-clients") {
      modal("Importar clientes", `<form id="import-clients"><p>Selecione o arquivo JSON de clientes preparado a partir da planilha. Cadastros existentes serão preservados. Esta importação não cria faturas nem envia mensagens.</p><input type="file" name="file" accept=".json" required><div class="inline-error" role="alert"></div><div class="form-actions"><button class="primary">Importar</button></div></form>`);
      return;
    }
    if (action === "delete-plan") {
      const count=state.invoices.filter(i=>i.planId===id && i.due>state.today && i.status!=="paid" && !(i.paidAmount>0)).length;
      if (!confirm(`Excluir a cobrança ${plan(id)?.name}? A recorrência será interrompida e ${count} faturas futuras sem recebimentos serão removidas. Pagamentos, recebimentos parciais e faturas vencidas ou de hoje serão preservados.`)) return;
      const result=await api("/plans/"+id,undefined,"DELETE");await refresh();toast(`Cobrança excluída. ${result.removed} faturas futuras removidas.`);return;
    }
    if (action === "delete-client") {
      const count = state.invoices.filter(i => i.clientId === id && i.due > state.today && i.status !== "paid" && !(i.paidAmount > 0)).length;
      if (!confirm(`Excluir ${client(id)?.name}? Serão removidas ${count} faturas futuras não pagas e interrompidas as cobranças desse cliente. Pagamentos e faturas até hoje serão preservados no histórico.`)) return;
      const result = await api("/clients/" + id, undefined, "DELETE");
      await refresh();
      toast(`Cliente excluído. ${result.removed} faturas futuras removidas.`);
      return;
    }
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
    if (form.id === "integration-test") {
      const payload={id:form.dataset.requestId,kind:data.kind,amount:data.kind==="invoice"?100:Math.round(Number(data.amount)*100),name:data.name || "Fatura de teste",phone:data.phone,sendWhatsapp:fd.has("sendWhatsapp"),...(data.kind==="invoice"?{invoiceId:data.invoiceId}:{})};
      if (!confirm(data.kind==="invoice" ? "Gerar checkout real para a fatura selecionada? Se for pago, o saldo das faturas será alterado. O WhatsApp será enviado se marcado." : "Gerar cobrança real de teste? O WhatsApp será enviado ao número informado se marcado.")) return;
      const result=await api("/integration-tests",payload);
      await refresh(); toast(result.error || "Teste criado. Abra o checkout abaixo para pagar."); return;
    }
    if (form.id === "invoice-editor") {
      data.amount = Math.round(Number(data.amount) * 100);
      delete data.companyDisplay;
      await api("/invoices/" + form.dataset.id, data, "PUT");
      dialog.close(); await refresh(); toast("Fatura atualizada."); return;
    }
    if (form.id === "import-clients") {
      const rows = JSON.parse(await fd.get("file").text());
      const result = await api("/clients/import", { rows });
      await refresh();
      modal("Resultado da importação", `<p>${result.imported} clientes cadastrados; ${result.duplicates} duplicados ignorados; ${result.errors.length} pendências.</p>${result.errors.map(e => `<p>Linha ${e.row}: ${esc(e.name)} — ${esc(e.error)}</p>`).join("")}`);
      return;
    }
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
      const imageFile = fd.get("billingImageFile");
      delete data.billingImageFile;
      if (fd.has("removeBillingImage")) data.billingImage = "";
      if (imageFile?.size) {
        data.billingImage = await prepareBillingImage(imageFile);
      }
      data.sendTimes = fd.getAll("sendTime");
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
    if (form.id === "schedule") {
      await api("/schedule", { sendTimes: fd.getAll("sendTime") }, "PUT");
      await refresh();
      toast("Quantidade e horários diários salvos.");
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
document.addEventListener("change", async (e) => {
  if (e.target.name === "billingImageFile") {
    const input = e.target, file = input.files[0];
    let preview = input.parentElement.querySelector(".image-upload-preview");
    if (!preview) { preview = document.createElement("span"); preview.className = "image-upload-preview"; input.parentElement.append(preview); }
    preview.textContent = file ? "Ajustando imagem…" : "";
    if (!file) return;
    try {
      const value = await prepareBillingImage(file);
      if (input.files[0] !== file) return;
      preview.replaceChildren();
      const img = document.createElement("img"); img.src = value; img.alt = "Prévia da imagem ajustada"; img.className = "billing-image-preview";
      preview.append(img, document.createTextNode("Imagem ajustada. Salve as configurações para usar."));
    } catch (error) { if (input.files[0] === file) { input.value = ""; preview.textContent = error.message; } }
    return;
  }
  if (e.target.id === "test-kind") {
    const existing=e.target.value==="invoice";
    $("#test-amount").hidden=existing;
    $('#test-amount input[name="amount"]').disabled=existing;
    $("#test-invoice-field").hidden=!existing;
    $('[name="invoiceId"]').required=existing;
  }
  if (e.target.id === "invoice-client") {
    const id=e.target.value;
    $('[name="companyDisplay"]').value=client(id)?.company || "";
    $("#invoice-plan").innerHTML=state.plans.filter(p=>!p.deletedAt && p.clientId===id).map(p=>`<option value="${p.id}">${esc(p.name)}</option>`).join("");
  }
  if (e.target.id === "dailyCount") {
    const previous = [...document.querySelectorAll('[name="sendTime"]')].map(
      (el) => el.value,
    );
    const count = Number(e.target.value),
      times = previous.slice(0, count);
    const suggestions = [
      "09:00",
      "12:00",
      "16:00",
      "18:00",
      "20:00",
      "21:00",
      "22:00",
      "23:00",
      "08:00",
      "10:00",
      "11:00",
      "14:00",
    ];
    while (times.length < count)
      times.push(suggestions.find((t) => !times.includes(t)));
    $("#send-times").innerHTML = timeInputs(times);
  }
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
// Atualizar baixas confirmadas sem interromper formulários em edição.
let refreshingPayments = false;
setInterval(async () => {
  if (!state || dialog.open || document.visibilityState !== "visible" || refreshingPayments || ["INPUT","SELECT","TEXTAREA"].includes(document.activeElement?.tagName)) return;
  refreshingPayments = true;
  try { await refresh(); } catch { /* A próxima atualização tentará novamente. */ }
  finally { refreshingPayments = false; }
}, 30000);
