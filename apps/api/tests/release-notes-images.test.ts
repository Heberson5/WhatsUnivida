import { describe, it, expect, beforeEach, afterAll } from "vitest";
import type { ReleaseContent, ReleaseNoteDTO } from "@whatsatendende/types";
import { prisma } from "../src/lib/prisma";
import { resetDatabase } from "./helpers";
import { fillShippedNoteImages, syncDefaultReleaseNotes } from "../src/modules/release-notes/release-notes.service";

const withoutImages: ReleaseContent = {
  version: "9.0.0",
  date: "01 jan 2030",
  name: "Teste",
  summary: "Teste",
  notes: [
    { type: "novo", area: "atendimento", title: "Nota A", text: "A" },
    { type: "novo", area: "atendimento", title: "Nota B", text: "B" },
  ],
};
const withImages: ReleaseContent = {
  ...withoutImages,
  notes: [
    { ...withoutImages.notes[0], images: [{ src: "/notas-de-versao/a.webp", caption: "A" }] },
    { ...withoutImages.notes[1], images: [{ src: "/notas-de-versao/b.webp", caption: "B" }] },
  ],
};
const notesOf = async () => (await prisma.releaseNoteVersion.findUniqueOrThrow({ where: { version: "9.0.0" } })).notes as unknown as ReleaseNoteDTO[];

describe("imagens das notas de versão já copiadas", () => {
  beforeEach(async () => {
    await resetDatabase();
    await prisma.releaseNoteVersion.deleteMany({ where: { version: "9.0.0" } });
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("uma versão copiada antes de ganhar imagens recebe as imagens uma vez, e a cópia não é feita de novo", async () => {
    await syncDefaultReleaseNotes([withoutImages]);
    expect((await notesOf()).every((n) => !n.images)).toBe(true);

    await syncDefaultReleaseNotes([withImages]); // already copied: the copy itself is not redone
    expect((await notesOf()).every((n) => !n.images)).toBe(true);

    expect(await fillShippedNoteImages([withImages])).toBe(2);
    expect((await notesOf()).map((n) => n.images?.[0]?.src)).toEqual(["/notas-de-versao/a.webp", "/notas-de-versao/b.webp"]);
    expect(await fillShippedNoteImages([withImages])).toBe(0);
  });

  it("não mexe no que o administrador deixou: imagem removida depois não volta, imagem própria fica", async () => {
    await syncDefaultReleaseNotes([withoutImages]);
    // The administrator gave Nota A an image of their own before the update.
    const notes = await notesOf();
    notes[0].images = [{ src: "/uploads/release-notes/minha.webp", caption: "Minha" }];
    await prisma.releaseNoteVersion.update({ where: { version: "9.0.0" }, data: { notes: notes as never } });

    expect(await fillShippedNoteImages([withImages])).toBe(1);
    const after = await notesOf();
    expect(after[0].images?.[0]?.src).toBe("/uploads/release-notes/minha.webp");
    expect(after[1].images?.[0]?.src).toBe("/notas-de-versao/b.webp");

    // Then they removed Nota B's image: a later start does not bring it back.
    after[1].images = [];
    await prisma.releaseNoteVersion.update({ where: { version: "9.0.0" }, data: { notes: after as never } });
    expect(await fillShippedNoteImages([withImages])).toBe(0);
    expect((await notesOf())[1].images).toEqual([]);
  });
});
