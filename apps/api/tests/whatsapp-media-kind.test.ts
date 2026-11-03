import { describe, it, expect } from "vitest";
import { whatsappMediaKind } from "@whatsatendende/whatsapp";

describe("como cada arquivo vai para o WhatsApp", () => {
  it.each([
    ["image/jpeg", "image"],
    ["image/png", "image"],
    ["image/webp", "image"],
    ["image/svg+xml", "document"],
    ["image/heic", "document"],
    ["video/mp4", "video"],
    ["video/quicktime", "document"],
    ["audio/ogg; codecs=opus", "audio"],
    ["audio/wav", "document"],
    ["application/vnd.rar", "document"],
    ["", "document"],
  ])("%s vai como %s", (mime, kind) => {
    expect(whatsappMediaKind(mime)).toBe(kind);
  });
});
