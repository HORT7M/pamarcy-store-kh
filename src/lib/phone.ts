/**
 * Cambodian phone numbers. Accepts 0xx xxx xxx, +855 xx xxx xxx, 855xxxxxxxx.
 * Mobile/landline numbers have 8–9 digits after the leading 0 / country code.
 */
export function normalizeKhPhone(input: string): string | null {
  const digits = input.replace(/[^\d+]/g, "");
  let local: string;
  if (digits.startsWith("+855")) local = digits.slice(4);
  else if (digits.startsWith("855")) local = digits.slice(3);
  else if (digits.startsWith("0")) local = digits.slice(1);
  else local = digits;
  local = local.replace(/^0+/, "");
  if (!/^[1-9]\d{7,8}$/.test(local)) return null;
  return "+855" + local;
}

export function isKhPhone(input: string): boolean {
  return normalizeKhPhone(input) !== null;
}

export function formatKhPhone(e164: string | null | undefined): string {
  if (!e164) return "—";
  const local = e164.replace(/^\+855/, "");
  if (local.length === 8) return `+855 ${local.slice(0, 2)} ${local.slice(2, 5)} ${local.slice(5)}`;
  if (local.length === 9) return `+855 ${local.slice(0, 2)} ${local.slice(2, 5)} ${local.slice(5)}`;
  return e164;
}
