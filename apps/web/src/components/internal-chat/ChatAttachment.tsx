import { useEffect, useState } from "react";
import type { ChatMessageDTO } from "@whatsatendende/types";
import { api } from "../../lib/api";
import { DocumentAttachment } from "../atendimento/DocumentPreview";

/** Attachments need the login token, so they're fetched as a blob instead of a plain link. */
export function ChatAttachment({ attachment }: { attachment: NonNullable<ChatMessageDTO["attachment"]> }) {
  const [url, setUrl] = useState<string | null>(null);
  const isImage = attachment.mimeType.startsWith("image/");

  useEffect(() => {
    if (!isImage) return;
    let objectUrl: string | null = null;
    api
      .get<Blob>(attachment.url, { responseType: "blob" })
      .then((res) => {
        objectUrl = URL.createObjectURL(res.data);
        setUrl(objectUrl);
      })
      .catch(() => setUrl(null));
    return () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [attachment.url, isImage]);

  async function download() {
    const res = await api.get<Blob>(attachment.url, { responseType: "blob" });
    const objectUrl = URL.createObjectURL(res.data);
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = attachment.name;
    link.click();
    URL.revokeObjectURL(objectUrl);
  }

  if (isImage && url) {
    return (
      <button type="button" onClick={download} className="block" title={`Baixar ${attachment.name}`}>
        <img src={url} alt={attachment.name} className="max-h-48 rounded-lg object-contain" />
      </button>
    );
  }
  // Same card as a customer conversation's document: PDFs, Word and .txt get a preview and open in the viewer;
  // anything else (an image still loading included) is a download card.
  return (
    <DocumentAttachment
      att={{ id: attachment.url, fileName: attachment.name, mimeType: attachment.mimeType, sizeBytes: attachment.size, url: `/api${attachment.url}`, kind: "DOCUMENT" }}
    />
  );
}
