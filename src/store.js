import { DatabaseSync } from "node:sqlite";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { defaultRules, dueDate, ruleKind, balance } from "./domain.js";
export function createStore(dir) {
  mkdirSync(dir, { recursive: true });
  const keyPath = join(dir, "secret.key");
  if (!existsSync(keyPath))
    writeFileSync(keyPath, randomBytes(32), { mode: 0o600 });
  const key = readFileSync(keyPath);
  const db = new DatabaseSync(join(dir, "zap-hub.sqlite"));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
 CREATE TABLE IF NOT EXISTS documents(kind TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(kind,id));
 CREATE TABLE IF NOT EXISTS invoices(id TEXT PRIMARY KEY,plan_id TEXT NOT NULL,reference TEXT NOT NULL,data TEXT NOT NULL,UNIQUE(plan_id,reference));
 CREATE TABLE IF NOT EXISTS deliveries(id TEXT PRIMARY KEY,invoice_id TEXT NOT NULL,rule_id TEXT NOT NULL,mode TEXT NOT NULL,status TEXT NOT NULL,data TEXT NOT NULL,scheduled_date TEXT NOT NULL,scheduled_slot TEXT NOT NULL,UNIQUE(invoice_id,scheduled_date,scheduled_slot,mode));
 CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT,created TEXT NOT NULL,kind TEXT NOT NULL,message TEXT NOT NULL);`);
  const all = (k) =>
    db
      .prepare("SELECT data FROM documents WHERE kind=?")
      .all(k)
      .map((r) => JSON.parse(r.data));
  const get = (k, id) => {
    const r = db
      .prepare("SELECT data FROM documents WHERE kind=? AND id=?")
      .get(k, id);
    return r ? JSON.parse(r.data) : null;
  };
  const put = (k, id, data) => {
    db.prepare(
      "INSERT INTO documents VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data",
    ).run(k, id, JSON.stringify(data));
    return data;
  };
  const seal = (value) => {
    const iv = randomBytes(12),
      c = createCipheriv("aes-256-gcm", key, iv);
    const body = Buffer.concat([c.update(value, "utf8"), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), body]).toString("base64");
  };
  const unseal = (value) => {
    if (!value) return "";
    const b = Buffer.from(value, "base64"),
      d = createDecipheriv("aes-256-gcm", key, b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString(
      "utf8",
    );
  };
  const invoice = (id) => {
    const r = db.prepare("SELECT data FROM invoices WHERE id=?").get(id);
    return r ? JSON.parse(r.data) : null;
  };
  const invoices = () =>
    db
      .prepare("SELECT data FROM invoices ORDER BY reference DESC")
      .all()
      .map((r) => JSON.parse(r.data));
  const saveInvoice = (i) =>
    db
      .prepare("UPDATE invoices SET data=? WHERE id=?")
      .run(JSON.stringify(i), i.id);
  const event = (kind, message) =>
    db
      .prepare("INSERT INTO events(created,kind,message) VALUES(?,?,?)")
      .run(new Date().toISOString(), kind, message);
  // Transações são registradas uma única vez; alocações e saldo ficam persistentes.
  const allocateCredits = () => {
    for (const payment of all("payments").filter(p => p.remaining > 0).sort((a,b) => a.created.localeCompare(b.created) || a.id.localeCompare(b.id))) {
      if (get("clients", payment.clientId)?.deletedAt) continue;
      const open = invoices().filter(i => i.planId === payment.planId && i.clientId === payment.clientId && i.status === "pending")
        .sort((a,b) => a.due.localeCompare(b.due) || a.reference.localeCompare(b.reference) || (a.created || "").localeCompare(b.created || "") || a.id.localeCompare(b.id));
      for (const i of open) {
        if (!payment.remaining) break;
        const applied = Math.min(payment.remaining, balance(i));
        if (!applied) continue;
        i.paidAmount = (i.paidAmount || 0) + applied;
        i.updatedAt = new Date().toISOString();
        i.revision = crypto.randomUUID();
        i.paymentUrl = ""; i.checkoutId = "";
        if (i.paidAmount >= i.amount) { i.status = "paid"; i.paidAt = payment.created; }
        i.method = payment.method;
        payment.remaining -= applied;
        payment.allocations.push({ invoiceId: i.id, amount: applied, date: i.updatedAt });
        saveInvoice(i);
        event("pagamento", `${i.number}: recebido ${(applied / 100).toFixed(2)}; saldo ${(balance(i) / 100).toFixed(2)}.`);
      }
      put("payments", payment.id, payment);
    }
  };
  const applyCredits = () => {
    db.exec("BEGIN IMMEDIATE");
    try { allocateCredits(); db.exec("COMMIT"); }
    catch (e) { db.exec("ROLLBACK"); throw e; }
  };
  if (!get("settings", "main"))
    put("settings", "main", {
      mode: "simulation",
      auto: false,
      sendHour: 9,
      sendTimes: ["09:00"],
      uazapiUrl: "",
      uazapiToken: "",
      handle: "",
      publicUrl: "",
    });
  if (!get("meta", "rulesSeeded")) {
    for (const r of defaultRules) put("rules", r.id, r);
    put("meta", "rulesSeeded", { done: true });
  }
  // Migração transacional: preserva todas as tentativas antigas e as credenciais.
  if (
    !db
      .prepare("PRAGMA table_info(deliveries)")
      .all()
      .some((c) => c.name === "scheduled_date")
  ) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const previous = db
        .prepare("SELECT * FROM deliveries ORDER BY rowid")
        .all();
      db.exec(`ALTER TABLE deliveries RENAME TO deliveries_previous;
        CREATE TABLE deliveries(id TEXT PRIMARY KEY,invoice_id TEXT NOT NULL,rule_id TEXT NOT NULL,mode TEXT NOT NULL,status TEXT NOT NULL,data TEXT NOT NULL,scheduled_date TEXT NOT NULL,scheduled_slot TEXT NOT NULL,UNIQUE(invoice_id,scheduled_date,scheduled_slot,mode));`);
      const insert = db.prepare(
        "INSERT OR IGNORE INTO deliveries VALUES(?,?,?,?,?,?,?,?)",
      );
      const firstTime = `${String(get("settings", "main").sendHour ?? 9).padStart(2, "0")}:00`;
      for (const row of previous) {
        const data = JSON.parse(row.data),
          instant = new Date(data.created);
        const day = Number.isNaN(instant.getTime())
          ? "1970-01-01"
          : new Intl.DateTimeFormat("en-CA", {
              timeZone: "America/Sao_Paulo",
              year: "numeric",
              month: "2-digit",
              day: "2-digit",
            }).format(instant);
        const values = [
          row.id,
          row.invoice_id,
          row.rule_id,
          row.mode,
          row.status,
          row.data,
          day,
        ];
        if (!insert.run(...values, firstTime).changes)
          insert.run(...values, `legacy-${row.id}`);
      }
      db.exec("DROP TABLE deliveries_previous; COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
  const settings = get("settings", "main");
  if (!settings.sendTimes)
    put("settings", "main", {
      ...settings,
      sendTimes: [`${String(settings.sendHour ?? 9).padStart(2, "0")}:00`],
    });
  if (!get("meta", "dailyReminders")) {
    for (const r of all("rules")) {
      let template = r.template;
      if (
        ["vencimento", "bloqueio"].includes(r.id) &&
        !template.includes("{{aviso_bloqueio}}")
      )
        template += "\n{{aviso_bloqueio}}";
      put("rules", r.id, { ...r, kind: ruleKind(r), template });
    }
    put("meta", "dailyReminders", { version: 1 });
  }
  db.prepare(
    "UPDATE deliveries SET status='uncertain' WHERE status='sending'",
  ).run();
  db.prepare(
    "UPDATE deliveries SET status='failed' WHERE status='preparing'",
  ).run();
  // Guardar links e baixas anteriores antes de permitir alterações das faturas.
  for (const i of invoices()) {
    if (i.gatewayHandle && !get("checkouts", i.checkoutId || i.id))
      put("checkouts", i.checkoutId || i.id, { id: i.checkoutId || i.id, invoiceId: i.id, planId: i.planId, clientId: i.clientId, amount: i.amount, handle: i.gatewayHandle });
    if (i.transaction && i.gatewayHandle && !get("payments", i.gatewayHandle + ":" + i.transaction))
      put("payments", i.gatewayHandle + ":" + i.transaction, { id: i.gatewayHandle + ":" + i.transaction, planId: i.planId, clientId: i.clientId, amount: i.amount, remaining: 0, created: i.paidAt || i.created, method: i.method, allocations: [{ invoiceId: i.id, amount: i.amount }], legacy: true });
  }
  return {
    db,
    all,
    get,
    put,
    seal,
    unseal,
    invoice,
    invoices,
    saveInvoice,
    event,
    applyCredits,
    recordPayment(payment) {
      db.exec("BEGIN IMMEDIATE");
      try {
        if (!get("payments", payment.id)) {
          put("payments", payment.id, payment);
          const checkout = get("checkouts", payment.orderId);
          const source = checkout && invoice(checkout.invoiceId);
          if (source && (source.checkoutId === payment.orderId || (!source.checkoutId && source.id === payment.orderId))) {
            source.paymentUrl = ""; source.checkoutId = ""; source.revision = crypto.randomUUID();
            saveInvoice(source);
          }
          event("recebimento", `Pagamento confirmado: ${(payment.amount / 100).toFixed(2)}. Transação ${payment.transaction}.`);
        }
        allocateCredits();
        db.exec("COMMIT");
      } catch (e) { db.exec("ROLLBACK"); throw e; }
    },
    deleteClient(id, now) {
      const c = get("clients", id);
      if (!c || c.deletedAt) return null;
      db.exec("BEGIN IMMEDIATE");
      try {
        put("clients", id, { ...c, active: false, deletedAt: new Date().toISOString() });
        for (const p of all("plans").filter((p) => p.clientId === id))
          put("plans", p.id, { ...p, active: false });
        const future = invoices().filter((i) => i.clientId === id && i.due > now && i.status !== "paid" && !(i.paidAmount > 0));
        for (const i of future) db.prepare("DELETE FROM invoices WHERE id=?").run(i.id);
        event("cliente", `Cliente excluído: ${c.name}. ${future.length} faturas futuras removidas.`);
        db.exec("COMMIT");
        return { removed: future.length };
      } catch (e) { db.exec("ROLLBACK"); throw e; }
    },
    settings: () => get("settings", "main"),
    logs: () =>
      db.prepare("SELECT * FROM events ORDER BY id DESC LIMIT 100").all(),
    deliveries: () =>
      db
        .prepare("SELECT * FROM deliveries ORDER BY rowid DESC LIMIT 200")
        .all()
        .map((r) => ({
          ...JSON.parse(r.data),
          id: r.id,
          invoiceId: r.invoice_id,
          ruleId: r.rule_id,
          mode: r.mode,
          status: r.status,
          scheduledDate: r.scheduled_date,
          scheduledSlot: r.scheduled_slot,
        })),
    generate(now) {
      let count = 0;
      const d = new Date(now + "T12:00:00Z");
      d.setUTCMonth(d.getUTCMonth() + 2, 1);
      const horizon = d.toISOString().slice(0, 7);
      for (const p of all("plans")) {
        if (!p.active || !get("clients", p.clientId)?.active) continue;
        let month = p.start.slice(0, 7);
        while (month <= p.end.slice(0, 7) && month <= horizon) {
          const due = dueDate(month, p.day);
          if (due >= p.start && due <= p.end && !invoices().some(i => i.planId === p.id && i.reference === month)) {
            const id = crypto.randomUUID();
            const data = {
              id,
              planId: p.id,
              clientId: p.clientId,
              name: p.name,
              number:
                "ZH-" +
                month.replace("-", "") +
                "-" +
                id.slice(0, 6).toUpperCase(),
              reference: month,
              amount: p.amount,
              due,
              status: "pending",
              paymentUrl: "",
              created: new Date().toISOString(),
            };
            count += Number(
              db
                .prepare("INSERT OR IGNORE INTO invoices VALUES(?,?,?,?)")
                .run(id, p.id, month, JSON.stringify(data)).changes,
            );
          }
          const [y, m] = month.split("-").map(Number);
          month = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 7);
        }
      }
      applyCredits();
      return count;
    },
  };
}
