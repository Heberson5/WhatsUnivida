import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

// The web container's nginx serves the single-page app: any path that is not a
// file has to answer with index.html, because the page is drawn by the browser
// (React Router). "try_files $uri $uri/ /index.html" also tries the path as a
// DIRECTORY — and the app has a folder of release-note screenshots called
// /notas-de-versao, the same as its page: reloading the page got a 301 to
// /notas-de-versao/ and then 403 "directory index forbidden".
const NGINX_CONF = path.resolve(__dirname, "../../../infrastructure/docker/nginx.conf");
const WEB_PUBLIC = path.resolve(__dirname, "../../web/public");
const APP_ROUTES = path.resolve(__dirname, "../../web/src/App.tsx");

/** The directives of `location / { ... }`, comments left out. */
function rootLocationDirectives(conf: string): string[] {
  const start = conf.indexOf("location / {");
  if (start === -1) throw new Error("location / not found in nginx.conf");
  const end = conf.indexOf("}", start);
  return conf
    .slice(start, end)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

describe("nginx.conf: pages of the app", () => {
  const conf = fs.readFileSync(NGINX_CONF, "utf-8");

  it("sends a path that is not a file to index.html, without trying it as a directory", () => {
    const tryFiles = rootLocationDirectives(conf).find((line) => line.startsWith("try_files"));
    expect(tryFiles).toBe("try_files $uri /index.html;");
  });

  it("still has the trap this guards against: a page of the app with the same name as a folder of static files", () => {
    const folders = fs.readdirSync(WEB_PUBLIC, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    const routes = [...fs.readFileSync(APP_ROUTES, "utf-8").matchAll(/<Route path="\/([\w-]+)"/g)].map((match) => match[1]);
    expect(folders.filter((folder) => routes.includes(folder))).toEqual(["notas-de-versao"]);
  });
});
