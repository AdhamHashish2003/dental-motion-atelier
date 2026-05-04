const { createReadStream, existsSync, statSync } = require("node:fs");
const { createServer } = require("node:http");
const { extname, join, normalize, relative, resolve } = require("node:path");

const root = resolve(__dirname);
const port = Number(process.env.PORT || 4173);

const types = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

function resolveRequestPath(urlPath) {
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(urlPath.split("?")[0] || "/");
  } catch {
    return null;
  }

  const requested = decodedPath === "/" ? "/index.html" : decodedPath;
  const filePath = normalize(join(root, requested));
  const relativePath = relative(root, filePath);

  if (relativePath.startsWith("..") || relativePath.includes(":")) {
    return null;
  }

  return filePath;
}

createServer((request, response) => {
  const filePath = resolveRequestPath(request.url || "/");

  if (!filePath || !existsSync(filePath) || !statSync(filePath).isFile()) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }

  response.writeHead(200, {
    "Cache-Control": "public, max-age=300",
    "Content-Type": types[extname(filePath)] || "application/octet-stream",
  });
  createReadStream(filePath).pipe(response);
}).listen(port, () => {
  console.log(`Dental Motion Atelier is running on port ${port}`);
});
