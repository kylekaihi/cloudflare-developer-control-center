import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/index.js";

const env = () => {
  const puts = [];
  return {
    BLOG_IMAGES: {
      puts,
      async put(key, value, options) {
        puts.push({ key, value, options });
        return {
          key,
          version: "test-version",
          size: 12,
          httpEtag: '"test"',
          uploaded: new Date("2026-05-16T00:00:00Z"),
        };
      },
    },
    PUBLIC_BASE_URL: "https://img.example.com",
    UPLOAD_TOKEN: "secret-token",
  };
};

test("rejects requests without the upload token", async () => {
  const response = await worker.fetch(new Request("https://upload.example.com/upload", {
    method: "POST",
  }), env());

  assert.equal(response.status, 401);
});

test("uploads an image to R2 and returns a Markdown image link", async () => {
  const bindings = env();
  const form = new FormData();
  form.set("file", new File(["image-bytes"], "Mobile Cafe Menu.JPG", { type: "image/jpeg" }));

  const response = await worker.fetch(new Request("https://upload.example.com/upload", {
    method: "POST",
    headers: {
      Authorization: "Bearer secret-token",
    },
    body: form,
  }), bindings);

  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(bindings.BLOG_IMAGES.puts.length, 1);
  const today = new Date().toISOString().slice(0, 10);
  assert.match(bindings.BLOG_IMAGES.puts[0].key, new RegExp(`^images\\/${today}-[a-z0-9-]+-mobile-cafe-menu\\.jpg$`));
  assert.equal(bindings.BLOG_IMAGES.puts[0].options.httpMetadata.contentType, "image/jpeg");
  assert.equal(bindings.BLOG_IMAGES.puts[0].options.httpMetadata.cacheControl, "public, max-age=31536000, immutable");
  assert.equal(body.url, `https://img.example.com/${bindings.BLOG_IMAGES.puts[0].key}`);
  assert.equal(body.markdown, `![mobile cafe menu](${body.url})`);
});
