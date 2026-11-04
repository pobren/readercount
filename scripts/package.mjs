// Makes the npm installer package (@mrpwob/readercount) in npm/: the installer with this version of the app inside.
// The release workflow publishes it. Try it locally with: npm run package && node npm/cli.mjs help
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "npm");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "app"), { recursive: true });
for (const name of ["src", "migrations", "scripts", "package.json", "tsconfig.json", "wrangler.jsonc", "README.md", "LICENSE"]) cpSync(join(root, name), join(out, "app", name), { recursive: true });
rmSync(join(out, "app", "scripts", "package.mjs"));
// npm leaves out files starting with a dot, so these travel without it and the installer puts it back.
cpSync(join(root, ".gitignore"), join(out, "app", "gitignore"));
cpSync(join(root, ".dev.vars.example"), join(out, "app", "dev.vars.example"));
cpSync(join(root, "installer", "cli.mjs"), join(out, "cli.mjs"));
cpSync(join(root, "LICENSE"), join(out, "LICENSE"));
writeFileSync(
	join(out, "README.md"),
	`# ReaderCount installer\n\nPrivate, cookie-free website stats that run on your own Cloudflare account. Free for personal and small business use, source available.\n\n\`\`\`sh\nnpx @mrpwob/readercount setup\n\`\`\`\n\nEverything else is on [GitHub](https://github.com/pobren/readercount) and [paulobrien.dev/readercount](https://paulobrien.dev/readercount/).\n`,
);
writeFileSync(
	join(out, "package.json"),
	JSON.stringify(
		{
			name: "@mrpwob/readercount",
			version: pkg.version,
			description: "Installer for ReaderCount: private, cookie-free website stats on your own Cloudflare account.",
			license: "SEE LICENSE IN LICENSE",
			homepage: pkg.homepage,
			repository: pkg.repository,
			bugs: pkg.bugs,
			type: "module",
			bin: { readercount: "cli.mjs" },
			files: ["cli.mjs", "app", "LICENSE", "README.md"],
			engines: { node: ">=22" },
			keywords: ["analytics", "stats", "cloudflare", "workers", "privacy", "cookie-free"],
		},
		null,
		"\t",
	) + "\n",
);
console.log(`npm/ is ready: @mrpwob/readercount ${pkg.version}`);
