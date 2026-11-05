-- File names sent with accents were stored garbled: the upload read the browser's UTF-8 as Latin-1, so
-- "Manutenção.xlsx" became "ManutenÃ§Ã£o.xlsx" (fixed at the source in apps/api/src/lib/upload.ts). This puts back
-- the real names of what's already stored. A name is changed only when it has the garbling's tell-tale pattern (a
-- character from U+00C2..U+00F4 followed by one from U+0080..U+00BF) AND undoing it gives valid UTF-8 — names that
-- were always right (e.g. those that came from WhatsApp) can't pass both, so they stay exactly as they are.
-- The Auditoria keeps what it recorded at the time.

CREATE FUNCTION wa_fix_garbled_name(name TEXT) RETURNS TEXT AS $$
BEGIN
  IF name IS NULL OR name !~ '[Â-ô][\u0080-¿]' THEN
    RETURN name;
  END IF;
  RETURN convert_from(convert_to(name, 'LATIN1'), 'UTF8');
EXCEPTION WHEN OTHERS THEN
  RETURN name;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- A JSON array of files ({ fileName, ... }), as Pop Up / Comunicados keep their images and attachments.
CREATE FUNCTION wa_fix_garbled_names_in(files JSONB) RETURNS JSONB AS $$
  SELECT COALESCE(
    jsonb_agg(
      CASE WHEN jsonb_typeof(f) = 'object' AND f ? 'fileName' AND jsonb_typeof(f -> 'fileName') = 'string'
           THEN jsonb_set(f, '{fileName}', to_jsonb(wa_fix_garbled_name(f ->> 'fileName')))
           ELSE f END
      ORDER BY i
    ),
    '[]'::jsonb
  )
  FROM jsonb_array_elements(files) WITH ORDINALITY AS t(f, i);
$$ LANGUAGE sql IMMUTABLE;

UPDATE "MessageAttachment" SET "fileName" = wa_fix_garbled_name("fileName") WHERE "fileName" IS DISTINCT FROM wa_fix_garbled_name("fileName");
UPDATE "ChatMessage" SET "attachmentName" = wa_fix_garbled_name("attachmentName") WHERE "attachmentName" IS DISTINCT FROM wa_fix_garbled_name("attachmentName");
UPDATE "QuickReply" SET "mediaFileName" = wa_fix_garbled_name("mediaFileName") WHERE "mediaFileName" IS DISTINCT FROM wa_fix_garbled_name("mediaFileName");
UPDATE "ClosingMessage" SET "mediaFileName" = wa_fix_garbled_name("mediaFileName") WHERE "mediaFileName" IS DISTINCT FROM wa_fix_garbled_name("mediaFileName");
UPDATE "QueueWaitMessage" SET "mediaFileName" = wa_fix_garbled_name("mediaFileName") WHERE "mediaFileName" IS DISTINCT FROM wa_fix_garbled_name("mediaFileName");
UPDATE "BirthdayMessage" SET "mediaFileName" = wa_fix_garbled_name("mediaFileName") WHERE "mediaFileName" IS DISTINCT FROM wa_fix_garbled_name("mediaFileName");
UPDATE "MessageTemplate" SET "headerSampleFileName" = wa_fix_garbled_name("headerSampleFileName") WHERE "headerSampleFileName" IS DISTINCT FROM wa_fix_garbled_name("headerSampleFileName");

UPDATE "Announcement" SET
  "images" = CASE WHEN jsonb_typeof("images") = 'array' THEN wa_fix_garbled_names_in("images") ELSE "images" END,
  "attachments" = CASE WHEN jsonb_typeof("attachments") = 'array' THEN wa_fix_garbled_names_in("attachments") ELSE "attachments" END
WHERE ("images"::text || "attachments"::text) ~ '[Â-ô][\u0080-¿]';

UPDATE "DataSource"
SET "config" = jsonb_set("config", '{fileName}', to_jsonb(wa_fix_garbled_name("config" ->> 'fileName')))
WHERE jsonb_typeof("config") = 'object'
  AND jsonb_typeof("config" -> 'fileName') = 'string'
  AND "config" ->> 'fileName' IS DISTINCT FROM wa_fix_garbled_name("config" ->> 'fileName');

DROP FUNCTION wa_fix_garbled_names_in(JSONB);
DROP FUNCTION wa_fix_garbled_name(TEXT);
