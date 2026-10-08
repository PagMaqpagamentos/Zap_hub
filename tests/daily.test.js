import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createStore } from "../src/store.js";
import { createBilling } from "../src/billing.js";
import { createApp } from "../src/server.js";
import {
  sendTimesSchema,
  scheduledSlot,
  time,
  render,
  ruleSchema,
} from "../src/domain.js";

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "zap-hub-daily-"));
  const s = createStore(dir);
  t.after(() => {
    s.db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const c = {
    id: randomUUID(),
    name: "Cliente Teste",
    company: "Empresa Teste",
    phone: "5511999999999",
    cpf: "52998224725",
    active: true,
  };
  const p = {
    id: randomUUID(),
    clientId: c.id,
    name: "Mensalidade",
    amount: 10000,
    day: 10,
    start: "2026-10-01",
    end: "2026-10-31",
    active: true,
  };
  s.put("clients", c.id, c);
  s.put("plans", p.id, p);
  s.put("settings", "main", {
    ...s.settings(),
    auto: true,
    sendTimes: ["09:00", "16:00"],
  });
  s.generate("2026-10-01");
  return {
    s,
    p,
    c,
    b: createBilling(s, () => {
      throw Error("Provedor não deve ser chamado em simulação");
    }),
    i: s.invoices()[0],
  };
}
test("sequência diária: cinco dias antes, no vencimento e todos os dias de atraso", async (t) => {
  const { s, b } = fixture(t);
  assert.equal(b.eligible("2026-10-04").length, 0);
  for (let day = 5; day <= 16; day++) {
    const now = `2026-10-${String(day).padStart(2, "0")}`;
    const kind =
      day < 10 ? "disponivel" : day === 10 ? "vencimento" : "bloqueio";
    assert.equal(b.eligible(now)[0].r.id, kind);
    for (const currentTime of ["09:00", "16:00"]) {
      assert.equal((await b.run({ now, currentTime })).sent, 1);
      assert.equal((await b.run({ now, currentTime })).sent, 0);
    }
  }
  assert.equal(s.deliveries().length, 24);
});
test("pagamento entre horários cancela o segundo aviso e os próximos dias", async (t) => {
  const { b, s, i } = fixture(t);
  assert.equal(
    (await b.run({ now: "2026-10-07", currentTime: "09:00" })).sent,
    1,
  );
  s.saveInvoice({ ...i, status: "paid" });
  assert.equal(
    (await b.run({ now: "2026-10-07", currentTime: "16:00" })).sent,
    0,
  );
  assert.equal(
    (await b.run({ now: "2026-10-08", currentTime: "09:00" })).sent,
    0,
  );
});
test("recuperação tem tolerância de 30 minutos e não acumula horários perdidos", async (t) => {
  const { b, s } = fixture(t);
  assert.equal(
    (await b.run({ now: "2026-10-07", currentTime: "08:59" })).sent,
    0,
  );
  assert.equal(
    (await b.run({ now: "2026-10-07", currentTime: "09:31" })).sent,
    0,
  );
  assert.equal(
    (await b.run({ now: "2026-10-07", currentTime: "16:15" })).sent,
    1,
  );
  assert.equal(s.deliveries()[0].scheduledSlot, "16:00");
  assert.equal(
    (await b.run({ now: "2026-10-08", currentTime: "09:30" })).sent,
    1,
  );
  assert.equal(s.deliveries().length, 2);
});
test("execução manual e alteração de horários não ultrapassam a quantidade diária", async (t) => {
  const { b, s } = fixture(t);
  s.put("settings", "main", { ...s.settings(), sendTimes: ["09:00"] });
  assert.equal(
    (await b.run({ force: true, now: "2026-10-07", currentTime: "08:00" }))
      .sent,
    1,
  );
  assert.equal(
    (await b.run({ now: "2026-10-07", currentTime: "09:00" })).sent,
    0,
  );
  s.put("settings", "main", { ...s.settings(), sendTimes: ["16:00"] });
  assert.equal(
    (await b.run({ force: true, now: "2026-10-07", currentTime: "16:00" }))
      .sent,
    0,
  );
  assert.equal(
    (await b.run({ now: "2026-10-08", currentTime: "16:00" })).sent,
    1,
  );
});
test("personalizado substitui a etapa no dia exato sem duplicar o horário", async (t) => {
  const { b, s } = fixture(t);
  s.put("rules", "especial", {
    id: "especial",
    kind: "custom",
    name: "Aviso especial",
    offset: -2,
    template: "Especial",
    active: true,
  });
  assert.equal(b.eligible("2026-10-08")[0].r.id, "especial");
  assert.equal(
    (await b.run({ now: "2026-10-08", currentTime: "09:00" })).sent,
    1,
  );
  assert.equal(s.deliveries()[0].text, "Especial");
  assert.equal(b.eligible("2026-10-09")[0].r.id, "disponivel");
});
test("datas de bloqueio funcionam na virada do mês e texto muda após o prazo", (t) => {
  const { i, c, p } = fixture(t),
    invoice = { ...i, due: "2026-01-29" };
  assert.match(
    render(
      "{{data_bloqueio}} / {{dias_para_bloqueio}} / {{aviso_bloqueio}}",
      invoice,
      c,
      p,
      "2026-01-31",
      5,
    ),
    /^03\/02\/2026 \/ 3 \/ Para evitar/,
  );
  assert.match(
    render("{{aviso_bloqueio}}", invoice, c, p, "2026-02-03", 5),
    /termina hoje/,
  );
  assert.match(
    render("{{aviso_bloqueio}}", invoice, c, p, "2026-02-04", 5),
    /terminou em 03\/02\/2026/,
  );
});
test("horários e etapas inválidos são rejeitados; relógio usa Brasília", () => {
  for (const invalid of [
    [],
    ["24:00"],
    ["09:60"],
    ["9:00"],
    ["09:00", "09:00"],
  ])
    assert.equal(sendTimesSchema.safeParse(invalid).success, false);
  assert.deepEqual(sendTimesSchema.parse(["16:00", "09:00"]), [
    "09:00",
    "16:00",
  ]);
  assert.equal(time(new Date("2026-10-08T02:59:00Z")), "23:59");
  assert.equal(time(new Date("2026-10-08T03:00:00Z")), "00:00");
  assert.equal(scheduledSlot(["09:00", "09:15"], "09:20"), "09:15");
  for (const [kind, offset] of [
    ["available", 5],
    ["due", 1],
    ["overdue", 0],
  ])
    assert.equal(
      ruleSchema.safeParse({
        kind,
        offset,
        name: "Teste",
        template: "Teste",
        active: true,
      }).success,
      false,
    );
});
test("migração preserva histórico, senha, token e não reenvia horário já enviado", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "zap-hub-migrate-"));
  let old = createStore(dir);
  const c = { id: randomUUID(), name: "Teste", company: "Teste", phone: "5511999999999", active: true },
    p = {
      id: randomUUID(),
      clientId: c.id,
      name: "Mensalidade",
      amount: 10000,
      day: 10,
      start: "2026-10-01",
      end: "2026-10-31",
      active: true,
    };
  old.put("clients", c.id, c);
  old.put("plans", p.id, p);
  old.generate("2026-10-01");
  const i = old.invoices()[0];
  const token = old.seal("token-de-teste");
  old.put("settings", "main", {
    ...old.settings(),
    sendTimes: undefined,
    sendHour: 9,
    uazapiToken: token,
  });
  old.put("auth", "admin", { salt: "preservado", hash: "preservado" });
  old.db.close();
  const legacy = new DatabaseSync(join(dir, "zap-hub.sqlite"));
  legacy.exec(
    "DROP TABLE deliveries; CREATE TABLE deliveries(id TEXT PRIMARY KEY,invoice_id TEXT NOT NULL,rule_id TEXT NOT NULL,mode TEXT NOT NULL,status TEXT NOT NULL,data TEXT NOT NULL,UNIQUE(invoice_id,rule_id,mode))",
  );
  const record = {
    created: "2026-10-07T12:00:00Z",
    text: "Mensagem anterior",
    client: "Teste",
  };
  legacy
    .prepare("INSERT INTO deliveries VALUES(?,?,?,?,?,?)")
    .run(
      "legacy-1",
      i.id,
      "disponivel",
      "simulation",
      "simulated",
      JSON.stringify(record),
    );
  legacy.close();
  const s = createStore(dir);
  t.after(() => {
    s.db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  assert.equal(s.deliveries()[0].text, "Mensagem anterior");
  assert.equal(s.get("auth", "admin").hash, "preservado");
  assert.equal(s.unseal(s.settings().uazapiToken), "token-de-teste");
  assert.deepEqual(s.settings().sendTimes, ["09:00"]);
  const b = createBilling(s);
  assert.equal(
    (await b.run({ force: true, now: "2026-10-07", currentTime: "09:15" }))
      .sent,
    0,
  );
  assert.equal(
    (await b.run({ force: true, now: "2026-10-08", currentTime: "09:15" }))
      .sent,
    1,
  );
});
test("API salva horários ordenados sem alterar integrações ou modo de envio", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "zap-hub-schedule-"));
  const { app, store } = createApp(dir);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  t.after(async () => {
    await new Promise((r) => server.close(r));
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  let response = await fetch(base + "/api/auth", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "Senha-Teste-2026" }),
  });
  const cookie = response.headers.get("set-cookie").split(";")[0];
  const update = (sendTimes) =>
    fetch(base + "/api/schedule", {
      method: "PUT",
      headers: { cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ sendTimes }),
    });
  assert.equal((await update(["09:00", "09:00"])).status, 400);
  response = await update(["16:00", "09:00"]);
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).sendTimes, ["09:00", "16:00"]);
  assert.equal(store.settings().auto, false);
  assert.equal(store.settings().mode, "simulation");
});
