// Instância descartável para QA visual. Nunca utiliza o banco de produção.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scryptSync, randomUUID } from "node:crypto";
import { createApp } from "../src/server.js";
import { today } from "../src/domain.js";
const dir = mkdtempSync(join(tmpdir(), "zap-hub-preview-"));
const { app, store } = createApp(dir, async () => {
  throw new Error("Provedores desativados na prévia de teste");
});
store.put("auth", "admin", {
  salt: "visual-test",
  hash: scryptSync("Visual-Test-2026", "visual-test", 64).toString("hex"),
});
const month = today().slice(0, 7);
for (const [name, company, amount, day] of [
  ["João Exemplo", "Empresa Exemplo", 14990, 10],
  ["Ana Demonstração", "Estúdio Demonstração", 24990, 5],
  ["Carlos Teste", "Loja de Teste", 9900, 20],
]) {
  const id = randomUUID(),
    pid = randomUUID();
  store.put("clients", id, {
    id,
    name,
    company,
    phone: "5511999999999",
    cpf: "52998224725",
    active: true,
  });
  store.put("plans", pid, {
    id: pid,
    clientId: id,
    name: "Mensalidade do sistema",
    amount,
    day,
    start: month + "-01",
    end: month + "-28",
    active: true,
  });
}
store.generate(today());
const port = Number(process.env.QA_PORT || 3091);
const server = app.listen(port, "127.0.0.1", () =>
  console.log(`QA temporário: http://127.0.0.1:${port}`),
);
process.on("SIGINT", () =>
  server.close(() => {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
    process.exit(0);
  }),
);
