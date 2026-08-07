#!/usr/bin/env node

// Build this repo's pi packages and install them over the global npm pi,
// then mirror the repo's plugin/config state to the global pi user dir.
// Cross-platform (macOS, Linux, Windows).
//
// Usage:
//   npm run sync                            # check + build + smoke test, snapshot current global, ask, install, then sync plugins/config
//   npm run sync -- --skip-check            # skip npm run check (faster)
//   npm run sync -- --yes                   # skip the confirmation prompt
//   npm run sync -- --plugins-only          # only sync plugins/config (no pi build/install)
//   npm run sync -- --rollback [backup-dir] # restore a previous global snapshot (latest if omitted)
//   npm run sync -- --list-backups          # list available snapshots
//
// Plugin/config sync (repo is the source of truth, global is the mirror):
//   - packages in .pi/settings.json are installed/removed globally to match
//   - .pi/extensions/*.ts are mirrored to ~/.pi/agent/extensions/ (extra files removed)
//   - .pi/skills and .pi/prompts are copied over (never removed globally)
//   - the rest of ~/.pi/agent/settings.json (theme, models, etc.) is left alone
//
// Snapshots are stored under ~/.pi/global-sync-backups/<timestamp>/ and contain
// tarballs packed from the global install *before* it was overwritten, plus
// restore.sh / restore.cmd for manual recovery.

import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

// Publishable packages, same list as scripts/local-release.mjs (short names).
// Includes the pre-rename storage package so snapshots of older global installs stay complete.
const PACKAGES = [
	"pi-ai",
	"pi-tui",
	"pi-agent-core",
	"pi-protocol",
	"pi-client",
	"pi-session-backend-sqlite-node",
	"pi-storage-sqlite-node",
	"pi-coding-agent",
];
const KEEP_BACKUPS = 5;
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";

function parseArgs(argv) {
	const options = {
		assumeYes: false,
		runChecks: true,
		rollback: false,
		rollbackDir: undefined,
		listBackups: false,
		pluginsOnly: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "-y" || arg === "--yes") options.assumeYes = true;
		else if (arg === "--plugins-only") options.pluginsOnly = true;
		else if (arg === "--skip-check") options.runChecks = false;
		else if (arg === "--list-backups") options.listBackups = true;
		else if (arg === "--rollback") {
			options.rollback = true;
			if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) options.rollbackDir = argv[++i];
		} else {
			throw new Error(`Unknown option: ${arg}`);
		}
	}
	return options;
}

function quoteArg(arg) {
	return /[\s"]/.test(arg) ? `"${arg.replaceAll('"', '\\"')}"` : arg;
}

function run(command, args, options = {}) {
	console.log(`$ ${[command, ...args].join(" ")}`);
	const useShell = process.platform === "win32";
	const result = spawnSync(command, useShell ? args.map(quoteArg) : args, {
		cwd: options.cwd,
		encoding: "utf8",
		shell: useShell,
		stdio: options.capture ? ["inherit", "pipe", "inherit"] : "inherit",
	});
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`Command failed: ${[command, ...args].join(" ")}`);
	return result.stdout ?? "";
}

function tryCapture(command, args) {
	const result = spawnSync(command, args, {
		encoding: "utf8",
		shell: process.platform === "win32",
		stdio: ["ignore", "pipe", "ignore"],
	});
	return result.status === 0 ? result.stdout.trim() : undefined;
}

function tgzFiles(directory) {
	return readdirSync(directory)
		.filter((file) => file.endsWith(".tgz"))
		.map((file) => join(directory, file));
}

function listBackups(backupRoot) {
	if (!existsSync(backupRoot)) return [];
	return readdirSync(backupRoot, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && existsSync(join(backupRoot, entry.name, "metadata")))
		.map((entry) => join(backupRoot, entry.name))
		.sort();
}

