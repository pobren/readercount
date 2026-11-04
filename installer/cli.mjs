#!/usr/bin/env node
// The ReaderCount installer: npx @mrpwob/readercount setup
// Copies ReaderCount into a folder, signs in to Cloudflare with Wrangler, makes the database, deploys the
// Worker and sets the sign-in password. `update` copies a new version over an existing folder (keeping your
// wrangler.jsonc) and deploys it. Needs nothing but Node.js: Wrangler is installed into the folder.
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const app = join(here, "app");
const version = JSON.parse(readFileSync(join(here, "package.json"), "utf8")).version;
const [command = "help", folderArg] = process.argv.slice(2);

const say = (text = "") => console.log(text);
const fail = (text) => {
	console.error(`\n${text}\n`);
	process.exit(1);
};
const run = (cwd, args, opts = {}) => {
	const r = spawnSync("npx", ["wrangler", ...args], { cwd, stdio: [opts.input ? "pipe" : "inherit", opts.capture ? "pipe" : "inherit", "inherit"], encoding: "utf8", input: opts.input, shell: process.platform === "win32" });
	if (opts.capture) process.stdout.write(r.stdout ?? "");
	return r;
};

/** Asks a question, hiding what's typed (for the password). */
function ask(question, hidden = false) {
	return new Promise((done) => {
		process.stdout.write(question);
		const stdin = process.stdin;
		let text = "";
		if (stdin.isTTY) stdin.setRawMode(true);
		stdin.resume();
		stdin.setEncoding("utf8");
		const onData = (chunk) => {
			for (const c of chunk) {
				if (c === "\r" || c === "\n") {
					stdin.removeListener("data", onData);
					if (stdin.isTTY) stdin.setRawMode(false);
					stdin.pause();
					process.stdout.write("\n");
					return done(text);
				}
				if (c === "\u0003") process.exit(130);
				if (c === "\u007f" || c === "\b") {
					if (text) {
						text = text.slice(0, -1);
						if (!hidden) process.stdout.write("\b \b");
					}
					continue;
				}
				text += c;
				process.stdout.write(hidden ? "*" : c);
			}
		};
		stdin.on("data", onData);
	});
}

/** Copies the app's files into a folder. Keeps an existing wrangler.jsonc and .dev.vars. */
function copyApp(folder, keepConfig) {
	for (const name of ["src", "migrations", "scripts", "package.json", "tsconfig.json", "README.md", "LICENSE"]) {
		cpSync(join(app, name), join(folder, name), { recursive: true });
	}
	if (!keepConfig) {
		cpSync(join(app, "wrangler.jsonc"), join(folder, "wrangler.jsonc"));
		cpSync(join(app, "gitignore"), join(folder, ".gitignore"));
		cpSync(join(app, "dev.vars.example"), join(folder, ".dev.vars.example"));
	}
}

function install(folder) {
	say("\nInstalling Wrangler, Cloudflare's own tool, into the folder...");
	execFileSync("npm", ["install", "--no-audit", "--no-fund"], { cwd: folder, stdio: "inherit", shell: process.platform === "win32" });
}

function signIn(folder) {
	const who = run(folder, ["whoami"], { capture: true });
	if (who.status !== 0 || /not authenticated/i.test(who.stdout ?? "")) {
		say("\nSigning in to Cloudflare. Your browser will open: allow Wrangler, then come back here.");
		if (run(folder, ["login"]).status !== 0) fail("Couldn't sign in to Cloudflare. Run the installer again to retry.");
	}
}

/** Makes the database (or finds it if it's already there) and writes its ID into wrangler.jsonc. */
function database(folder) {
	say("\nMaking the database...");
	const made = run(folder, ["d1", "create", "readercount"], { capture: true });
	let id = /"database_id":\s*"([0-9a-f-]{36})"/.exec(made.stdout ?? "")?.[1] ?? /database_id\s*=\s*"([0-9a-f-]{36})"/.exec(made.stdout ?? "")?.[1];
	if (!id) {
		const list = run(folder, ["d1", "list", "--json"], { capture: true });
		try {
			id = JSON.parse(list.stdout).find((d) => d.name === "readercount")?.uuid;
		} catch {}
	}
	if (!id) fail("Couldn't make the database. Check you can see Workers & Pages in your Cloudflare dashboard, then try again.");
	const file = join(folder, "wrangler.jsonc");
	const config = readFileSync(file, "utf8");
	if (!config.includes('"database_id"')) writeFileSync(file, config.replace('"database_name": "readercount",', `"database_name": "readercount",\n\t\t\t"database_id": "${id}",`));
}

