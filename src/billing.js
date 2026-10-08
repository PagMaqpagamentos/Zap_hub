import { randomUUID } from "node:crypto";
import {
  addDays,
  render,
  today,
  time,
  ruleKind,
  scheduledSlot,
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
      const result = await http("https://api.checkout.infinitepay.io/links", {
        handle: s.handle,
        order_nsu: i.id,
        redirect_url: s.publicUrl + "/pagamento",
        webhook_url: s.publicUrl + "/webhooks/infinitepay",
        items: [
          {
            quantity: 1,
            price: i.amount,
            description: `${i.name} • ${i.reference.split("-").reverse().join("/")} • ${i.number}`,
          },
        ],
      });
      const url = new URL(result.url);
      if (url.protocol !== "https:")
        throw new Error("Link inválido retornado pelo gateway");
      const current = store.invoice(id);
      if (!current) throw new Error("Fatura excluída durante a geração do link");
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
    const i = store.invoice(payload.order_nsu);
    if (!i) throw new Error("Pedido não encontrado");
    if (!i.gatewayHandle) throw new Error("Fatura sem checkout gerado");
    const slug = payload.invoice_slug || payload.slug;
    if (!slug || !payload.transaction_nsu)
      throw new Error("Dados de transação incompletos");
    const result = await http(
      "https://api.checkout.infinitepay.io/payment_check",
      {
        handle: i.gatewayHandle,
        order_nsu: i.id,
        transaction_nsu: payload.transaction_nsu,
        slug,
      },
    );
    if (
      result.success !== true ||
      result.paid !== true ||
      Number(result.amount) !== i.amount ||
      Number(result.paid_amount) < i.amount
    )
      throw new Error("Pagamento ainda não confirmado ou valor divergente");
    const fresh = store.invoice(i.id);
    if (fresh.status === "paid") return true;
    if (fresh.status === "cancelled")
      throw new Error("Pagamento de fatura cancelada: concilie manualmente");
    fresh.status = "paid";
    fresh.paidAt = new Date().toISOString();
    fresh.method = result.capture_method;
    fresh.transaction = payload.transaction_nsu;
    fresh.slug = slug;
    store.saveInvoice(fresh);
    store.event("pagamento", `Pagamento confirmado: ${i.number}`);
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
            data.text = text;
            store.db
              .prepare(
                "UPDATE deliveries SET status='sending',data=? WHERE id=?",
              )
              .run(JSON.stringify(data), id);
            status = "uncertain";
            const result = await http(
              s.uazapiUrl + "/send/text",
              { number: c.phone, text },
              { token: store.unseal(s.uazapiToken) },
            );
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
  return { link, confirm, eligible, run };
}
