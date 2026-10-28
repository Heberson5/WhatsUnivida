// @vitest-environment node
import { describe, it, expect } from "vitest";
import config from "../../vite.config";

type AssetFileNames = (asset: { names?: string[]; name?: string }) => string;

function assetFileNames(): AssetFileNames {
  const output = config.build?.rollupOptions?.output;
  const options = Array.isArray(output) ? output[0] : output;
  return options!.assetFileNames as AssetFileNames;
}

describe("nome dos arquivos gerados no build", () => {
  it("o arquivo auxiliar do leitor de PDF (.mjs) sai como .js: o nginx não conhece .mjs e o entregava com tipo errado, que o navegador não executa", () => {
    expect(assetFileNames()({ names: ["pdf.worker.min.mjs"] })).toBe("assets/[name]-[hash].js");
    expect(assetFileNames()({ name: "pdf.worker.min.mjs" })).toBe("assets/[name]-[hash].js"); // older Rollup field
  });

  it("os outros arquivos mantêm a extensão", () => {
    expect(assetFileNames()({ names: ["logo.svg"] })).toBe("assets/[name]-[hash][extname]");
    expect(assetFileNames()({ names: ["Inter.woff2"] })).toBe("assets/[name]-[hash][extname]");
    expect(assetFileNames()({})).toBe("assets/[name]-[hash][extname]");
  });
});
