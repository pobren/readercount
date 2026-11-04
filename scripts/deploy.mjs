// Deploys ReaderCount: brings the database up to date, then deploys the Worker. Used by `npm run deploy`,
// the Deploy to Cloudflare button and the installer. On a first deploy with no database yet, Wrangler makes
// the database while deploying, so the tables are made straight after.
import { execFileSync } from "node:child_process";

const wrangler = (...args) => execFileSync("npx", ["wrangler", ...args], { stdio: "inherit" });
let migrated = false;
try {
	wrangler("d1", "migrations", "apply", "DB", "--remote");
	migrated = true;
} catch {
	console.log("\nNo database yet: deploying first, which makes it.\n");
}
wrangler("deploy", ...process.argv.slice(2));
if (!migrated) wrangler("d1", "migrations", "apply", "DB", "--remote");
