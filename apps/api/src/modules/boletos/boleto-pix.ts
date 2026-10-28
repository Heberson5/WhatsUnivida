// The PIX of a boleto (Banco Central's BR Code, "PIX copia e cola"): the source brings it ready, from the bank — the
// system never makes one up. It only counts when it really is a PIX code and its CRC (the last 4 characters) checks:
// a code cut or changed on the way would print a QR Code nobody can pay.

/** CRC16-CCITT (0x1021, starting at 0xFFFF), as the BR Code's field 63 carries it. */
function crc16(payload: string): string {
  let crc = 0xffff;
  for (const byte of Buffer.from(payload, "utf8")) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

/** The PIX copia e cola in `value`, or null when there's none or it isn't a valid one. */
export function validPixCode(value: string | undefined): string | null {
  const code = (value ?? "").trim();
  if (!code.startsWith("000201") || !/br\.gov\.bcb\.pix/i.test(code)) return null;
  const crcAt = code.length - 4;
  if (code.slice(crcAt - 4, crcAt) !== "6304") return null;
  return crc16(code.slice(0, crcAt)) === code.slice(crcAt).toUpperCase() ? code : null;
}

const field = (id: string, value: string) => `${id}${String(value.length).padStart(2, "0")}${value}`;

/** A fictitious PIX (static, made-up key) for the layout preview — never a real payment. */
export function examplePixCode(cents: number): string {
  const payload =
    field("00", "01") +
    field("26", field("00", "br.gov.bcb.pix") + field("01", "00000000-0000-0000-0000-000000000000")) +
    field("52", "0000") +
    field("53", "986") +
    field("54", (cents / 100).toFixed(2)) +
    field("58", "BR") +
    field("59", "EMPRESA EXEMPLO LTDA") +
    field("60", "CIDADE EXEMPLO") +
    field("62", field("05", "EXEMPLO")) +
    "6304";
  return payload + crc16(payload);
}
