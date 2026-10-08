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

test("importação autenticada valida documentos e evita duplicação ao repetir", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "zap-hub-import-"));
  const {app,store} = createApp(dir);
  const server = app.listen(0,"127.0.0.1");
  await new Promise(r=>server.once("listening",r));
  t.after(async()=>{await new Promise(r=>server.close(r));store.db.close();rmSync(dir,{recursive:true,force:true});});
  const base = `http://127.0.0.1:${server.address().port}`;
  const login=await fetch(base+"/api/auth",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({password:"Teste-seguro-123"})});
  const cookie=login.headers.get("set-cookie").split(";")[0];
  const call=(path,body,method="POST",auth=true)=>fetch(base+path,{method,headers:{"Content-Type":"application/json",...(auth?{cookie}:{})},...(body?{body:JSON.stringify(body)}:{})});
  const c={name:"Cliente",company:"Empresa",cpf:"52998224725",phone:""};
  assert.equal((await call("/api/clients/import",{rows:[c]},"POST",false)).status,401);
  const result=await (await call("/api/clients/import",{rows:[c,c,{...c,cpf:"123"}]})).json();
  assert.equal(result.imported,1);assert.equal(result.duplicates,1);assert.equal(result.errors.length,1);
  assert.equal((await (await call("/api/clients/import",{rows:[c]})).json()).duplicates,1);
  assert.equal(store.invoices().length,0);
  const id=store.all("clients")[0].id;
  assert.equal((await call("/api/clients/"+id,null,"DELETE",false)).status,401);
  assert.equal((await call("/api/clients/"+id,null,"DELETE")).status,200);
  assert.equal((await call("/api/clients",{...c,id})).status,409);
});
