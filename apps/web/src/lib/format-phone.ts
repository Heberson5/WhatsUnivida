/** "5511987654321" → "+55 11 98765-4321"; anything that isn't a Brazilian number is shown as "+<digits>". */
export function formatPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  const br = /^55(\d{2})(\d{4,5})(\d{4})$/.exec(digits);
  return br ? `+55 ${br[1]} ${br[2]}-${br[3]}` : `+${digits}`;
}

/**
 * For reading a contact's number: a Brazilian mobile WhatsApp keeps without the 9 ("556599990000") is shown as
 * the number people know, with it ("+55 65 99999-0000"). Where the exact number WhatsApp uses matters (Nova
 * conversa, Configurações › Números de telefone), formatPhone shows it as stored.
 */
export function formatPhoneAsKnown(phone: string): string {
  const mobileWithoutNine = /^55([1-9]\d)([6-9]\d{3})(\d{4})$/.exec(phone.replace(/\D/g, ""));
  return mobileWithoutNine ? `+55 ${mobileWithoutNine[1]} 9${mobileWithoutNine[2]}-${mobileWithoutNine[3]}` : formatPhone(phone);
}
