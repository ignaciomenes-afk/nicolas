/* Cálculo y validación de solicitudes. Funciones puras: sin almacenamiento ni red. */
(function (root, factory) {
  "use strict";
  const core = factory();
  if (typeof module === "object" && module.exports) module.exports = core;
  if (root) root.LoanRequestCore = core;
})(typeof window !== "undefined" ? window : typeof globalThis !== "undefined" ? globalThis : null, function () {
  "use strict";

  const INTEREST_PERCENT = 35;
  const LONG_TERM_INTEREST_PERCENT = 40;
  const LONG_TERM_START_MONTHS = 4;
  const MAX_PRINCIPAL_CENTS = 100000000000;
  const MAX_TERM_MONTHS = 24;
  const CUIL_PREFIXES = new Set(["20", "23", "24", "27"]);
  const CUIL_WEIGHTS = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];

  function fail(message) { throw new Error(message); }
  function integer(value, minimum, maximum, label) {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail(`${label} debe ser un número entero entre ${minimum} y ${maximum}.`);
    return value;
  }
  function daysInMonth(year, month) {
    const date = new Date(0);
    date.setUTCFullYear(year, month, 0);
    date.setUTCHours(12, 0, 0, 0);
    return date.getUTCDate();
  }
  function dateParts(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail("La fecha debe tener formato AAAA-MM-DD.");
    const year = Number(value.slice(0, 4)), month = Number(value.slice(5, 7)), day = Number(value.slice(8, 10));
    if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) fail("Ingresá una fecha que exista en el calendario.");
    return { year, month, day };
  }

  /** Calendar addition, retaining the original day or an explicitly supplied anchor. */
  function addMonths(value, months, anchor) {
    const source = dateParts(value);
    integer(months, -120000, 120000, "La cantidad de meses");
    const day = anchor === undefined ? source.day : integer(anchor, 1, 31, "El día de vencimiento");
    const monthIndex = source.year * 12 + source.month - 1 + months;
    const year = Math.floor(monthIndex / 12), month = monthIndex - year * 12 + 1;
    if (year < 1 || year > 9999) fail("Los vencimientos superan el rango de fechas permitido.");
    const resultDay = Math.min(day, daysInMonth(year, month));
    return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(resultDay).padStart(2, "0")}`;
  }

  /** One total charge on the principal: 35% for 1–3 months, 40% from 4 months. */
  function calculate(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) fail("Completá los datos del préstamo.");
    const principal = integer(input.principal_cents, 1, MAX_PRINCIPAL_CENTS, "El capital en centavos");
    const months = integer(input.term_months, 1, MAX_TERM_MONTHS, "El plazo en meses");
    const interestPercent = months >= LONG_TERM_START_MONTHS ? LONG_TERM_INTEREST_PERCENT : INTEREST_PERCENT;
    const firstDate = dateParts(input.first_due_date);
    const anchor = input.due_anchor_day === undefined ? firstDate.day : integer(input.due_anchor_day, 1, 31, "El día de vencimiento");
    if (addMonths(input.first_due_date, 0, anchor) !== input.first_due_date) fail("El día de vencimiento no coincide con la primera fecha elegida.");
    // Round half up to one cent before distributing the total; no monthly compounding.
    const interest = Number((BigInt(principal) * BigInt(interestPercent) + 50n) / 100n);
    const total = principal + interest;
    const regular = Math.floor(total / months), last = total - regular * (months - 1);
    const installments = Array.from({ length: months }, (_, index) => ({
      number: index + 1,
      due_date: addMonths(input.first_due_date, index, anchor),
      amount_cents: index === months - 1 ? last : regular,
    }));
    return {
      principal_cents: principal,
      interest_cents: interest,
      total_cents: total,
      term_months: months,
      installments,
      regular_installment_cents: regular,
      last_installment_cents: last,
      interest_percent: interestPercent,
    };
  }

  /** Decimal text without thousands separators. Dot or comma may separate cents. */
  function parseMoney(value) {
    if (typeof value !== "string") fail("Ingresá el importe con números, sin separadores de miles.");
    const cleaned = value.trim();
    if (!/^\d+(?:[.,]\d{1,2})?$/.test(cleaned)) fail("Ingresá un importe válido, sin separadores de miles y con hasta dos decimales.");
    const parts = cleaned.replace(",", ".").split(".");
    // Cap input length before BigInt parsing; leading zeros are otherwise harmless.
    const whole = parts[0].replace(/^0+(?=\d)/, "");
    if (whole.length > 14) fail("El importe supera el máximo permitido.");
    const cents = BigInt(whole) * 100n + BigInt((parts[1] || "").padEnd(2, "0"));
    if (cents > BigInt(Number.MAX_SAFE_INTEGER)) fail("El importe supera el máximo permitido.");
    return Number(cents);
  }

  /** Format check only: this cannot prove that ANSES issued the number or verify identity. */
  function validateCuil(value) {
    const invalid = (message, normalized = "") => ({ valid: false, normalized, message });
    if (typeof value !== "string" || !/^[\d\s-]+$/.test(value)) return invalid("Ingresá tu CUIL con números, espacios o guiones.");
    const normalized = value.replace(/[\s-]/g, "");
    if (!/^\d{11}$/.test(normalized)) return invalid("El CUIL debe contener 11 dígitos.", normalized);
    if (!CUIL_PREFIXES.has(normalized.slice(0, 2))) return invalid("Ingresá un CUIL de persona con prefijo 20, 23, 24 o 27.", normalized);
    let sum = 0;
    for (let index = 0; index < CUIL_WEIGHTS.length; index++) sum += Number(normalized[index]) * CUIL_WEIGHTS[index];
    // A remainder of 1 has no valid decimal check digit. In particular, do not map 10 to 9.
    const digit = Number(normalized[10]);
    if ((sum + digit) % 11 !== 0) return invalid("Revisá tu CUIL: el dígito verificador no coincide.", normalized);
    return { valid: true, normalized, message: "" };
  }

  /**
   * Return digits suitable for a wa.me URL, preserving the entered country code.
   * International '+' is required, except an unambiguous full Argentine 54/549 number.
   * Local ten-digit numbers and the domestic '0'/'15' prefixes are never guessed.
   */
  function normalizePhone(value) {
    const invalid = message => ({ valid: false, international: "", message });
    if (typeof value !== "string" || !/^\+?[\d\s().-]+$/.test(value.trim())) return invalid("Ingresá un teléfono con código de país, por ejemplo +54 9 11 1234 5678.");
    const source = value.trim(), international = source.replace(/[\s().-]/g, "").replace(/^\+/, "");
    if (!/^[1-9]\d{7,14}$/.test(international)) return invalid("El teléfono debe tener entre 8 y 15 dígitos e incluir el código de país, sin el 0 inicial.");
    const explicitCountry = source.startsWith("+");
    const completeArgentina = /^54\d{10}$/.test(international) || /^549\d{10}$/.test(international);
    if (!explicitCountry && !completeArgentina) return invalid("Incluí el código de país precedido por +. Para un celular argentino: +54 9, código de área y número, sin 0 ni 15.");
    if (international.startsWith("54") && !completeArgentina) return invalid("Revisá el teléfono argentino: +54, código de área y número; para celulares, +54 9 seguido de 10 dígitos, sin 0 ni 15.");
    return { valid: true, international, message: "" };
  }

  return Object.freeze({ calculate, addMonths, parseMoney, validateCuil, normalizePhone, parseArgentinaPhone: normalizePhone, INTEREST_PERCENT, LONG_TERM_INTEREST_PERCENT, LONG_TERM_START_MONTHS, MAX_PRINCIPAL_CENTS, MAX_TERM_MONTHS });
});