function printBackups(backupRoot) {
	const backups = listBackups(backupRoot);
	if (backups.length === 0) {
		console.log(`No backups found in ${backupRoot}`);
		return;
	}
	console.log(`Backups in ${backupRoot} (oldest first):`);
	for (const dir of backups) {
		console.log(`  ${dir.split(/[\\/]/).pop()}  (${readFileSync(join(dir, "metadata"), "utf8").trim()})`);
	}
}

function restoreBackup(dir) {
	const tarballs = existsSync(dir) ? tgzFiles(dir) : [];
	if (tarballs.length === 0) throw new Error(`Not a valid backup directory: ${dir}`);
	console.log(`==> Restoring global pi from ${dir}`);
	run(NPM, ["install", "-g", "--ignore-scripts", ...tarballs]);
	console.log(`Global pi is now: ${tryCapture("pi", ["--version"]) ?? "unknown"}`);
}

async function confirm(question) {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	const answer = await new Promise((resolve) => rl.question(question, resolve));
	rl.close();
	return /^(y|yes)$/i.test(answer.trim());
}

function readJson(file) {
	return JSON.parse(readFileSync(file, "utf8"));
}

function writeJson(file, data) {
	writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}

function npmPackageName(source) {
	return source.startsWith("npm:") ? source : undefined;
}

function globalAgentDir() {
	return join(homedir(), ".pi", "agent");
}

/**
 * Mirror .pi/settings.json packages onto the global user settings:
 * install what the repo has that global lacks, remove what global has that
 * the repo lacks, then rewrite the global packages array in repo order.
 * The rest of the global settings (theme, models, etc.) is preserved.
 */
async function syncPackages(repoRoot, assumeYes) {
	const repoSettingsPath = join(repoRoot, ".pi", "settings.json");
	const globalSettingsPath = join(globalAgentDir(), "settings.json");
	if (!existsSync(repoSettingsPath)) {
		console.log("No .pi/settings.json in repo; skipping package sync.");
		return;
	}
	const repoPackages = readJson(repoSettingsPath).packages ?? [];
	const globalSettings = existsSync(globalSettingsPath) ? readJson(globalSettingsPath) : {};
	const globalPackages = globalSettings.packages ?? [];

	const toInstall = repoPackages.filter((p) => !globalPackages.includes(p));
	const toRemove = globalPackages.filter((p) => !repoPackages.includes(p));

	if (toInstall.length === 0 && toRemove.length === 0) {
		const current = existsSync(globalSettingsPath) ? (readJson(globalSettingsPath).packages ?? []) : [];
		if (JSON.stringify(current) !== JSON.stringify(repoPackages)) {
			const updated = existsSync(globalSettingsPath) ? readJson(globalSettingsPath) : {};
			updated.packages = [...repoPackages];
			writeJson(globalSettingsPath, updated);
			console.log("Global settings packages reordered to match the repo.");
		} else {
			console.log("Packages: in sync (" + repoPackages.length + ")");
		}
		return;
	}

	console.log("Packages to install globally:", toInstall.length ? toInstall.join(", ") : "(none)");
	console.log("Packages to remove globally: ", toRemove.length ? toRemove.join(", ") : "(none)");
	if (toRemove.length > 0 && !assumeYes) {
		const ok = await confirm("Remove the global-only packages above? [y/N] ");
		if (!ok) {
			console.log("Aborted package sync. Global packages unchanged.");
			return;
		}
	}

	for (const pkg of toInstall) {
		const npmSpec = npmPackageName(pkg);
		if (!npmSpec) {
			console.log(`Skipping non-npm source (not auto-installable): ${pkg}`);
			continue;
		}
		run("pi", ["install", npmSpec], { capture: true });
		console.log(`Installed ${npmSpec}`);
	}
	for (const pkg of toRemove) {
		const npmSpec = npmPackageName(pkg);
		if (!npmSpec) {
			console.log(`Skipping non-npm source (not auto-removable): ${pkg}`);
			continue;
		}
		run("pi", ["remove", npmSpec], { capture: true });
		console.log(`Removed ${npmSpec}`);
	}

	// Rewrite global packages in repo order (mirror), preserving other settings.
	const updated = existsSync(globalSettingsPath) ? readJson(globalSettingsPath) : {};
	updated.packages = [...repoPackages];
	writeJson(globalSettingsPath, updated);
	console.log("Global settings packages now mirror the repo.");
}

