#!/usr/bin/env node

import { access } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { spawn } from "node:child_process";

const usage = `Usage:
  R2_BUCKET=your-bucket R2_PUBLIC_URL=https://img.example.com npm run upload:image -- ./path/photo.jpg [images/photo.jpg]

Environment:
  R2_BUCKET        Required. Cloudflare R2 bucket name.
  R2_PUBLIC_URL    Required. Public custom domain or r2.dev URL for the bucket.
  R2_PREFIX        Optional. Default object prefix when no key is supplied. Defaults to "images".
  R2_CACHE_CONTROL Optional. Defaults to "public, max-age=31536000, immutable".`;

const [fileArg, keyArg] = process.argv.slice(2);
const bucket = process.env.R2_BUCKET;
const publicUrl = process.env.R2_PUBLIC_URL;
const prefix = normalizeKey(process.env.R2_PREFIX || "images");
const cacheControl =
  process.env.R2_CACHE_CONTROL || "public, max-age=31536000, immutable";

if (!fileArg || !bucket || !publicUrl) {
  console.error(usage);
  process.exit(1);
}

const filePath = resolve(fileArg);

try {
  await access(filePath);
} catch {
  console.error(`Image file does not exist: ${filePath}`);
  process.exit(1);
}

const objectKey = normalizeKey(keyArg || `${prefix}/${basename(filePath)}`);
if (!objectKey) {
  console.error("Object key cannot be empty.");
  process.exit(1);
}

const contentType = getImageContentType(filePath);
if (!contentType) {
  console.error("Unsupported image type. Use jpg, jpeg, png, gif, webp, avif, or svg.");
  process.exit(1);
}

const objectPath = `${bucket}/${objectKey}`;
const wranglerCommand = "wrangler r2 object put";
const args = [
  "wrangler",
  "r2",
  "object",
  "put",
  objectPath,
  "--file",
  filePath,
  "--content-type",
  contentType,
  "--cache-control",
  cacheControl,
];

const child = spawn("npx", args, { stdio: "inherit" });

child.on("exit", (code) => {
  if (code) {
    process.exit(code);
  }

  const url = buildPublicUrl(publicUrl, objectKey);
  const alt = basename(filePath).replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ");

  console.log("");
  console.log("R2 image uploaded.");
  console.log(`Command: ${wranglerCommand} ${objectPath}`);
  console.log(`Cache-Control: ${cacheControl}`);
  console.log(`Object key: ${objectKey}`);
  console.log(`Fixed URL: ${url}`);
  console.log(`Markdown: ![${alt}](${url})`);
  console.log(`Frontmatter cover: "${url}"`);
});

function normalizeKey(value) {
  return value
    .replaceAll("\\", "/")
    .replace(/^\/+/, "")
    .replace(/\/{2,}/g, "/")
    .trim();
}

function buildPublicUrl(baseUrl, key) {
  const encodedKey = key.split("/").map(encodeURIComponent).join("/");
  return `${baseUrl.replace(/\/+$/, "")}/${encodedKey}`;
}

function getImageContentType(filePath) {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".avif")) return "image/avif";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  return "";
}
