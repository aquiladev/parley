import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Load the repo-root .env so we don't have to duplicate vars per package.
// Runs before Next.js builds its webpack config, so NEXT_PUBLIC_* values
// are picked up by the DefinePlugin and inlined into the client bundle.
const here = dirname(fileURLToPath(import.meta.url));
const repoEnv = resolve(here, "..", "..", ".env");
if (existsSync(repoEnv)) {
  process.loadEnvFile(repoEnv);
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@parley/shared"],
};

export default nextConfig;
