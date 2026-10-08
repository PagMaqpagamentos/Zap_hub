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

test("edição de fatura valida versão, datas, saldo e preserva geração recorrente", async t => {
  const dir=mkdtempSync(join(tmpdir(),"zap-hub-edit-"));
  const {app,store}=createApp(dir);const server=app.listen(0,"127.0.0.1");await new Promise(r=>server.once("listening",r));
  t.after(async()=>{await new Promise(r=>server.close(r));store.db.close();rmSync(dir,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${server.address().port}`;
  const login=await fetch(base+"/api/auth",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({password:"Teste-seguro-123"})});
  const cookie=login.headers.get("set-cookie").split(";")[0];
  const cid=crypto.randomUUID(),pid=crypto.randomUUID();
  store.put("clients",cid,{id:cid,name:"Teste",company:"Empresa",active:true});
  store.put("plans",pid,{id:pid,clientId:cid,name:"Mensal",amount:10000,day:10,start:"2026-10-01",end:"2027-01-31",active:true});
  store.generate("2026-10-01");
  const i=store.invoices().find(i=>i.reference==="2026-10");
  const payload={name:"Editada",number:"FAT-EDITADA",clientId:cid,planId:pid,reference:"2026-10",due:"2026-10-15",amount:12000,status:"pending",note:"Ajuste solicitado",paidAt:"",revision:i.created};
  const edit=(data,auth=true)=>fetch(base+"/api/invoices/"+i.id,{method:"PUT",headers:{"Content-Type":"application/json",...(auth?{cookie}:{})},body:JSON.stringify(data)});
  assert.equal((await edit(payload,false)).status,401);
  assert.equal((await edit({...payload,due:"2026-02-30"})).status,400);
  assert.equal((await edit({...payload,reference:"2026-11"})).status,409);
  assert.equal((await edit(payload)).status,200);
  assert.equal(store.invoice(i.id).amount,12000);
  assert.equal((await edit(payload)).status,409);
  assert.equal(store.generate("2026-10-01"),0);
  assert.equal(store.invoices().length,3);
  const paid={...store.invoice(i.id),paidAmount:5000};store.saveInvoice(paid);
  const next={...payload,revision:paid.revision};
  assert.equal((await edit({...next,amount:4000})).status,400);
  assert.equal((await edit({...next,status:"cancelled"})).status,400);
  assert.equal((await edit({...next,amount:13000})).status,200);
  assert.equal(store.invoice(i.id).paidAmount,5000);
});

test("API de teste exige login, valida entrada e confirma webhook separado",async t=>{
 const dir=mkdtempSync(join(tmpdir(),"zap-hub-integration-"));
 const {app,store,processWebhooks}=createApp(dir,async url=>url.endsWith("/links")?{url:"https://checkout.infinitepay.com.br/test"}:{success:true,paid:true,amount:100,paid_amount:100,capture_method:"pix"});
 const server=app.listen(0,"127.0.0.1");await new Promise(r=>server.once("listening",r));t.after(async()=>{await new Promise(r=>server.close(r));store.db.close();rmSync(dir,{recursive:true,force:true});});
 const base=`http://127.0.0.1:${server.address().port}`;
 const post=(path,data,cookie="")=>fetch(base+path,{method:"POST",headers:{"Content-Type":"application/json",cookie},body:JSON.stringify(data)});
 const login=await post("/api/auth",{password:"Teste-seguro-123"});const cookie=login.headers.get("set-cookie").split(";")[0];
 store.put("settings","main",{...store.settings(),handle:"loja",publicUrl:"https://exemplo.test"});
 const input={id:crypto.randomUUID(),kind:"standalone",amount:100,sendWhatsapp:false,phone:""};
 assert.equal((await post("/api/integration-tests",input)).status,401);
 assert.equal((await post("/api/integration-tests",{...input,amount:0},cookie)).status,400);
 assert.equal((await post("/api/integration-tests",{...input,sendWhatsapp:true},cookie)).status,400);
 const response=await post("/api/integration-tests",input,cookie);assert.equal(response.status,200);const result=await response.json();
 assert.equal(result.status,"pending");
 assert.equal((await post("/webhooks/infinitepay",{order_nsu:result.orderId,transaction_nsu:"integration",slug:"test"})).status,200);
 await processWebhooks();assert.equal(store.get("integrationTests",input.id).status,"paid");assert.equal(store.invoices().length,0);
});
