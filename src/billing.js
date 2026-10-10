import { randomUUID, randomBytes } from "node:crypto";
import {
  addDays,
  render,
  today,
  time,
  ruleKind,
  scheduledSlot,
  balance,
  brDate,
  money,
} from "./domain.js";
export async function request(url, body, headers = {}) {
  const response = await fetch(url, {
    method: body ? "POST" : "GET",
    headers: { "Content-Type": "application/json", ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(20000),
    redirect: "error",
  });
  if (!response.ok)
    throw new Error(
      `Provedor retornou HTTP ${response.status}. Verifique as configurações e o painel do provedor.`,
    );
  return response.json();
}
export function createBilling(store, http = request) {
  let running = false;
  const linkLocks = new Map();
  function paymentLink(url) {
    const existing = store.all("paymentLinks").find(item => item.url === url);
    const id = existing?.id || randomBytes(16).toString("hex");
    if (!existing) store.put("paymentLinks", id, { id, url });
    return store.settings().publicUrl + "/p/" + id;
  }
  async function sendCharge(settings, number, text, url, checkoutUrl) {
    const button = settings.paymentPresentation !== "link";
    const body = button
      ? { number, type: "button", text: text.replaceAll("Pague por Pix neste link: ", "").replaceAll("Pagamento por Pix: ", "").replaceAll("Pagar via Pix:\n", "").replaceAll(url, "Toque no botão abaixo e escolha Pix para pagar."), choices: ["💳 Pagar fatura|" + checkoutUrl], ...(settings.billingImage ? { file: settings.billingImage, mimetype: "image" } : {}) }
      : { number, text, linkPreview: false };
    return http(settings.uazapiUrl + (button ? "/send/menu" : "/send/text"), body, { token: store.unseal(settings.uazapiToken) });
  }
  async function link(id) {
    if (linkLocks.has(id)) return linkLocks.get(id);
    const task = (async () => {
      const i = store.invoice(id),
        s = store.settings();
      if (!i || i.status !== "pending")
        throw new Error("Fatura não está pendente");
      if (i.paymentUrl) return i.paymentUrl;
      if (!s.handle || !s.publicUrl)
        throw new Error(
          "Configure a InfiniteTag e a URL pública HTTPS em Integrações",
        );
      const orderId = randomUUID();
      const checkout = { id: orderId, invoiceId: i.id, planId: i.planId, clientId: i.clientId, amount: balance(i), handle: s.handle };
      store.put("checkouts", orderId, checkout);
      const result = await http("https://api.checkout.infinitepay.io/links", {
        handle: s.handle,
        order_nsu: orderId,
        redirect_url: s.publicUrl + "/pagamento",
        webhook_url: s.publicUrl + "/webhooks/infinitepay",
        items: [
          {
            quantity: 1,
            price: checkout.amount,
            description: `${i.name} • ${i.reference.split("-").reverse().join("/")} • ${i.number}`,
          },
        ],
      });
      const url = new URL(result.url);
      if (url.protocol !== "https:")
        throw new Error("Link inválido retornado pelo gateway");
      const current = store.invoice(id);
      if (!current) throw new Error("Fatura excluída durante a geração do link");
      if (current.status !== "pending" || balance(current) !== checkout.amount || current.clientId !== checkout.clientId || current.planId !== checkout.planId || (current.revision || "") !== (i.revision || ""))
        throw new Error("A fatura mudou durante a geração do link. Gere novamente.");
      current.checkoutId = orderId;
      current.paymentUrl = url.href;
      current.gatewayHandle = s.handle;
      store.saveInvoice(current);
      store.event("link", `Link de pagamento gerado para ${i.number}`);
      return url.href;
    })();
    linkLocks.set(id, task);
    try {
      return await task;
    } finally {
      linkLocks.delete(id);
    }
  }
  async function confirm(payload) {
    let checkout = store.get("checkouts", payload.order_nsu);
    if (!checkout) {
      const old = store.invoice(payload.order_nsu);
      if (!old?.gatewayHandle) throw new Error("Pedido não encontrado ou sem checkout gerado");
      checkout = { id: old.id, invoiceId: old.id, planId: old.planId, clientId: old.clientId, amount: old.amount, handle: old.gatewayHandle };
      store.put("checkouts", checkout.id, checkout);
    }
    const slug = payload.invoice_slug || payload.slug;
    if (!slug || !payload.transaction_nsu) throw new Error("Dados de transação incompletos");
    const paymentId = checkout.handle + ":" + payload.transaction_nsu;
    if (checkout.testId && store.get("testPayments", paymentId)) return true;
    if (store.get("payments", paymentId)) return true;
    const result = await http("https://api.checkout.infinitepay.io/payment_check", {
      handle: checkout.handle, order_nsu: checkout.id,
      transaction_nsu: payload.transaction_nsu, slug,
    });
    if (result.success !== true || result.paid !== true || Number(result.amount) !== checkout.amount || Number(result.paid_amount) < checkout.amount)
      throw new Error("Pagamento ainda não confirmado ou valor divergente");
    if (checkout.testId) {
      const test = store.get("integrationTests", checkout.testId);
      if (!test) throw new Error("Teste não encontrado");
      store.db.exec("BEGIN IMMEDIATE");
      try {
        if (!store.get("testPayments", paymentId)) {
          store.put("testPayments", paymentId, { id: paymentId, orderId: checkout.id, amount: checkout.amount, created: new Date().toISOString() });
          store.put("integrationTests", test.id, { ...test, status: "paid", paidAt: new Date().toISOString(), transaction: payload.transaction_nsu });
          store.event("teste", "Pagamento de teste confirmado pela InfinitePay");
        }
        store.db.exec("COMMIT");
      } catch (e) { store.db.exec("ROLLBACK"); throw e; }
      return true;
    }
    store.recordPayment({ id: paymentId, transaction: payload.transaction_nsu, orderId: checkout.id, slug,
      planId: checkout.planId, clientId: checkout.clientId, amount: checkout.amount, remaining: checkout.amount,
      method: result.capture_method, created: new Date().toISOString(), allocations: [] });
    return true;
  }
  function eligible(now = today()) {
    const rules = store.all("rules").filter((r) => r.active);
    const result = [];
    for (const i of store.invoices()) {
      const p = store.get("plans", i.planId),
        c = store.get("clients", i.clientId);
      if (
        i.status !== "pending" ||
        !p?.active ||
        !c?.active ||
        !c.phone ||
        now < p.start ||
        now > p.end
      )
        continue;
      // Uma mensagem por horário: lembrete personalizado tem prioridade no dia exato.
      const custom = rules.find(
        (r) => ruleKind(r) === "custom" && addDays(i.due, r.offset) === now,
      );
      const r =
        custom ||
        rules.find((r) => {
          const kind = ruleKind(r);
          if (kind === "available")
            return now >= addDays(i.due, r.offset) && now < i.due;
          if (kind === "due") return now === i.due;
          if (kind === "overdue") return now > i.due;
          return false;
        });
      if (r) result.push({ i, p, c, r, date: now });
    }
    return result;
  }
  async function run({
    force = false,
    now = today(),
    currentTime = time(),
  } = {}) {
    if (running) return { busy: true };
    running = true;
    try {
      const generated = store.generate(now),
        s = store.settings();
      let sent = 0,
        failed = 0;
      const times = s.sendTimes || ["09:00"];
      const slot = scheduledSlot(times, currentTime, force);
      if ((!force && !s.auto) || !slot) return { generated, sent, failed };
      const blockDays =
        store.all("rules").find((r) => ruleKind(r) === "overdue")?.offset ?? 5;
      for (const item of eligible(now)) {
        const { i, p, c, r } = item,
          id = randomUUID(),
          mode = s.mode;
        if (
          store.db
            .prepare(
              "SELECT id FROM deliveries WHERE invoice_id=? AND scheduled_date=? AND scheduled_slot=? AND mode=?",
            )
            .get(i.id, now, slot, mode)
        )
          continue;
        const attempted = store.db
          .prepare(
            "SELECT COUNT(*) AS count FROM deliveries WHERE invoice_id=? AND scheduled_date=? AND mode=?",
          )
          .get(i.id, now, mode).count;
        if (attempted >= times.length) continue;
        let text = render(r.template, i, c, p, now, blockDays),
          data = {
            created: new Date().toISOString(),
            number: i.number,
            client: c.name,
            rule: r.name,
            text,
            error: "",
            scheduledDate: now,
            scheduledSlot: slot,
          };
        const claimed = store.db
          .prepare("INSERT OR IGNORE INTO deliveries VALUES(?,?,?,?,?,?,?,?)")
          .run(
            id,
            i.id,
            r.id,
            mode,
            "preparing",
            JSON.stringify(data),
            now,
            slot,
          );
        if (!claimed.changes) continue;
        let status = "simulated";
        try {
          if (mode === "live") {
            if (!s.uazapiUrl || !s.uazapiToken)
              throw new Error("Configure a Uazapi antes de enviar");
            await link(i.id);
            const fresh = store.invoice(i.id);
            if (
              fresh?.status !== "pending" ||
              !store.get("plans", p.id)?.active ||
              !store.get("clients", c.id)?.active
            ) {
              status = "skipped";
              continue;
            }
            text = render(r.template, fresh, c, p, now, blockDays);
            text = text.replaceAll(fresh.paymentUrl, paymentLink(fresh.paymentUrl));
            data.text = text;
            store.db
              .prepare(
                "UPDATE deliveries SET status='sending',data=? WHERE id=?",
              )
              .run(JSON.stringify(data), id);
            status = "uncertain";
            const result = await sendCharge(s, c.phone, text, paymentLink(fresh.paymentUrl), fresh.paymentUrl);
            if (result.error || result.success === false)
              throw new Error(
                "Uazapi não confirmou o envio; confira no provedor",
              );
            data.providerId = result.messageid || result.id || null;
            status = "sent";
          }
          sent++;
        } catch (e) {
          data.error = e.message;
          if (status !== "uncertain") status = "failed";
          failed++;
        } finally {
          store.db
            .prepare("UPDATE deliveries SET status=?,data=? WHERE id=?")
            .run(status, JSON.stringify(data), id);
        }
      }
      if (force || sent || failed || generated)
        store.event(
          "rotina",
          `${s.mode === "live" ? "Envio" : "Simulação"}: ${sent} processados, ${failed} falhas, ${generated} faturas criadas`,
        );
      return { generated, sent, failed };
    } finally {
      running = false;
    }
  }
  async function integrationTest(input) {
    const previous = store.get("integrationTests", input.id);
    if (previous) return previous;
    const s = store.settings();
    if (!s.handle || !s.publicUrl) throw new Error("Configure a InfiniteTag e a URL pública primeiro");
    if (input.sendWhatsapp && (!s.uazapiUrl || !s.uazapiToken)) throw new Error("Configure a URL e o token da Uazapi antes de enviar o teste");
    const test = { ...input, created: new Date().toISOString(), status: "creating", whatsappStatus: input.sendWhatsapp ? "waiting" : "not_requested" };
    const saveTest = () => {
      const current = store.get("integrationTests", test.id);
      if (current?.status === "paid") Object.assign(test, { status: "paid", paidAt: current.paidAt, transaction: current.transaction });
      store.put("integrationTests", test.id, test);
    };
    saveTest();
    try {
      if (input.kind === "invoice") {
        const i = store.invoice(input.invoiceId);
        if (!i || i.status !== "pending") throw new Error("Escolha uma fatura em aberto");
        test.amount = balance(i);
        test.paymentUrl = await link(i.id);
        test.orderId = store.invoice(i.id).checkoutId || i.id;
      } else {
        test.orderId = randomUUID();
        store.put("checkouts", test.orderId, { id: test.orderId, testId: test.id, amount: test.amount, handle: s.handle });
        const result = await http("https://api.checkout.infinitepay.io/links", {
          handle: s.handle, order_nsu: test.orderId, redirect_url: s.publicUrl + "/pagamento", webhook_url: s.publicUrl + "/webhooks/infinitepay",
          items: [{ quantity: 1, price: test.amount, description: "Zap Hub — teste de integração Pix" }],
        });
        const url = new URL(result.url);
        if (url.protocol !== "https:") throw new Error("Link inválido retornado pelo gateway");
        test.paymentUrl = url.href;
      }
      test.status = "pending";
      saveTest();
      if (input.sendWhatsapp) {
        test.whatsappStatus = "uncertain";
        saveTest();
        const invoice = input.kind === "invoice" ? store.invoice(input.invoiceId) : null;
        const customer = invoice ? store.get("clients", invoice.clientId) : null;
        test.messageLink = paymentLink(test.paymentUrl);
        test.message = [
          customer ? `Olá, ${customer.name}!` : "Olá!",
          "", "Sua fatura está disponível para pagamento.", "",
          customer ? `Empresa: ${customer.company}` : "Cobrança demonstrativa — teste de integração",
          `Fatura: ${invoice?.name || input.name || "Fatura de teste"}`,
          `Número: ${invoice?.number || "TESTE-" + test.id.slice(0,8).toUpperCase()}`,
          `Referência: ${(invoice?.reference || today().slice(0,7)).split("-").reverse().join("/")}`,
          `Vencimento: ${brDate(invoice?.due || today())}`,
          `Valor a pagar: ${money(test.amount)}`, "",
          "Pagar via Pix:", test.messageLink,
          "No checkout, escolha Pix para visualizar o QR Code e o Copia e Cola.",
        ].join("\n");
        saveTest();
        const result = await sendCharge(s, test.phone, test.message, test.messageLink, test.paymentUrl);
        if (result.error || result.success === false) throw new Error("Uazapi não confirmou o envio. Confira no provedor antes de repetir.");
        test.whatsappStatus = "sent";
        test.providerId = result.messageid || result.id || null;
      }
    } catch (e) {
      test.error = e.message;
      if (!test.paymentUrl) test.status = "failed";
    }
    // A confirmação pode chegar enquanto a chamada ao WhatsApp ainda está em andamento.
    const latest = store.get("integrationTests", test.id);
    store.put("integrationTests", test.id, { ...test, ...(latest?.status === "paid" ? { status: "paid", paidAt: latest.paidAt, transaction: latest.transaction } : {}) });
    store.event("teste", `Teste ${test.kind}: ${test.status}; WhatsApp: ${test.whatsappStatus}`);
    return store.get("integrationTests", test.id);
  }
  return { link, confirm, eligible, run, integrationTest };
}
