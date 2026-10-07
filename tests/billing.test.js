import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createStore } from "../src/store.js";
import { createBilling } from "../src/billing.js";
import { createApp } from "../src/server.js";
import { dueDate, render, clientSchema, planSchema } from "../src/domain.js";
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "zap-hub-test-")),
    s = createStore(dir);
  t.after(() => {
    s.db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const c = {
    id: randomUUID(),
    name: "João",
    company: "Paratech",
    phone: "5511999999999",
    cpf: "52998224725",
    active: true,
  };
  s.put("clients", c.id, c);
  const p = {
    id: randomUUID(),
    clientId: c.id,
    name: "Mensalidade",
    amount: 14990,
    day: 10,
    start: "2026-10-01",
    end: "2026-12-31",
    active: true,
  };
  s.put("plans", p.id, p);
  return { s, c, p };
}
test("calendário mensal ajusta dias 29, 30 e 31 inclusive em ano bissexto", () => {
  assert.equal(dueDate("2026-02", 31), "2026-02-28");
  assert.equal(dueDate("2028-02", 31), "2028-02-29");
  assert.equal(dueDate("2026-04", 31), "2026-04-30");
});
test("valida CPF, telefone, datas e período", () => {
  assert.equal(
    clientSchema.safeParse({
      name: "João",
      company: "Empresa",
      phone: "5511999999999",
      cpf: "529.982.247-25",
    }).success,
    true,
  );
  assert.equal(
    clientSchema.safeParse({
      name: "João",
      company: "Empresa",
      phone: "11999999999",
      cpf: "11111111111",
    }).success,
    false,
  );
  assert.equal(
    planSchema.safeParse({
      clientId: randomUUID(),
      name: "Teste",
      amount: 150,
      day: 10,
      start: "2026-02-30",
      end: "2026-01-01",
    }).success,
    false,
  );
});
test("gera referências únicas, respeita intervalo e preserva faturas emitidas", (t) => {
  const { s, p } = fixture(t);
  assert.equal(s.generate("2026-10-05"), 3);
  assert.equal(s.generate("2026-10-05"), 0);
  s.put("plans", p.id, { ...p, amount: 20000 });
  s.generate("2026-10-05");
  assert.equal(s.invoices()[0].amount, 14990);
  assert.deepEqual(
    s
      .invoices()
      .map((i) => i.reference)
      .sort(),
    ["2026-10", "2026-11", "2026-12"],
  );
});
test("substitui dados do cliente e fatura sem valores indefinidos", (t) => {
  const { s, c, p } = fixture(t);
  s.generate("2026-10-05");
  const i = s.invoices().find((i) => i.reference === "2026-10");
  const text = render(
    "{{nome_cliente}} / {{empresa}} / {{referencia}} / {{vencimento}} / {{valor}} / {{dias_atraso}}",
    i,
    c,
    p,
    "2026-10-13",
  );
  assert.match(text, /João \/ Paratech \/ 10\/2026 \/ 10\/10\/2026/);
  assert.match(text, /149,90 \/ 3$/);
});
test("simulação não chama provedores e não duplica; atraso usa somente último aviso", async (t) => {
  const { s } = fixture(t);
  const b = createBilling(s, () => {
    throw new Error("Não deveria chamar o provedor");
  });
  let r = await b.run({ force: true, now: "2026-10-05" });
  assert.equal(r.sent, 1);
  r = await b.run({ force: true, now: "2026-10-05" });
  assert.equal(r.sent, 0);
  assert.equal(b.eligible("2026-10-16")[0].r.id, "bloqueio");
  assert.equal(s.deliveries()[0].status, "simulated");
});
test("pago, cancelado, cliente inativo, plano pausado e período encerrado impedem envio", (t) => {
  const { s, c, p } = fixture(t);
  s.generate("2026-10-05");
  const b = createBilling(s);
  assert.equal(b.eligible("2026-10-05").length, 1);
  const i = s.invoices().find((i) => i.reference === "2026-10");
  for (const status of ["paid", "cancelled"]) {
    s.saveInvoice({ ...i, status });
    assert.equal(b.eligible("2026-10-05").length, 0);
  }
  s.saveInvoice(i);
  s.put("clients", c.id, { ...c, active: false });
  assert.equal(b.eligible("2026-10-05").length, 0);
  s.put("clients", c.id, c);
  s.put("plans", p.id, { ...p, active: false });
  assert.equal(b.eligible("2026-10-05").length, 0);
  s.put("plans", p.id, p);
  assert.equal(b.eligible("2027-01-01").length, 0);
});
test("modo real gera link em centavos e envia uma só vez mesmo com chamadas concorrentes", async (t) => {
  const { s } = fixture(t);
  s.put("settings", "main", {
    ...s.settings(),
    mode: "live",
    handle: "loja",
    publicUrl: "https://hub.example.com",
    uazapiUrl: "https://wa.example.com",
    uazapiToken: s.seal("segredo"),
  });
  const calls = [];
  const b = createBilling(s, async (url, body, headers) => {
    calls.push({ url, body, headers });
    if (url.endsWith("/links"))
      return { url: "https://checkout.infinitepay.com.br/exemplo" };
    return { id: "msg-123" };
  });
  await Promise.all([
    b.run({ force: true, now: "2026-10-05" }),
    b.run({ force: true, now: "2026-10-05" }),
  ]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body.items[0].price, 14990);
  assert.equal(calls[1].headers.token, "segredo");
  assert.match(calls[1].body.text, /https:\/\/checkout/);
  assert.equal(s.deliveries()[0].status, "sent");
});
test("resposta incerta da Uazapi não provoca reenvio automático", async (t) => {
  const { s } = fixture(t);
  s.put("settings", "main", {
    ...s.settings(),
    mode: "live",
    handle: "loja",
    publicUrl: "https://hub.example.com",
    uazapiUrl: "https://wa.example.com",
    uazapiToken: s.seal("segredo"),
  });
  let sends = 0;
  const b = createBilling(s, async (url) => {
    if (url.endsWith("/links"))
      return { url: "https://checkout.infinitepay.com.br/test" };
    sends++;
    throw new Error("Timeout");
  });
  await b.run({ force: true, now: "2026-10-05" });
  await b.run({ force: true, now: "2026-10-05" });
  assert.equal(sends, 1);
  assert.equal(s.deliveries()[0].status, "uncertain");
});
test("callback é confirmado no gateway e rejeita valor divergente; pagamento é idempotente", async (t) => {
  const { s } = fixture(t);
  s.generate("2026-10-05");
  const i = s.invoices()[0];
  s.saveInvoice({ ...i, gatewayHandle: "loja" });
  let amount = 1;
  const b = createBilling(s, async () => ({
    success: true,
    paid: true,
    amount,
    paid_amount: 14990,
    capture_method: "pix",
  }));
  const payload = {
    order_nsu: i.id,
    transaction_nsu: "tx-1",
    invoice_slug: "slug-1",
  };
  await assert.rejects(b.confirm(payload), /divergente/);
  assert.equal(s.invoice(i.id).status, "pending");
  amount = 14990;
  await b.confirm(payload);
  await b.confirm(payload);
  assert.equal(s.invoice(i.id).status, "paid");
  assert.equal(s.logs().filter((l) => l.kind === "pagamento").length, 1);
});
test("rotina respeita pausa e horário automático", async (t) => {
  const { s } = fixture(t);
  const b = createBilling(s);
  assert.equal((await b.run({ now: "2026-10-05", currentHour: 10 })).sent, 0);
  s.put("settings", "main", { ...s.settings(), auto: true });
  assert.equal((await b.run({ now: "2026-10-05", currentHour: 8 })).sent, 0);
  assert.equal((await b.run({ now: "2026-10-05", currentHour: 20 })).sent, 0);
  assert.equal((await b.run({ now: "2026-10-05", currentHour: 10 })).sent, 1);
});
test("API exige login, impede origem externa e não expõe token", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "zap-hub-api-"));
  const { app, store } = createApp(dir);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  t.after(async () => {
    await new Promise((r) => server.close(r));
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(url + "/api/state")).status, 401);
  let r = await fetch(url + "/api/auth", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "Teste-seguro-123" }),
  });
  assert.equal(r.status, 200);
  const cookie = r.headers.get("set-cookie").split(";")[0];
  r = await fetch(url + "/api/settings", {
    method: "PUT",
    headers: {
      cookie,
      origin: "https://malicioso.test",
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  assert.equal(r.status, 403);
  store.put("settings", "main", {
    ...store.settings(),
    uazapiToken: store.seal("segredo-nunca-exposto"),
  });
  r = await fetch(url + "/api/state", { headers: { cookie } });
  const data = await r.json();
  assert.equal(data.settings.tokenConfigured, true);
  assert.equal(data.settings.uazapiToken, undefined);
  assert.ok(!JSON.stringify(data).includes("segredo-nunca-exposto"));
});
