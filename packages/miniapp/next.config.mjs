import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Load the repo-root .env so we don't have to duplicate vars per package.
// Runs before Next.js builds its webpack config, so NEXT_PUBLIC_* values
// are picked up by the DefinePlugin and inlined into the client bundle.
//
// `process.loadEnvFile` is Node 20.12+ / 21.7+. Fall back to a minimal
// parser on older Node so `next build` doesn't crash.
const here = dirname(fileURLToPath(import.meta.url));
const repoEnv = resolve(here, "..", "..", ".env");
if (existsSync(repoEnv)) {
  if (typeof process.loadEnvFile === "function") {
    process.loadEnvFile(repoEnv);
  } else {
    const { readFileSync } = await import("node:fs");
    const text = readFileSync(repoEnv, "utf-8");
    for (const rawLine of text.split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      // strip surrounding quotes and a trailing inline comment
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      } else {
        const hash = val.indexOf(" #");
        if (hash >= 0) val = val.slice(0, hash).trim();
      }
      if (process.env[key] === undefined) process.env[key] = val;
    }
  }
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@parley/shared"],
};

export default nextConfig;
