/**
 * Restores a backup from a file already on the server — for a backup too big to upload through the browser:
 *   docker compose exec api node dist/scripts/restore-backup.js /data/uploads/backup.wabk "<senha do backup>"
 * (a plain .tar.gz made before backups had a password needs no password). Same checks as Configurações › Backup ›
 * Restaurar (the same version of the system, everything read before anything is replaced). Restart the API
 * afterwards (docker compose restart api).
 */
import fs from "node:fs";
import { restoreBackupFile } from "../modules/backup/backup.service";
import { prisma } from "../lib/prisma";

async function main() {
  const [file, password] = process.argv.slice(2);
  if (!file || !fs.existsSync(file)) {
    console.error('Uso: node dist/scripts/restore-backup.js <arquivo.wabk | arquivo.tar.gz> ["<senha do backup>"]');
    process.exit(1);
  }
  const result = await restoreBackupFile(file, password, { userId: "", name: "linha de comando" });
  console.log(`Backup da versão ${result.manifest.version} (${result.manifest.createdAt}) restaurado: ${result.rows} registros e ${result.files} arquivos.`);
  console.log("Reinicie a API: docker compose restart api");
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err instanceof Error ? err.message : err);
  await prisma.$disconnect();
  process.exit(1);
});
