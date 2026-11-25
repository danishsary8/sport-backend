import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js/min';

/** Normalises a phone number to E.164 ('012 345 678' → '+85512345678'); null if not a valid number. */
export function normalizePhone(input: string, region: CountryCode = 'KH'): string | null {
  if (!input || !input.trim()) return null;
  const parsed = parsePhoneNumberFromString(input.trim(), region);
  return parsed && parsed.isValid() ? parsed.number : null;
}
