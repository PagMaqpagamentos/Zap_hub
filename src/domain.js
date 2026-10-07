import { z } from "zod";
export const today = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
export const hour = () =>
  Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "America/Sao_Paulo",
      hour: "2-digit",
      hourCycle: "h23",
    }).format(new Date()),
  );
export const money = (n) =>
  (n / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
export const brDate = (s) => s?.split("-").reverse().join("/") || "";
export function addDays(s, n) {
  const d = new Date(s + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export function dueDate(month, day) {
  const [y, m] = month.split("-").map(Number);
  return `${month}-${String(Math.min(day, new Date(Date.UTC(y, m, 0)).getUTCDate())).padStart(2, "0")}`;
}
export function validCPF(s) {
  if (!/^\d{11}$/.test(s) || /^(\d)\1+$/.test(s)) return false;
  for (let n = 9; n < 11; n++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += Number(s[i]) * (n + 1 - i);
    let digit = (sum * 10) % 11;
    if (digit === 10) digit = 0;
    if (digit !== Number(s[n])) return false;
  }
  return true;
}
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (s) =>
      !Number.isNaN(Date.parse(s)) &&
      new Date(s + "T12:00:00Z").toISOString().slice(0, 10) === s,
    "Data inválida",
  );
const text = z.string().trim().min(1).max(150);
export const clientSchema = z.object({
  name: text,
  company: text,
  phone: z
    .string()
    .transform((s) => s.replace(/\D/g, ""))
    .refine(
      (s) => /^55\d{10,11}$/.test(s),
      "Use WhatsApp com 55 + DDD + número",
    ),
  cpf: z
    .string()
    .transform((s) => s.replace(/\D/g, ""))
    .refine(validCPF, "CPF inválido"),
  active: z.boolean().default(true),
});
export const planSchema = z
  .object({
    clientId: z.string().uuid(),
    name: text,
    amount: z.number().int().min(1).max(100000000),
    day: z.number().int().min(1).max(31),
    start: date,
    end: date,
    active: z.boolean().default(true),
  })
  .refine(
    (p) => p.end >= p.start,
    "Término deve ser igual ou posterior ao início",
  )
  .refine(
    (p) => Number(p.end.slice(0, 4)) - Number(p.start.slice(0, 4)) <= 30,
    "Período máximo: 30 anos",
  );
export const FIELDS = [
  "nome_cliente",
  "empresa",
  "whatsapp",
  "cpf",
  "nome_fatura",
  "numero_fatura",
  "valor",
  "referencia",
  "vencimento",
  "link_pagamento",
  "inicio_cobranca",
  "termino_cobranca",
  "dias_atraso",
];
export const ruleSchema = z.object({
  name: text,
  offset: z.number().int().min(-60).max(90),
  template: z
    .string()
    .trim()
    .min(1)
    .max(4000)
    .refine(
      (s) =>
        [...s.matchAll(/{{\s*(\w+)\s*}}/g)].every((m) => FIELDS.includes(m[1])),
      "Há campos desconhecidos na mensagem",
    ),
  active: z.boolean().default(true),
});
export function render(template, invoice, client, plan = {}, now = today()) {
  const values = {
    nome_cliente: client.name,
    empresa: client.company,
    whatsapp: client.phone,
    cpf: client.cpf,
    nome_fatura: invoice.name,
    numero_fatura: invoice.number,
    valor: money(invoice.amount),
    referencia: invoice.reference.split("-").reverse().join("/"),
    vencimento: brDate(invoice.due),
    link_pagamento:
      invoice.paymentUrl || "[link Pix será gerado antes do envio]",
    inicio_cobranca: brDate(plan.start),
    termino_cobranca: brDate(plan.end),
    dias_atraso: String(
      Math.max(
        0,
        Math.round((Date.parse(now) - Date.parse(invoice.due)) / 86400000),
      ),
    ),
  };
  return template.replace(/{{\s*(\w+)\s*}}/g, (_, k) => values[k] ?? "");
}
export const defaultRules = [
  {
    id: "disponivel",
    name: "Fatura disponível",
    offset: -5,
    active: true,
    template:
      "Olá, {{nome_cliente}}! A fatura {{numero_fatura}} — {{nome_fatura}}, referente a {{referencia}}, da empresa {{empresa}}, já está disponível.\nValor: {{valor}}\nVencimento: {{vencimento}}\nPague por Pix neste link: {{link_pagamento}}",
  },
  {
    id: "vencimento",
    name: "Lembrete no vencimento",
    offset: 0,
    active: true,
    template:
      "Olá, {{nome_cliente}}! Sua fatura {{nome_fatura}}, referente a {{referencia}}, vence hoje, {{vencimento}}. Valor: {{valor}}.\nPagamento por Pix: {{link_pagamento}}",
  },
  {
    id: "bloqueio",
    name: "Aviso de bloqueio",
    offset: 5,
    active: true,
    template:
      "Olá, {{nome_cliente}}. Ainda não identificamos o pagamento da fatura {{numero_fatura}} da empresa {{empresa}}, referente a {{referencia}}, com vencimento em {{vencimento}}. Para evitar o bloqueio do serviço, regularize o valor de {{valor}} por Pix: {{link_pagamento}}. Se já pagou, entre em contato conosco.",
  },
];