/**
 * Mirror .pi/extensions/*.ts (and subdirectories) onto ~/.pi/agent/extensions/.
 * Extra top-level .ts files present globally but not in the repo are removed
 * (after confirmation unless --yes).
 */
async function syncExtensions(repoRoot, assumeYes) {
	const repoExtDir = join(repoRoot, ".pi", "extensions");
	const globalExtDir = join(globalAgentDir(), "extensions");
	if (!existsSync(repoExtDir)) {
		console.log("No .pi/extensions in repo; skipping extension sync.");
		return;
	}
	const repoExts = readdirSync(repoExtDir).filter((f) => f.endsWith(".ts"));
	mkdirSync(globalExtDir, { recursive: true });
	const globalExts = readdirSync(globalExtDir).filter((f) => f.endsWith(".ts"));

	const toRemove = globalExts.filter((f) => !repoExts.includes(f));
	const toCopy = repoExts.filter((f) => !globalExts.includes(f));

	cpSync(repoExtDir, globalExtDir, { recursive: true, force: true });
	console.log(
		`Extensions: ${toCopy.length} copied/updated, ${toRemove.length} extra global file(s) to remove`,
	);
	if (toRemove.length > 0) {
		console.log("  Extra global files: " + toRemove.join(", "));
		if (!assumeYes) {
			const ok = await confirm("Remove these extra global extension files? [y/N] ");
			if (!ok) {
				console.log("Skipped removing extra global extension files.");
				return;
			}
		}
		for (const f of toRemove) rmSync(join(globalExtDir, f), { force: true });
	}
}

/**
 * Copy .pi/skills and .pi/prompts over the global ones. One-way: files that
 * exist globally but not in the repo are kept (global skills dir also holds
 * unrelated user skills).
 */
function syncSkillsPrompts(repoRoot) {
	for (const sub of ["skills", "prompts"]) {
		const repoDir = join(repoRoot, ".pi", sub);
		const globalDir = join(globalAgentDir(), sub);
		if (!existsSync(repoDir)) continue;
		mkdirSync(globalDir, { recursive: true });
		cpSync(repoDir, globalDir, { recursive: true, force: true });
		console.log(`Copied .pi/${sub} over ~/.pi/agent/${sub} (one-way).`);
	}
}

