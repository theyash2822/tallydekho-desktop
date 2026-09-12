const crypto = require("crypto");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { axiosInstance, baseURL } = require("./helper");
const { info } = require("./logger");

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const rs = fs.createReadStream(filePath);
    rs.on("data", (c) => hash.update(c));
    rs.on("error", reject);
    rs.on("end", () => resolve(hash.digest("hex")));
  });
}

function absUploadUrl(url) {
  if (!url) return url;
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  return `${baseURL.replace(/\/$/, "")}${url.startsWith("/") ? url : `/${url}`}`;
}

async function uploadFile(url, filePath, headers = {}, onProgress) {
  const got = (await import("got")).default;
  const stat = await fsp.stat(filePath);
  const stream = fs.createReadStream(filePath);
  const request = got.put(absUploadUrl(url), {
    body: stream,
    headers: { ...headers, "Content-Length": String(stat.size) },
    throwHttpErrors: false,
  });
  request.on("uploadProgress", (p) => {
    if (onProgress) onProgress(p.percent || 0);
  });
  const res = await request;
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(`Upload failed: ${res.statusCode}`);
  }
  return res;
}

async function downloadFile(url, destPath, onProgress) {
  const got = (await import("got")).default;
  await fsp.mkdir(path.dirname(destPath), { recursive: true });
  const request = got.stream(absUploadUrl(url));
  request.on("downloadProgress", (p) => {
    if (onProgress) onProgress(p.percent || 0);
  });
  await new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(destPath);
    request.on("error", reject);
    ws.on("error", reject);
    ws.on("close", resolve);
    request.pipe(ws);
  });
}

module.exports = {
  sha256File,
  absUploadUrl,
  uploadFile,
  downloadFile,
};
