import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server.js";

test("primeiro acesso online exige código e login posterior usa apenas a senha", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "zap-hub-setup-"));
  const secret = "codigo-exclusivo-de-configuracao";
  const { app, store } = createApp(dir, undefined, secret);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  t.after(async () => {
    await new Promise((r) => server.close(r));
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base + "/healthz")).status, 200);
  const info = await (await fetch(base + "/api/auth")).json();
  assert.equal(info.setupTokenRequired, true);
  assert.ok(!JSON.stringify(info).includes(secret));
  const login = (body) =>
    fetch(base + "/api/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  assert.equal((await login({ password: "Teste-seguro-123" })).status, 403);
  assert.equal(
    (await login({ password: "Teste-seguro-123", setupToken: "errado" }))
      .status,
    403,
  );
  assert.equal(store.get("auth", "admin"), null);
  assert.equal(
    (await login({ password: "Teste-seguro-123", setupToken: secret })).status,
    200,
  );
  assert.equal(
    (await (await fetch(base + "/api/auth")).json()).setupTokenRequired,
    false,
  );
  assert.equal((await login({ password: "Teste-seguro-123" })).status, 200);
  assert.equal(
    (await login({ password: "outra-senha-123", setupToken: secret })).status,
    401,
  );
});
