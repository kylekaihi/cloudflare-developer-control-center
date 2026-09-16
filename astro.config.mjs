import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://developer-control-center.pages.dev",
  output: "static",
  markdown: {
    syntaxHighlight: "shiki",
    shikiConfig: {
      theme: "github-light",
      wrap: false,
    },
  },
});
