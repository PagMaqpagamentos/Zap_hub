import express from "express";
import { z } from "zod";
import {
  randomBytes,
  randomUUID,
  createHash,
  generateKeyPairSync,
  sign,
} from "node:crypto";
import { today, addDays, balance, ruleKind } from "./domain.js";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const iso = () => new Date().toISOString();
export function createHubs(store, billing) {
  let keys = store.get("hubKeys", "main");
  if (!keys) {
    const pair = generateKeyPairSync("ed25519");
    keys = {
      publicKey: pair.publicKey.export({ type: "spki", format: "pem" }),
      privateKey: store.seal(
        pair.privateKey.export({ type: "pkcs8", format: "pem" }),
      ),
    };
    store.put("hubKeys", "main", keys);
  }
  const signed = (payload) => {
    const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
    return (
      encoded +
      "." +
      sign(null, Buffer.from(encoded), store.unseal(keys.privateKey)).toString(
        "base64url",
      )
    );
  };
  const log = (hubId, action, detail = "") => {
    const id = randomUUID();
    store.put("hubEvents", id, { id, hubId, action, detail, created: iso() });
  };
  function situation(hub, now = today()) {
    const plan = store.get("plans", hub.planId),
      customer = plan && store.get("clients", plan.clientId);
    const unavailable =
      hub.revoked || !plan || plan.deletedAt || !customer || customer.deletedAt;
    const invoice = store
      .invoices()
      .filter(
        (i) =>
          i.planId === hub.planId && i.status === "pending" && balance(i) > 0,
      )
      .sort(
        (a, b) => a.due.localeCompare(b.due) || a.id.localeCompare(b.id),
      )[0];
    const rules = store.all("rules");
    const before = Math.abs(
      rules.find((r) => ruleKind(r) === "available")?.offset ?? -5,
    );
    const after = Math.max(
      0,
      rules.find((r) => ruleKind(r) === "overdue")?.offset ?? 5,
    );
    const blockDate = invoice ? addDays(invoice.due, after) : null;
    let status = !invoice
      ? "ok"
      : now >= blockDate
        ? "blocked"
        : now > invoice.due
          ? "overdue"
          : now >= addDays(invoice.due, -before)
            ? "available"
            : "ok";
    const trust = store.get("hubTrust", hub.planId);
    const trusted = trust?.until > iso();
    if (trusted || hub.policy === "released") status = "released";
    if (hub.policy === "blocked" || unavailable) status = "blocked";
    return {
      status,
      forced: !!unavailable || hub.policy === "blocked",
      revoked: !!hub.revoked,
      hubId: hub.id,
      name: hub.name,
      customer: customer?.name || "",
      company: customer?.company || "",
      planName: plan?.name || "",
      invoice: invoice
        ? {
            id: invoice.id,
            number: invoice.number,
            name: invoice.name,
            due: invoice.due,
            reference: invoice.reference,
            balance: balance(invoice),
            revision: invoice.revision || "",
          }
        : null,
      availableDate: invoice ? addDays(invoice.due, -before) : null,
      blockDate,
      trustUntil: trusted ? trust.until : null,
      trustUsed: trust?.count || 0,
      trustLimit: hub.trustLimit,
      policy: hub.policy,
      serverTime: iso(),
      expiresAt: new Date(
        Date.now() + hub.offlineHours * 3600000,
      ).toISOString(),
      logo: store.settings().billingImage || "",
    };
  }
  const publicHub = (h) => ({
    id: h.id,
    name: h.name,
    planId: h.planId,
    clientId: store.get("plans", h.planId)?.clientId,
    machine: h.machine || "",
    version: h.version || "",
    lastSeen: h.lastSeen || null,
    created: h.created,
    paired: !!h.tokenHash,
    online: !!h.lastSeen && Date.now() - Date.parse(h.lastSeen) < 180000,
    revoked: !!h.revoked,
    policy: h.policy,
    trustLimit: h.trustLimit,
    offlineHours: h.offlineHours,
    trust: store.get("hubTrust", h.planId) || { count: 0 },
    status: situation(h).status,
  });
  const device = express.Router(),
    admin = express.Router();
  const limits = new Map();
  function rate(key, max, windowMs) {
    if (limits.size > 10000)
      for (const [k, v] of limits) if (v.until < Date.now()) limits.delete(k);
    let entry = limits.get(key);
    if (!entry || entry.until < Date.now())
      entry = { n: 0, until: Date.now() + windowMs };
    entry.n++;
    limits.set(key, entry);
    return entry.n <= max;
  }
  device.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  device.post("/pair", (req, res) => {
    if (!rate("pair:" + req.ip, 20, 900000))
      return res
        .status(429)
        .json({ error: "Aguarde antes de tentar novamente" });
    const input = z
      .object({
        code: z.string().min(10).max(100),
        machine: z.string().min(1).max(120),
        installationId: z.string().uuid(),
      })
      .parse(req.body);
    const hub = store
      .all("hubs")
      .find(
        (h) =>
          h.pairHash === hash(input.code.trim()) &&
          h.pairExpires > iso() &&
          !h.revoked,
      );
    if (!hub)
      return res
        .status(400)
        .json({ error: "Código de pareamento inválido ou expirado" });
    const token = randomBytes(32).toString("hex");
    store.put("hubs", hub.id, {
      ...hub,
      tokenHash: hash(token),
      installationId: input.installationId,
      machine: input.machine,
      pairHash: null,
      pairExpires: null,
      lastSeen: iso(),
    });
    log(hub.id, "pareamento", input.machine);
    res.json({ hubId: hub.id, token, publicKey: keys.publicKey });
  });
  device.use((req, res, next) => {
    const token = (req.get("authorization") || "").replace(/^Bearer /, "");
    if (!/^[a-f0-9]{64}$/.test(token))
      return res.status(401).json({ error: "Hub não autenticado" });
    const hub = store.all("hubs").find((h) => h.tokenHash === hash(token));
    if (!hub || req.get("x-installation-id") !== hub.installationId)
      return res.status(401).json({ error: "Pareamento inválido" });
    if (!rate("device:" + hub.id, 60, 60000))
      return res
        .status(429)
        .json({ error: "Muitas consultas. Aguarde um minuto." });
    req.hub = hub;
    next();
  });
  device.post("/status", (req, res) => {
    const input = z
      .object({
        version: z.string().max(40).default(""),
        event: z.string().max(120).optional(),
      })
      .parse(req.body);
    const h = { ...req.hub, lastSeen: iso(), version: input.version };
    store.put("hubs", h.id, h);
    if (input.event && rate("event:" + h.id, 10, 60000))
      log(h.id, "cliente", input.event);
    res.json({ lease: signed(situation(h)) });
  });
  device.post("/trust", (req, res) => {
    const h = req.hub,
      state = situation(h);
    if (state.forced || state.revoked)
      return res
        .status(403)
        .json({ error: "Liberação disponível somente pelo administrador" });
    const current = store.get("hubTrust", h.planId) || { count: 0 };
    if (current.until > iso()) return res.json({ lease: signed(situation(h)) });
    if (state.status !== "blocked")
      return res.status(400).json({ error: "A cobrança não está bloqueada" });
    if (current.count >= h.trustLimit)
      return res
        .status(403)
        .json({ error: "Limite de liberações atingido. Contate a Paratech." });
    const until = new Date(Date.now() + 86400000).toISOString();
    store.put("hubTrust", h.planId, {
      count: current.count + 1,
      until,
      lastHubId: h.id,
    });
    log(h.id, "confiança", `24 horas, até ${until}; uso ${current.count + 1}`);
    res.json({ lease: signed(situation(h)) });
  });
  device.post("/payment", async (req, res) => {
    if (req.hub.revoked) return res.sendStatus(403);
    const invoice = situation(req.hub).invoice;
    if (!invoice)
      return res.status(400).json({ error: "Sem fatura em aberto" });
    res.json({ url: await billing.link(invoice.id) });
  });
  device.post("/whatsapp", async (req, res) => {
    if (req.hub.revoked) return res.sendStatus(403);
    const { requestId } = z
      .object({ requestId: z.string().uuid() })
      .parse(req.body);
    const invoice = situation(req.hub).invoice;
    if (!invoice)
      return res.status(400).json({ error: "Sem fatura em aberto" });
    const prior = store.get("manualSends", requestId);
    if (!prior && !rate("wa:" + req.hub.id, 3, 3600000))
      return res
        .status(429)
        .json({ error: "Limite de três solicitações por hora" });
    const result = await billing.sendInvoice(
      invoice.id,
      requestId,
      invoice.revision,
    );
    log(req.hub.id, "WhatsApp", result.status);
    res.json({ status: result.status, error: result.error });
  });
  admin.get("/", (req, res) =>
    res.json({
      hubs: store.all("hubs").map(publicHub),
      events: store
        .all("hubEvents")
        .sort((a, b) => b.created.localeCompare(a.created))
        .slice(0, 200),
    }),
  );
  admin.post("/", (req, res) => {
    const data = z
      .object({
        name: z.string().trim().min(1).max(120),
        planId: z.string().uuid(),
        trustLimit: z.number().int().min(0).max(20).default(1),
        offlineHours: z.number().int().min(1).max(72).default(24),
      })
      .parse(req.body);
    const plan = store.get("plans", data.planId);
    if (!plan || plan.deletedAt) throw new Error("Cobrança não encontrada");
    const code = randomBytes(12).toString("hex"),
      id = randomUUID();
    store.put("hubs", id, {
      ...data,
      id,
      created: iso(),
      policy: "auto",
      pairHash: hash(code),
      pairExpires: new Date(Date.now() + 900000).toISOString(),
    });
    log(id, "criado", data.name);
    res.json({ id, code });
  });
  admin.put("/:id", (req, res) => {
    const h = store.get("hubs", req.params.id);
    if (!h) return res.sendStatus(404);
    const data = z
      .object({
        policy: z.enum(["auto", "blocked", "released"]),
        trustLimit: z.number().int().min(0).max(20),
        offlineHours: z.number().int().min(1).max(72),
      })
      .parse(req.body);
    store.put("hubs", h.id, { ...h, ...data });
    log(h.id, "configuração", JSON.stringify(data));
    res.json({ ok: true });
  });
  admin.post("/:id/revoke", (req, res) => {
    const h = store.get("hubs", req.params.id);
    if (!h) return res.sendStatus(404);
    store.put("hubs", h.id, { ...h, revoked: true, pairHash: null });
    log(h.id, "revogado");
    res.json({ ok: true });
  });
  admin.post("/:id/pair-code", (req, res) => {
    const h = store.get("hubs", req.params.id);
    if (!h || h.revoked) return res.sendStatus(404);
    const code = randomBytes(12).toString("hex");
    store.put("hubs", h.id, {
      ...h,
      pairHash: hash(code),
      pairExpires: new Date(Date.now() + 900000).toISOString(),
    });
    log(h.id, "novo código");
    res.json({ code });
  });
  admin.post("/counter-code", (req, res) => {
    const input = z
      .object({
        challenge: z.string().max(300),
        hours: z.number().int().min(1).max(24).default(24),
      })
      .parse(req.body);
    const [hubId, nonce] = input.challenge.trim().split(":");
    if (!/^[a-f0-9]{32}$/.test(nonce || ""))
      throw new Error("Desafio inválido");
    const h = store.get("hubs", hubId);
    if (!h || h.revoked) throw new Error("Hub não encontrado ou revogado");
    const existing = store.get("hubCounterCodes", hash(input.challenge));
    if (existing) return res.json({ code: existing.code });
    const code = signed({
      type: "offline-release",
      hubId,
      installationId: h.installationId,
      nonce,
      issuedAt: iso(),
      expiresAt: new Date(Date.now() + input.hours * 3600000).toISOString(),
    });
    store.put("hubCounterCodes", hash(input.challenge), { code });
    log(h.id, "contrassenha", `${input.hours} horas`);
    res.json({ code });
  });
  return { device, admin, situation, signed, publicKey: keys.publicKey };
}