async function password(folder) {
	say("\nChoose the password you'll sign in to your stats with (at least 12 characters).");
	for (;;) {
		const first = await ask("Password: ", true);
		if (first.length < 12) {
			say("That's too short. Use at least 12 characters.");
			continue;
		}
		if ((await ask("Same again: ", true)) !== first) {
			say("Those didn't match. Try again.");
			continue;
		}
		if (run(folder, ["secret", "put", "ADMIN_PASSWORD"], { input: first, capture: true }).status !== 0) fail("Couldn't save the password. Run `npx wrangler secret put ADMIN_PASSWORD` in the folder to try again.");
		return;
	}
}

function deploy(folder) {
	say("\nDeploying ReaderCount...");
	const r = spawnSync("node", ["scripts/deploy.mjs"], { cwd: folder, stdio: ["inherit", "pipe", "inherit"], encoding: "utf8" });
	process.stdout.write(r.stdout ?? "");
	if (r.status !== 0) fail("The deploy didn't finish. Fix what Wrangler said above, then run `npm run deploy` in the folder.");
	return /https:\/\/[a-z0-9.-]+\.workers\.dev/.exec(r.stdout ?? "")?.[0];
}

async function setup() {
	const folder = resolve(folderArg ?? "readercount");
	if (existsSync(join(folder, "wrangler.jsonc"))) fail(`There's already a ReaderCount in ${folder}. To update it, run: npx @mrpwob/readercount update ${folderArg ?? "readercount"}`);
	say(`ReaderCount ${version}: setting up in ${folder}`);
	copyApp(folder, false);
	install(folder);
	signIn(folder);
	database(folder);
	const address = deploy(folder);
	await password(folder);
	say(`\nDone. ReaderCount is running${address ? ` at ${address}` : ""}.`);
	say("Open it, sign in with your password and add your website.");
	say("To put it on your own address, such as stats.example.com, see \"Your own address\" in the README.");
	say(`Keep the ${folderArg ?? "readercount"} folder: updates run from it.`);
	say("\nFree for one person or organisation's own websites, up to 10. Running it for clients needs a commercial licence: https://paulobrien.dev/contact/");
}

function update() {
	const folder = resolve(folderArg ?? (existsSync("wrangler.jsonc") ? "." : "readercount"));
	if (!existsSync(join(folder, "wrangler.jsonc"))) fail(`There's no ReaderCount in ${folder}. Run this in the folder you set it up in, or name it: npx @mrpwob/readercount update path/to/readercount`);
	say(`Updating the ReaderCount in ${folder} to ${version}. Your wrangler.jsonc stays as it is.`);
	if (existsSync(join(folder, "src"))) renameSync(join(folder, "src"), join(folder, ".src-before-update"));
	copyApp(folder, true);
	spawnSync(process.platform === "win32" ? "rmdir" : "rm", process.platform === "win32" ? ["/s", "/q", ".src-before-update"] : ["-rf", ".src-before-update"], { cwd: folder, shell: process.platform === "win32" });
	install(folder);
	signIn(folder);
	deploy(folder);
	say(`\nDone. ReaderCount ${version} is live. What's new: https://github.com/pobren/readercount/releases`);
}

function help() {
	say(`ReaderCount ${version}: private, cookie-free website stats on your own Cloudflare account.

  npx @mrpwob/readercount setup [folder]    Set up ReaderCount (in ./readercount unless you name a folder)
  npx @mrpwob/readercount update [folder]   Update an existing ReaderCount to this version
  npx @mrpwob/readercount help              This help

Setting up signs you in to Cloudflare in your browser, makes the database, deploys the Worker
and asks for the password you'll sign in with. Everything goes into your own Cloudflare account.

Free for one person or organisation's own websites, up to 10. Source available:
https://github.com/pobren/readercount`);
}

if (command === "setup") await setup();
else if (command === "update") update();
else help();
