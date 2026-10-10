import express from "express";
import { normalizeBillingImage } from "./billing-image.js";
import { z } from "zod";
import {
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
  createHash,
} from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createStore } from "./store.js";
import { createBilling, request } from "./billing.js";
import {
  clientSchema,
  normalizePhone,
  validPhone,
  planSchema,
  ruleSchema,
  FIELDS,
  today,
  render,
  sendTimesSchema,
  ruleKind,
  invoiceEditSchema,
} from "./domain.js";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export function createApp(
  dir = process.env.DATA_DIR || resolve(root, "data"),
  http = request,
  setupSecret = process.env.SETUP_TOKEN || "",
) {
  const app = express(),
    store = createStore(dir),
    billing = createBilling(store, http),
    sessions = new Map(),
    attempts = new Map();
  app.disable("x-powered-by");
  app.get("/p/:id", (req, res) => {
    res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow" });
    if (!/^[a-f0-9]{32}$/.test(req.params.id)) return res.sendStatus(404);
    const entry = store.get("paymentLinks", req.params.id);
    if (!entry) return res.sendStatus(404);
    const url = new URL(entry.url);
    if (url.protocol !== "https:") return res.sendStatus(400);
    res.redirect(302, url.href);
  });
  app.get("/healthz", (req, res) => {
    store.db.prepare("SELECT 1").get();
    res.json({ status: "ok" });
  });
  app.use(express.json({ limit: "3mb" }));
  app.use((req, res, next) => {
    res.set({
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy":
        "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    });
    next();
  });
  app.use("/api", (req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (req.method !== "GET" && req.get("origin")) {
      try {
        if (new URL(req.get("origin")).host !== req.get("host"))
          return res.status(403).json({ error: "Origem inválida" });
      } catch {
        return res.sendStatus(403);
      }
    }
    next();
  });
  const token = (req) =>
    (req.headers.cookie || "")
      .split(";")
      .map((v) => v.trim())
      .find((v) => v.startsWith("zap_session="))
      ?.slice(12);
  const authenticated = (req) => {
    const t = token(req),
      session = sessions.get(t);
    if (!session || session < Date.now()) {
      sessions.delete(t);
      return false;
    }
    return true;
  };
  app.get("/api/auth", (req, res) =>
    res.json({
      setup: !store.get("auth", "admin"),
      setupTokenRequired: !store.get("auth", "admin") && !!setupSecret,
      authenticated: authenticated(req),
    }),
  );
  app.post("/api/auth", (req, res) => {
    const ip = req.ip,
      entry = attempts.get(ip) || { n: 0, until: Date.now() + 900000 };
    if (entry.until < Date.now()) {
      entry.n = 0;
      entry.until = Date.now() + 900000;
    }
    entry.n++;
    attempts.set(ip, entry);
    if (entry.n > 10)
      return res
        .status(429)
        .json({ error: "Muitas tentativas. Aguarde 15 minutos." });
    const { password, setupToken } = z
      .object({
        password: z.string().min(10, "Use pelo menos 10 caracteres").max(200),
        setupToken: z.string().max(200).optional(),
      })
      .parse(req.body);
    let admin = store.get("auth", "admin");
    if (!admin) {
      if (
        setupSecret &&
        !timingSafeEqual(
          createHash("sha256").update(setupSecret).digest(),
          createHash("sha256")
            .update(setupToken || "")
            .digest(),
        )
      )
        return res
          .status(403)
          .json({ error: "Código de configuração inválido" });
      if (
        !setupSecret &&
        (process.env.NODE_ENV === "production" ||
          !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.ip))
      )
        return res.status(403).json({
          error:
            "Configure SETUP_TOKEN no servidor para liberar o primeiro acesso",
        });
      const salt = randomBytes(16).toString("hex");
      admin = { salt, hash: scryptSync(password, salt, 64).toString("hex") };
      store.put("auth", "admin", admin);
    }
    if (
      !timingSafeEqual(
        scryptSync(password, admin.salt, 64),
        Buffer.from(admin.hash, "hex"),
      )
    )
      return res.status(401).json({ error: "Senha incorreta" });
    attempts.delete(ip);
    for (const [key, value] of sessions)
      if (value < Date.now()) sessions.delete(key);
    const id = randomBytes(32).toString("hex");
    sessions.set(id, Date.now() + 43200000);
    res.set(
      "Set-Cookie",
      `zap_session=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${process.env.COOKIE_SECURE === "true" ? "; Secure" : ""}`,
    );
    res.json({ ok: true });
  });
  app.use("/api", (req, res, next) =>
    authenticated(req)
      ? next()
      : res.status(401).json({ error: "Entre para continuar" }),
  );
  app.post("/api/logout", (req, res) => {
    sessions.delete(token(req));
    res.set(
      "Set-Cookie",
      "zap_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
    );
    res.json({ ok: true });
  });
  const safeSettings = () => {
    const s = store.settings();
    return { ...s, uazapiToken: undefined, tokenConfigured: !!s.uazapiToken };
  };
  app.get("/api/state", (req, res) =>
    res.json({
      today: today(),
      clients: store.all("clients"),
      plans: store.all("plans"),
      rules: store.all("rules").sort((a, b) => a.offset - b.offset),
      invoices: store.invoices(),
      payments: store.all("payments"),
      integrationTests: store.all("integrationTests").sort((a,b) => b.created.localeCompare(a.created)).slice(0,30),
      deliveries: store.deliveries(),
      logs: store.logs(),
      settings: safeSettings(),
      fields: FIELDS,
    }),
  );
  function validateRule(data, id) {
    if (
      data.active &&
      store
        .all("rules")
        .some(
          (r) =>
            r.id !== id &&
            r.active &&
            ruleKind(r) === data.kind &&
            (data.kind !== "custom" || r.offset === data.offset),
        )
    )
      throw new Error(
        "Já existe um lembrete ativo nesta etapa (ou neste dia personalizado). Edite ou pause o anterior.",
      );
  }
  for (const [kind, schema] of [
    ["clients", clientSchema],
    ["plans", planSchema],
    ["rules", ruleSchema],
  ]) {
    app.post("/api/" + kind, (req, res) => {
      const parsed = schema.parse(req.body);
      const id = req.body.id
        ? z.string().uuid().parse(req.body.id)
        : randomUUID();
      if (req.body.id && !store.get(kind, id))
        return res.status(404).json({ error: "Registro não encontrado" });
      if (["clients", "plans"].includes(kind) && store.get(kind, id)?.deletedAt)
        return res.status(409).json({ error: "Registro excluído não pode ser reativado" });
      if (kind === "plans" && (!store.get("clients", parsed.clientId) || store.get("clients", parsed.clientId).deletedAt))
        return res.status(400).json({ error: "Cliente não encontrado" });
      if (
        kind === "clients" &&
        store.all("clients").some((c) => !c.deletedAt && c.id !== id && c.cpf === parsed.cpf)
      )
        return res
          .status(409)
          .json({ error: "Já existe um cliente com esse CPF" });
      if (kind === "rules") validateRule(parsed, id);
      const data = { ...parsed, id };
      store.put(kind, id, data);
      store.generate(today());
      res.json(data);
    });
  }
  // Os modelos iniciais possuem identificadores legíveis e podem ser editados.
  app.put("/api/rules/:id", (req, res) => {
    if (!store.get("rules", req.params.id)) return res.sendStatus(404);
    const data = { ...ruleSchema.parse(req.body), id: req.params.id };
    validateRule(data, data.id);
    store.put("rules", data.id, data);
    res.json(data);
  });
  const httpsUrl = z
    .string()
    .trim()
    .refine((s) => {
      if (!s) return true;
      try {
        const u = new URL(s);
        return (
          u.protocol === "https:" &&
          !u.username &&
          !u.password &&
          !u.search &&
          !u.hash &&
          u.pathname === "/"
        );
      } catch {
        return false;
      }
    }, "Use uma URL HTTPS sem caminho, usuário ou parâmetros")
    .transform((s) => s.replace(/\/$/, ""));
  app.put("/api/settings", async (req, res) => {
    const data = z
      .object({
        mode: z.enum(["simulation", "live"]),
        auto: z.boolean(),
        sendTimes: sendTimesSchema.optional(),
        uazapiUrl: httpsUrl,
        uazapiToken: z.string().max(2000).optional(),
        handle: z
          .string()
          .trim()
          .max(100)
          .regex(/^[\w.-]*$/, "InfiniteTag inválida (sem $)"),
        publicUrl: httpsUrl,
        paymentPresentation: z.enum(["button", "link"]).optional(),
        billingImage: z.string().max(2800000).refine(value => {
          if (!value) return true;
          const match = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
          if (!match) return false;
          const bytes = Buffer.from(match[2], "base64");
          return bytes.length <= 2 * 1024 * 1024 && (match[1] === "png"
            ? bytes.subarray(0,8).toString("hex") === "89504e470d0a1a0a"
            : bytes.subarray(0,3).toString("hex") === "ffd8ff");
        }, "Envie uma imagem PNG ou JPEG de até 2 MB").optional(),
      })
      .parse(req.body);
    if (data.billingImage !== undefined || store.settings().billingImage) data.billingImage = await normalizeBillingImage(data.billingImage ?? store.settings().billingImage);
    const current = store.settings();
    const updated = {
      ...current,
      ...data,
      sendTimes: data.sendTimes || current.sendTimes,
      uazapiToken: data.uazapiToken
        ? store.seal(data.uazapiToken)
        : current.uazapiToken,
    };
    if (
      updated.mode === "live" &&
      (!updated.uazapiUrl ||
        !updated.uazapiToken ||
        !updated.handle ||
        !updated.publicUrl)
    )
      return res
        .status(400)
        .json({ error: "Preencha as integrações antes de ativar o modo real" });
    store.put("settings", "main", updated);
    store.event(
      "configuração",
      `Configurações salvas. Modo: ${updated.mode}; automação: ${updated.auto ? "ativa" : "pausada"}`,
    );
    res.json(safeSettings());
  });
  app.put("/api/schedule", (req, res) => {
    const { sendTimes } = z
      .object({ sendTimes: sendTimesSchema })
      .parse(req.body);
    store.put("settings", "main", { ...store.settings(), sendTimes });
    store.event(
      "configuração",
      `Frequência diária: ${sendTimes.length} envio(s), às ${sendTimes.join(", ")} (Brasília)`,
    );
    res.json({ sendTimes });
  });
  app.post("/api/uazapi/status", async (req, res) => {
    const s = store.settings();
    if (!s.uazapiUrl || !s.uazapiToken)
      throw new Error("Configure a Uazapi primeiro");
    const result = await http(s.uazapiUrl + "/instance/status", null, {
      token: store.unseal(s.uazapiToken),
    });
    res.json({
      status: result.status || result.instance?.status || "Resposta recebida",
      connected:
        result.connected ??
        result.status?.connected ??
        result.instance?.status === "connected",
    });
  });
  app.post("/api/invoices/:id/send-whatsapp", async (req, res) => {
    const input = z.object({requestId:z.string().uuid(),revision:z.string().default("")}).parse(req.body);
    res.json(await billing.sendInvoice(req.params.id, input.requestId, input.revision));
  });
  app.post("/api/integration-tests", async (req, res) => {
    const input = z.object({
      id: z.string().uuid(), kind: z.enum(["standalone", "invoice"]),
      name: z.string().trim().min(1).max(150).default("Fatura de teste"),
      amount: z.number().int().min(1).max(100000000).default(100),
      invoiceId: z.string().uuid().optional(),
      sendWhatsapp: z.boolean().default(false),
      phone: z.string().transform(normalizePhone).default(""),
    }).refine(v => v.kind !== "invoice" || !!v.invoiceId, "Selecione uma fatura")
      .refine(v => !v.sendWhatsapp || validPhone(v.phone), "Informe WhatsApp com código do país, DDD e número").parse(req.body);
    res.json(await billing.integrationTest(input));
  });
  app.post("/api/generate", (req, res) =>
    res.json({ generated: store.generate(today()) }),
  );
  app.post("/api/run", async (req, res) =>
    res.json(await billing.run({ force: true })),
  );
  app.post("/api/clients/import", (req, res) => {
    const rows = z.array(z.unknown()).min(1).max(1000).parse(req.body.rows);
    const result = { imported: 0, duplicates: 0, errors: [] };
    store.db.exec("BEGIN IMMEDIATE");
    try {
      for (const [index, row] of rows.entries()) {
        const parsed = clientSchema.safeParse(row);
        if (!parsed.success) {
          result.errors.push({ row: index + 2, name: String(row?.name || ""), error: parsed.error.issues.map(i => i.message).join("; ") });
          continue;
        }
        const c = parsed.data;
        if (store.all("clients").some(existing => !existing.deletedAt && (existing.cpf === c.cpf || (c.phone && existing.phone === c.phone)))) {
          result.duplicates++;
          continue;
        }
        const id = randomUUID();
        store.put("clients", id, { ...c, id });
        result.imported++;
      }
      store.event("importacao", `${result.imported} clientes importados; ${result.duplicates} duplicados; ${result.errors.length} pendências.`);
      store.db.exec("COMMIT");
      res.json(result);
    } catch (e) { store.db.exec("ROLLBACK"); throw e; }
  });
  app.delete("/api/plans/:id", (req, res) => {
    const result = store.deletePlan(req.params.id, today());
    if (!result) return res.status(404).json({ error: "Cobrança não encontrada" });
    res.json(result);
  });
  app.delete("/api/clients/:id", (req, res) => {
    const result = store.deleteClient(req.params.id, today());
    if (!result) return res.status(404).json({ error: "Cliente não encontrado" });
    res.json(result);
  });
  app.get("/api/preview/:id", (req, res) => {
    const i = store.invoice(req.params.id);
    if (!i) return res.sendStatus(404);
    const c = store.get("clients", i.clientId),
      p = store.get("plans", i.planId);
    res.json(
      store
        .all("rules")
        .map((r) => ({
          name: r.name,
          text: render(
            r.template,
            i,
            c,
            p,
            today(),
            store.all("rules").find((r) => ruleKind(r) === "overdue")?.offset ??
              5,
          ),
        })),
    );
  });
  app.put("/api/invoices/:id", (req, res) => {
    const data = invoiceEditSchema.parse(req.body);
    const i = store.invoice(req.params.id);
    if (!i) return res.sendStatus(404);
    if (data.revision !== (i.revision || i.updatedAt || i.created || ""))
      return res.status(409).json({ error: "A fatura foi alterada ou recebeu um pagamento. Atualize a página antes de editar." });
    const c = store.get("clients", data.clientId), p = store.get("plans", data.planId);
    if (!c || c.deletedAt || !p || p.clientId !== c.id)
      return res.status(400).json({ error: "Selecione uma cobrança do cliente informado" });
    const received = i.paidAmount ?? (i.status === "paid" ? i.amount : 0);
    if (data.amount < received)
      return res.status(400).json({ error: "O valor não pode ser menor que o já recebido. Concilie o recebimento antes de reduzir." });
    if (received > 0 && (data.clientId !== i.clientId || data.planId !== i.planId))
      return res.status(400).json({ error: "Fatura com recebimentos não pode ser transferida para outro cliente ou cobrança." });
    if (data.status === "pending" && received >= data.amount)
      return res.status(400).json({ error: "A fatura já está integralmente quitada." });
    if (data.status === "cancelled" && received > 0)
      return res.status(400).json({ error: "Fatura com recebimento exige conciliação antes de cancelar." });
    if (data.status !== i.status && data.note.length < 5)
      return res.status(400).json({ error: "Informe uma justificativa para alterar o status." });
    if (store.invoices().some(other => other.id !== i.id && other.number === data.number))
      return res.status(409).json({ error: "Já existe uma fatura com este número." });
    if (store.invoices().some(other => other.id !== i.id && other.planId === data.planId && other.reference === data.reference))
      return res.status(409).json({ error: "Já existe uma fatura dessa cobrança para a referência informada." });
    const { revision, ...fields } = data;
    const updated = { ...i, ...fields, paidAmount: data.status === "paid" ? data.amount : received,
      revision: randomUUID(), updatedAt: new Date().toISOString() };
    if (updated.status === "paid") { updated.paidAt = data.paidAt === i.paidAt?.slice(0,10) ? i.paidAt : data.paidAt || today(); if (i.status !== "paid") updated.method = "manual"; }
    else updated.paidAt = "";
    if (["amount", "clientId", "planId", "name", "reference", "due", "number", "status"].some(key => i[key] !== updated[key])) {
      updated.paymentUrl = ""; updated.checkoutId = "";
    }
    store.put("invoiceRevisions", updated.revision, { before: i, after: updated });
    store.saveInvoice(updated);
    store.event("edicao", `Fatura ${i.number} editada. Campos: ${Object.keys(fields).filter(key => i[key] !== fields[key]).join(", ")}. ${data.note}`);
    store.applyCredits();
    res.json(store.invoice(i.id));
  });
  app.post("/api/invoices/:id/link", async (req, res) => {
    if (store.settings().mode !== "live")
      return res.status(400).json({
        error: "Ative o modo real nas integrações para gerar um checkout",
      });
    res.json({ url: await billing.link(req.params.id) });
  });
  app.post("/api/invoices/:id/status", (req, res) => {
    const { status, note } = z
      .object({
        status: z.enum(["paid", "cancelled"]),
        note: z
          .string()
          .trim()
          .min(5, "Informe uma justificativa de pelo menos 5 caracteres")
          .max(300),
      })
      .parse(req.body);
    const i = store.invoice(req.params.id);
    if (!i) return res.sendStatus(404);
    if (i.status !== "pending")
      return res.status(409).json({ error: "Esta fatura já foi finalizada" });
    if (status === "cancelled" && i.paidAmount > 0)
      return res.status(409).json({ error: "Fatura com recebimento exige conciliação antes de cancelar." });
    i.status = status;
    i.note = note;
    if (status === "paid") {
      i.paidAmount = i.amount;
      i.paidAt = new Date().toISOString();
      i.method = "manual";
    }
    i.revision = randomUUID();
    store.saveInvoice(i);
    store.event(
      "baixa",
      `${i.number}: ${status === "paid" ? "baixa manual" : "cancelamento"} — ${note}`,
    );
    res.json(i);
  });
  app.post("/api/deliveries/:id/retry", (req, res) => {
    const d = store.db
      .prepare("SELECT * FROM deliveries WHERE id=?")
      .get(req.params.id);
    if (!d || !["failed", "uncertain"].includes(d.status))
      return res.status(400).json({
        error: "Somente falhas podem ser liberadas para nova tentativa",
      });
    store.db.prepare("DELETE FROM deliveries WHERE id=?").run(d.id);
    store.event(
      "reenvio",
      `Nova tentativa liberada para fatura ${d.invoice_id}. Histórico anterior: ${d.status}`,
    );
    res.json({ ok: true });
  });
  const webhookSchema = z
    .object({
      order_nsu: z.string().uuid(),
      transaction_nsu: z.string().min(1).max(150),
      invoice_slug: z.string().max(150).optional(),
      slug: z.string().max(150).optional(),
    })
    .refine((v) => v.invoice_slug || v.slug);
  const queue = (payload) => {
    const p = webhookSchema.parse(payload);
    if (!store.get("checkouts", p.order_nsu) && !store.invoice(p.order_nsu)) throw new Error("Pedido não encontrado");
    const id = p.order_nsu + ":" + p.transaction_nsu;
    const old = store.get("webhooks", id);
    if (!old)
      store.put("webhooks", id, {
        id,
        payload: p,
        attempts: 0,
        done: false,
        next: 0,
      });
  };
  app.post("/webhooks/infinitepay", (req, res) => {
    queue(req.body);
    res.json({ success: true, message: null });
  });
  app.get("/pagamento", (req, res) => {
    try {
      queue(req.query);
      res
        .type("html")
        .send(
          '<html lang="pt-BR"><meta charset="UTF-8"><meta name="viewport" content="width=device-width"><title>Zap Hub • Pagamento</title><body><h1>Obrigado!</h1><p>Recebemos o retorno do checkout. O pagamento será conferido junto à InfinitePay. Após a confirmação, os lembretes serão interrompidos.</p></body></html>',
        );
    } catch {
      res
        .status(400)
        .type("text")
        .send(
          "Não foi possível identificar a transação. Entre em contato com o responsável pela cobrança.",
        );
    }
  });
  let checking = false;
  async function processWebhooks() {
    if (checking) return;
    checking = true;
    try {
      for (const job of store
        .all("webhooks")
        .filter((j) => !j.done && j.next < Date.now() && j.attempts < 20)
        .slice(0, 20)) {
        try {
          await billing.confirm(job.payload);
          job.done = true;
        } catch (e) {
          job.attempts++;
          job.error = e.message;
          job.next = Date.now() + 60000 * Math.min(job.attempts, 30);
          if (job.attempts === 20)
            store.event(
              "erro",
              `Confirmação pendente para ${job.payload.order_nsu}: ${e.message}`,
            );
        }
        store.put("webhooks", job.id, job);
      }
    } finally {
      checking = false;
    }
  }
  app.use(express.static(resolve(root, "public"), { maxAge: 0, setHeaders: res => res.setHeader("Cache-Control", "no-store") }));
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const message =
      err instanceof z.ZodError
        ? err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
        : err.message;
    res
      .status(err instanceof z.ZodError ? 400 : 400)
      .json({ error: message || "Não foi possível concluir a operação" });
  });
  return { app, store, billing, processWebhooks };
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const { app, store, billing, processWebhooks } = createApp();
  app.listen(
    Number(process.env.PORT || 3090),
    process.env.HOST || "127.0.0.1",
    () =>
      console.log(
        `Zap Hub disponível em http://${process.env.HOST || "127.0.0.1"}:${process.env.PORT || 3090}`,
      ),
  );
  const tick = async () => {
    try {
      await processWebhooks();
      await billing.run();
    } catch (e) {
      store.event("erro", e.message);
    }
  };
  tick();
  setInterval(tick, 60000);
}