async function syncPlugins(repoRoot, assumeYes) {
	console.log("==> Syncing repo plugins/config to global (repo is the source of truth)");
	await syncPackages(repoRoot, assumeYes);
	await syncExtensions(repoRoot, assumeYes);
	syncSkillsPrompts(repoRoot);
	console.log("Plugin/config sync done. Run /reload in running pi sessions to pick up changes.");
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	const repoRoot = process.cwd();
	const outDir = process.env.PI_SYNC_OUT ?? join(tmpdir(), "pi-global-sync");
	const backupRoot = process.env.PI_SYNC_BACKUP_DIR ?? join(homedir(), ".pi", "global-sync-backups");

	if (options.listBackups) {
		printBackups(backupRoot);
		return;
	}

	if (options.pluginsOnly) {
		await syncPlugins(repoRoot, options.assumeYes);
		return;
	}

	if (options.rollback) {
		let dir = options.rollbackDir;
		if (!dir) {
			const backups = listBackups(backupRoot);
			if (backups.length === 0) throw new Error(`No backups found in ${backupRoot}`);
			dir = backups[backups.length - 1];
		}
		restoreBackup(dir);
		return;
	}

	const globalVersion = tryCapture("pi", ["--version"]) ?? "not installed";
	const globalRoot = run(NPM, ["root", "-g"], { capture: true }).trim();
	const repoVersion = JSON.parse(readFileSync(join(repoRoot, "packages/coding-agent/package.json"), "utf8")).version;
	const gitState = tryCapture("git", ["describe", "--tags", "--always", "--dirty"]) ?? "unknown";

	console.log(`Global pi:  ${globalVersion} (root: ${globalRoot})`);
	console.log(`Repo pi:    ${repoVersion} (${gitState})\n`);

	const releaseArgs = ["run", "release:local", "--", "--out", outDir, "--force", "--skip-install", "--skip-test"];
	if (!options.runChecks) releaseArgs.push("--skip-check");
	console.log(`==> Packing repo packages (check: ${options.runChecks ? "on" : "off"}, tests: off)`);
	run(NPM, releaseArgs, { cwd: repoRoot });

	console.log("\n==> Smoke testing packed tarballs in an isolated directory");
	const smokeDir = join(outDir, "smoke");
	mkdirSync(smokeDir, { recursive: true });
	writeFileSync(join(smokeDir, "package.json"), '{"private":true}\n');
	run(NPM, ["install", "--omit=dev", "--ignore-scripts", ...tgzFiles(join(outDir, "tarballs"))], { cwd: smokeDir });
	const smokePi = join(smokeDir, "node_modules", ".bin", process.platform === "win32" ? "pi.cmd" : "pi");
	run(smokePi, ["--version"]);
	run(smokePi, ["--help"], { capture: true });
	run(smokePi, ["--list-models"], { capture: true });
	console.log("Smoke test passed.");

	if (!options.assumeYes) {
		const ok = await confirm("\nInstall repo build over the global pi? [y/N] ");
		if (!ok) {
			console.log("Aborted. Global pi unchanged.");
			return;
		}
	}

	console.log(`\n==> Snapshotting current global install (${globalVersion})`);
	const timestamp = new Date().toISOString().replaceAll(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
	const backupDir = join(backupRoot, `${timestamp}-${globalVersion}`);
	mkdirSync(backupDir, { recursive: true });
	for (const short of PACKAGES) {
		const installed = join(globalRoot, "@earendil-works", short);
		if (existsSync(installed)) {
			run(NPM, ["pack", installed, "--pack-destination", backupDir], { capture: true });
		}
	}
	writeFileSync(join(backupDir, "metadata"), `version=${globalVersion} git=${gitState} date=${new Date().toISOString()}\n`);
	writeFileSync(join(backupDir, "restore.sh"), '#!/usr/bin/env bash\nset -euo pipefail\nnpm install -g --ignore-scripts "$(dirname "$0")"/*.tgz\n');
	writeFileSync(
		join(backupDir, "restore.cmd"),
		'@ECHO off\r\nfor %%f in ("%~dp0*.tgz") do call npm install -g --ignore-scripts "%%f"\r\n',
	);
	console.log(`Snapshot saved: ${backupDir}`);

	const backups = listBackups(backupRoot);
	for (const old of backups.slice(0, Math.max(0, backups.length - KEEP_BACKUPS))) {
		console.log(`Pruning old backup: ${old.split(/[\\/]/).pop()}`);
		rmSync(old, { force: true, recursive: true });
	}

	console.log("\n==> Installing tarballs globally");
	run(NPM, ["install", "-g", "--ignore-scripts", ...tgzFiles(join(outDir, "tarballs"))]);

	console.log(`\nGlobal pi is now: ${tryCapture("pi", ["--version"]) ?? "unknown"}`);
	console.log("To roll back: npm run sync -- --rollback");

	await syncPlugins(repoRoot, options.assumeYes);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
	main().catch((error) => {
		console.error(error.message);
		process.exit(1);
	});
}
