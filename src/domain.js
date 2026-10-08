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
export const time = (instant = new Date()) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: "America/Sao_Paulo",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(instant);
export const sendTimesSchema = z
  .array(z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Horário inválido"))
  .min(1, "Informe pelo menos um horário")
  .max(12, "Configure até 12 envios por dia")
  .refine(
    (times) => new Set(times).size === times.length,
    "Os horários não podem se repetir",
  )
  .transform((times) => [...times].sort());
export const ruleKind = (r) =>
  r.kind ||
  { disponivel: "available", vencimento: "due", bloqueio: "overdue" }[r.id] ||
  "custom";
export const minuteOfDay = (value) => {
  const [h, m] = value.split(":").map(Number);
  return h * 60 + m;
};
export function scheduledSlot(times, currentTime, force = false) {
  const elapsed = [...times].sort().filter((t) => t <= currentTime);
  const slot = elapsed.at(-1) || (force ? [...times].sort()[0] : null);
  // Não acumular envios perdidos. Recuperar somente o horário mais recente, por até 30 min.
  return slot && (force || minuteOfDay(currentTime) - minuteOfDay(slot) <= 30)
    ? slot
    : null;
}
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
export function validCNPJ(s) {
  if (!/^\d{14}$/.test(s) || /^(\d)\1+$/.test(s)) return false;
  for (let n = 12; n < 14; n++) {
    let sum = 0, weight = n - 7;
    for (let i = 0; i < n; i++) {
      sum += Number(s[i]) * weight;
      weight = weight === 2 ? 9 : weight - 1;
    }
    const rest = sum % 11;
    if (Number(s[n]) !== (rest < 2 ? 0 : 11 - rest)) return false;
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
      (s) => s === "" || /^55\d{10,11}$/.test(s),
      "Use WhatsApp com 55 + DDD + número",
    ),
  cpf: z
    .string()
    .transform((s) => s.replace(/\D/g, ""))
    .refine((s) => validCPF(s) || validCNPJ(s), "CPF/CNPJ inválido"),
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
  "data_bloqueio",
  "dias_para_bloqueio",
  "aviso_bloqueio",
];
export const ruleSchema = z
  .object({
    name: text,
    kind: z.enum(["available", "due", "overdue", "custom"]).default("custom"),
    offset: z.number().int().min(-60).max(90),
    template: z
      .string()
      .trim()
      .min(1)
      .max(4000)
      .refine(
        (s) =>
          [...s.matchAll(/{{\s*(\w+)\s*}}/g)].every((m) =>
            FIELDS.includes(m[1]),
          ),
        "Há campos desconhecidos na mensagem",
      ),
    active: z.boolean().default(true),
  })
  .refine(
    (r) => r.kind !== "available" || r.offset < 0,
    "O aviso de disponibilidade deve começar antes do vencimento",
  )
  .refine(
    (r) => r.kind !== "due" || r.offset === 0,
    "O lembrete de vencimento deve usar zero dias",
  )
  .refine(
    (r) => r.kind !== "overdue" || r.offset > 0,
    "O prazo de bloqueio deve ser maior que zero",
  );
export function render(
  template,
  invoice,
  client,
  plan = {},
  now = today(),
  blockDays = 5,
) {
  const blockDate = addDays(invoice.due, blockDays);
  const remaining = Math.max(
    0,
    Math.round((Date.parse(blockDate) - Date.parse(now)) / 86400000),
  );
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
    data_bloqueio: brDate(blockDate),
    dias_para_bloqueio: String(remaining),
    aviso_bloqueio:
      now < blockDate
        ? `Para evitar o bloqueio previsto para ${brDate(blockDate)}, regularize o pagamento. Faltam ${remaining} dias.`
        : now === blockDate
          ? "O prazo para regularizar o pagamento antes do bloqueio termina hoje."
          : `O prazo previsto para bloqueio terminou em ${brDate(blockDate)}. Regularize o pagamento ou entre em contato conosco.`,
  };
  return template.replace(/{{\s*(\w+)\s*}}/g, (_, k) => values[k] ?? "");
}
export const defaultRules = [
  {
    id: "disponivel",
    kind: "available",
    name: "Fatura disponível",
    offset: -5,
    active: true,
    template:
      "Olá, {{nome_cliente}}! A fatura {{numero_fatura}} — {{nome_fatura}}, referente a {{referencia}}, da empresa {{empresa}}, já está disponível.\nValor: {{valor}}\nVencimento: {{vencimento}}\nPague por Pix neste link: {{link_pagamento}}",
  },
  {
    id: "vencimento",
    kind: "due",
    name: "Lembrete no vencimento",
    offset: 0,
    active: true,
    template:
      "Olá, {{nome_cliente}}! Sua fatura {{nome_fatura}}, referente a {{referencia}}, vence hoje, {{vencimento}}. Valor: {{valor}}.\nPagamento por Pix: {{link_pagamento}}\n{{aviso_bloqueio}}",
  },
  {
    id: "bloqueio",
    kind: "overdue",
    name: "Aviso de bloqueio",
    offset: 5,
    active: true,
    template:
      "Olá, {{nome_cliente}}. Ainda não identificamos o pagamento da fatura {{numero_fatura}} da empresa {{empresa}}, referente a {{referencia}}, com vencimento em {{vencimento}}.\n{{aviso_bloqueio}}\nValor: {{valor}}\nPagamento por Pix: {{link_pagamento}}\nSe já pagou, entre em contato conosco.",
  },
];
