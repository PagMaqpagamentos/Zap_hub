import { DatabaseSync } from "node:sqlite";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { defaultRules, dueDate } from "./domain.js";
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
 CREATE TABLE IF NOT EXISTS deliveries(id TEXT PRIMARY KEY,invoice_id TEXT NOT NULL,rule_id TEXT NOT NULL,mode TEXT NOT NULL,status TEXT NOT NULL,data TEXT NOT NULL,UNIQUE(invoice_id,rule_id,mode));
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
  if (!get("settings", "main"))
    put("settings", "main", {
      mode: "simulation",
      auto: false,
      sendHour: 9,
      uazapiUrl: "",
      uazapiToken: "",
      handle: "",
      publicUrl: "",
    });
  if (!get("meta", "rulesSeeded")) {
    for (const r of defaultRules) put("rules", r.id, r);
    put("meta", "rulesSeeded", { done: true });
  }
  db.prepare(
    "UPDATE deliveries SET status='uncertain' WHERE status='sending'",
  ).run();
  db.prepare(
    "UPDATE deliveries SET status='failed' WHERE status='preparing'",
  ).run();
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
          if (due >= p.start && due <= p.end) {
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
      return count;
    },
  };
}
