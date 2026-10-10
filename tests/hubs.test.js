import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, verify } from "node:crypto";
import { createApp } from "../src/server.js";
import { createHubs } from "../src/hubs.js";

async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "zap-hubs-"));
  const { app, store, billing } = createApp(dir, async () => ({
    url: "https://checkout.infinitepay.io/test",
    id: "message",
  }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  t.after(async () => {
    await new Promise((r) => server.close(r));
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = "";
  async function req(path, body, headers = {}, method = body ? "POST" : "GET") {
    const r = await fetch(base + path, {
      method,
      headers: { "Content-Type": "application/json", cookie, ...headers },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return {
      status: r.status,
      headers: r.headers,
      data: await r.json().catch(() => null),
    };
  }
  const auth = await req("/api/auth", { password: "Teste-seguro-123" });
  cookie = auth.headers.get("set-cookie").split(";")[0];
  const clientId = randomUUID(),
    planId = randomUUID();
  store.put("clients", clientId, {
    id: clientId,
    name: "Cliente",
    company: "Empresa",
    phone: "5537920007857",
    active: true,
  });
  store.put("plans", planId, {
    id: planId,
    clientId,
    name: "Sistema",
    active: true,
    start: "2026-01-01",
    end: "2027-12-31",
    day: 10,
    amount: 10000,
  });
  const id = randomUUID();
  store.db
    .prepare("INSERT INTO invoices VALUES(?,?,?,?)")
    .run(
      id,
      planId,
      "2026-01",
      JSON.stringify({
        id,
        clientId,
        planId,
        name: "Mensalidade",
        number: "T-1",
        reference: "2026-01",
        due: "2026-01-10",
        status: "pending",
        amount: 10000,
      }),
    );
  return {
    store,
    req,
    planId,
    invoiceId: id,
    hubs: createHubs(store, billing),
  };
}
function unpack(token, key) {
  const [body, signature] = token.split(".");
  assert.ok(
    verify(null, Buffer.from(body), key, Buffer.from(signature, "base64url")),
  );
  return JSON.parse(Buffer.from(body, "base64url"));
}
test("pareamento único, token isolado e estado assinado sem expor segredos", async (t) => {
  const { req, planId, hubs } = await fixture(t);
  const created = await req("/api/hubs", { name: "Caixa", planId });
  assert.equal(created.status, 200);
  const installationId = randomUUID(),
    body = { code: created.data.code, machine: "PC-1", installationId };
  const pair = await req("/device-api/pair", body);
  assert.equal(pair.status, 200);
  assert.equal((await req("/device-api/pair", body)).status, 400);
  assert.equal((await req("/device-api/status", {})).status, 401);
  const headers = {
    authorization: "Bearer " + pair.data.token,
    "x-installation-id": installationId,
  };
  const state = await req("/device-api/status", { version: "1.0" }, headers);
  assert.equal(unpack(state.data.lease, pair.data.publicKey).status, "blocked");
  assert.equal(
    (
      await req(
        "/device-api/status",
        {},
        { ...headers, "x-installation-id": randomUUID() },
      )
    ).status,
    401,
  );
  const list = (await req("/api/hubs")).data;
  assert.equal(list.hubs[0].online, true);
  assert.ok(!JSON.stringify(list).includes(pair.data.token));
  assert.ok(!JSON.stringify(list).includes("privateKey"));
  const noLogin = await req("/api/hubs", undefined, { cookie: "" });
  assert.equal(noLogin.status, 401);
});
test("confiança compartilha contador, repetições não consomem mais e bloqueio manual prevalece", async (t) => {
  const { req, planId, store, hubs } = await fixture(t);
  const created = (
    await req("/api/hubs", { name: "Caixa", planId, trustLimit: 1 })
  ).data;
  const installationId = randomUUID(),
    pair = (
      await req("/device-api/pair", {
        code: created.code,
        machine: "PC",
        installationId,
      })
    ).data;
  const headers = {
    authorization: "Bearer " + pair.token,
    "x-installation-id": installationId,
  };
  for (let i = 0; i < 2; i++)
    assert.equal((await req("/device-api/trust", {}, headers)).status, 200);
  assert.equal(store.get("hubTrust", planId).count, 1);
  store.put("hubTrust", planId, { count: 1, until: "2020-01-01T00:00:00Z" });
  assert.equal((await req("/device-api/trust", {}, headers)).status, 403);
  await req(
    "/api/hubs/" + created.id,
    { policy: "blocked", trustLimit: 3, offlineHours: 24 },
    {},
    "PUT",
  );
  assert.equal((await req("/device-api/trust", {}, headers)).status, 403);
  assert.equal(
    unpack(
      (await req("/device-api/status", {}, headers)).data.lease,
      pair.publicKey,
    ).forced,
    true,
  );
  await req(
    "/api/hubs/" + created.id,
    { policy: "released", trustLimit: 3, offlineHours: 24 },
    {},
    "PUT",
  );
  assert.equal(
    hubs.situation(store.get("hubs", created.id)).status,
    "released",
  );
});
test("regras de datas, pagamento libera próxima fatura e revogação bloqueia", async (t) => {
  const { store, hubs, planId, invoiceId } = await fixture(t);
  const hub = {
    id: randomUUID(),
    planId,
    trustLimit: 1,
    offlineHours: 24,
    policy: "auto",
  };
  assert.equal(hubs.situation(hub, "2026-01-04").status, "ok");
  assert.equal(hubs.situation(hub, "2026-01-05").status, "available");
  assert.equal(hubs.situation(hub, "2026-01-10").status, "available");
  assert.equal(hubs.situation(hub, "2026-01-11").status, "overdue");
  assert.equal(hubs.situation(hub, "2026-01-15").status, "blocked");
  store.saveInvoice({ ...store.invoice(invoiceId), status: "paid" });
  assert.equal(hubs.situation(hub, "2026-01-15").status, "ok");
  assert.equal(
    hubs.situation({ ...hub, revoked: true }, "2026-01-15").status,
    "blocked",
  );
});
test("contrassenha é assinada, limitada e vinculada ao Hub e instalação", async (t) => {
  const { req, planId } = await fixture(t),
    created = (await req("/api/hubs", { name: "PC", planId })).data;
  const installationId = randomUUID(),
    pair = (
      await req("/device-api/pair", {
        code: created.code,
        machine: "PC",
        installationId,
      })
    ).data;
  const challenge = created.id + ":" + "a".repeat(32);
  const result = await req("/api/hubs/counter-code", { challenge, hours: 24 });
  assert.equal(result.status, 200);
  const payload = unpack(result.data.code, pair.publicKey);
  assert.equal(payload.installationId, installationId);
  assert.equal(payload.nonce, "a".repeat(32));
  assert.equal(
    Date.parse(payload.expiresAt) - Date.parse(payload.issuedAt),
    86400000,
  );
  assert.equal(
    (await req("/api/hubs/counter-code", { challenge, hours: 25 })).status,
    400,
  );
  assert.equal(
    (await req("/api/hubs/counter-code", { challenge, hours: 24 })).data.code,
    result.data.code,
  );
});
