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
  assert.equal(s.invoices().find(x=>x.reference==="2026-10").status, "paid");
  assert.equal(s.invoice(i.id).status, "pending");
  assert.equal(s.logs().filter((l) => l.kind === "pagamento").length, 1);
});
test("rotina respeita pausa e horário automático", async (t) => {
  const { s } = fixture(t);
  const b = createBilling(s);
  assert.equal(
    (await b.run({ now: "2026-10-05", currentTime: "09:15" })).sent,
    0,
  );
  s.put("settings", "main", { ...s.settings(), auto: true });
  assert.equal(
    (await b.run({ now: "2026-10-05", currentTime: "08:00" })).sent,
    0,
  );
  assert.equal(
    (await b.run({ now: "2026-10-05", currentTime: "20:00" })).sent,
    0,
  );
  assert.equal(
    (await b.run({ now: "2026-10-05", currentTime: "09:15" })).sent,
    1,
  );
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

test("exclusão preserva histórico e pagamentos, remove futuras e impede regeneração", (t) => {
  const {s,c,p} = fixture(t);
  s.generate("2026-10-10");
  const paid = s.invoices().find(i => i.reference === "2026-12");
  paid.status = "paid"; s.saveInvoice(paid);
  assert.deepEqual(s.deleteClient(c.id,"2026-10-10"), {removed:1});
  assert.equal(s.invoices().length,2);
  assert.ok(s.invoice(paid.id));
  assert.equal(s.get("plans",p.id).active,false);
  assert.ok(s.get("clients",c.id).deletedAt);
  assert.equal(s.generate("2026-12-01"),0);
  assert.equal(createBilling(s).eligible("2026-10-10").length,0);
  assert.equal(s.deleteClient(c.id,"2026-10-10"),null);
});

test("cliente sem WhatsApp não recebe lembretes", (t) => {
  const {s,c} = fixture(t);
  s.put("clients",c.id,{...c,phone:""});
  s.generate("2026-10-10");
  assert.equal(createBilling(s).eligible("2026-10-10").length,0);
  assert.equal(clientSchema.safeParse({...c,phone:"",cpf:"11.222.333/0001-81"}).success,true);
  assert.equal(clientSchema.safeParse({...c,cpf:"11.222.333/0001-82"}).success,false);
});

test("Pix aplica parcial e excedente em ordem; repetição e concorrência não duplicam", async t => {
  const {s,c,p}=fixture(t); s.generate("2026-10-01");
  const ordered=()=>s.invoices().sort((a,b)=>a.due.localeCompare(b.due));
  const source=ordered()[2];
  const checkout={id:randomUUID(),invoiceId:source.id,planId:p.id,clientId:c.id,amount:10000,handle:"loja"};
  s.put("checkouts",checkout.id,checkout);
  const b=createBilling(s,async()=>({success:true,paid:true,amount:10000,paid_amount:10000,capture_method:"pix"}));
  const payload={order_nsu:checkout.id,transaction_nsu:"primeiro",slug:"slug"};
  await Promise.all([b.confirm(payload),b.confirm(payload)]);
  assert.equal(ordered()[0].paidAmount,10000); assert.equal(ordered()[0].status,"pending");
  assert.equal(s.all("payments").length,1);
  await b.confirm({...payload,transaction_nsu:"segundo"});
  assert.equal(ordered()[0].status,"paid"); assert.equal(ordered()[1].paidAmount,5010);
  assert.equal(ordered()[2].paidAmount,undefined);
  assert.equal(s.all("payments").reduce((n,p)=>n+p.allocations.reduce((n,a)=>n+a.amount,0),0),20000);
  await b.confirm({...payload,transaction_nsu:"segundo"});
  assert.equal(ordered()[1].paidAmount,5010);
});

test("crédito excedente persiste e quita próxima referência sem afetar outra cobrança", async t => {
  const {s,c,p}=fixture(t); s.put("plans",p.id,{...p,end:"2027-01-31"}); s.generate("2026-10-01");
  const other={...p,id:randomUUID()}; s.put("plans",other.id,other);s.generate("2026-10-01");
  const order={id:randomUUID(),invoiceId:s.invoices().find(i=>i.planId===p.id).id,planId:p.id,clientId:c.id,amount:50000,handle:"loja"}; s.put("checkouts",order.id,order);
  const b=createBilling(s,async()=>({success:true,paid:true,amount:50000,paid_amount:50100,capture_method:"pix"}));
  await b.confirm({order_nsu:order.id,transaction_nsu:"credito",slug:"s"});
  assert.equal(s.all("payments")[0].remaining,5030);
  assert.ok(s.invoices().filter(i=>i.planId===other.id).every(i=>i.status==="pending"));
  s.generate("2026-11-01");
  assert.equal(s.invoices().find(i=>i.planId===p.id&&i.reference==="2027-01").paidAmount,5030);
  assert.equal(s.all("payments")[0].remaining,0);
});

test("link cobra só saldo e checkout antigo conserva valor após edição", async t => {
  const {s,c,p}=fixture(t);s.generate("2026-10-01");
  s.put("settings","main",{...s.settings(),handle:"loja",publicUrl:"https://exemplo.test"});
  const i=s.invoices().find(i=>i.reference==="2026-10");
  s.saveInvoice({...i,paidAmount:10000});
  let sent;
  const b=createBilling(s,async(url,body)=>{if(url.endsWith("/links")){sent=body;return {url:"https://checkout.infinitepay.com.br/test"};}return {success:true,paid:true,amount:4990,paid_amount:4990,capture_method:"pix"};});
  await b.link(i.id);assert.equal(sent.items[0].price,4990);assert.notEqual(sent.order_nsu,i.id);
  s.saveInvoice({...s.invoice(i.id),amount:16000,paymentUrl:"",revision:randomUUID()});
  await b.confirm({order_nsu:sent.order_nsu,transaction_nsu:"link-antigo",slug:"s"});
  assert.equal(s.invoice(i.id).paidAmount,14990);assert.equal(s.invoice(i.id).status,"pending");
});

test("reinício preserva alocação parcial e crédito sem repetir transação", async t => {
  const dir=mkdtempSync(join(tmpdir(),"zap-hub-persist-"));let s=createStore(dir);
  t.after(()=>{s.db.close();rmSync(dir,{recursive:true,force:true});});
  const cid=randomUUID(),pid=randomUUID();
  s.put("clients",cid,{id:cid,active:true});s.put("plans",pid,{id:pid,clientId:cid,name:"Teste",amount:10000,day:10,start:"2026-10-01",end:"2026-10-31",active:true});s.generate("2026-10-01");
  const i=s.invoices()[0],order={id:randomUUID(),invoiceId:i.id,planId:pid,clientId:cid,amount:15000,handle:"loja"};s.put("checkouts",order.id,order);
  const payload={order_nsu:order.id,transaction_nsu:"persistente",slug:"s"};
  await createBilling(s,async()=>({success:true,paid:true,amount:15000,paid_amount:15000,capture_method:"pix"})).confirm(payload);
  s.db.close();s=createStore(dir);
  await createBilling(s,async()=>{throw new Error("Não deveria consultar novamente");}).confirm(payload);
  assert.equal(s.invoice(i.id).paidAmount,10000);assert.equal(s.all("payments")[0].remaining,5000);assert.equal(s.all("payments")[0].allocations.length,1);
});
