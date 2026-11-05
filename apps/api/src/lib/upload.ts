import multer from "multer";

/**
 * Every file upload in the API goes through here. Browsers send a file's name in UTF-8, but multer (busboy) reads
 * it as Latin-1 unless told otherwise — so "Manutenção.xlsx" used to be stored, shown and even sent to the customer's
 * WhatsApp as "ManutenÃ§Ã£o.xlsx". One place to set it means a new upload can't forget it (tests/upload-names.test.ts
 * fails if `multer(` shows up anywhere else).
 */
export function createUpload(options: multer.Options = {}): multer.Multer {
  // defParamCharset is a real multer option (busboy's), just missing from @types/multer.
  return multer({ ...options, defParamCharset: "utf8" } as multer.Options);
}
