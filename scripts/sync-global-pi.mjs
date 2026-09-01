#!/usr/bin/env node

// Build this repo's pi packages and install them over the global npm pi.
// Cross-platform (macOS, Linux, Windows).
//
// Project extensions (.pi/extensions-src/) are synced over the global
// extensions (~/.pi/agent/extensions/) so they work in every project. The
// source dir name is deliberately NOT .pi/extensions: pi auto-discovers
// .pi/extensions/ inside this repo, which would double-register tools also
// loaded from the global dir. Use --skip-extensions to opt out. Other user
// config (~/.pi/agent/) is machine-resident and not touched here; migrate it
// across machines with the pi-config-pack / pi-config-apply skills (bundle +
// user-decided merge). Prompts and skills travel via git (repo .pi/).
//
// Usage:
//   npm run sync                            # check + build + smoke test, snapshot current global, ask, install
//   npm run sync -- --skip-check            # skip npm run check (faster)
//   npm run sync -- --yes                   # skip the confirmation prompt
//   npm run sync -- --skip-extensions       # do not sync .pi/extensions-src to ~/.pi/agent/extensions
//   npm run sync -- --rollback [backup-dir] # restore a previous global snapshot (latest if omitted)
//   npm run sync -- --list-backups          # list available snapshots
//
// Snapshots are stored under ~/.pi/global-sync-backups/<timestamp>/ and contain
// tarballs packed from the global install *before* it was overwritten, plus
// restore.sh / restore.cmd for manual recovery.
//
// After installing, the npm "pi" shims are replaced with wrappers around a
// generated pi-launcher.mjs: `pi --local` runs this repo's pi from source via
// tsx, any other invocation runs the globally installed bundle. npm regenerates
// the shims on every global install, so this step runs after each sync.

import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
const EXTENSIONS_RELATIVE_DIR = join(".pi", "extensions-src");
const GLOBAL_EXTENSIONS_DIR = join(homedir(), ".pi", "agent", "extensions");

function parseArgs(argv) {
	const options = {
		assumeYes: false,
		runChecks: true,
		syncExtensions: true,
		rollback: false,
		rollbackDir: undefined,
		listBackups: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "-y" || arg === "--yes") options.assumeYes = true;
		else if (arg === "--skip-check") options.runChecks = false;
		else if (arg === "--skip-extensions") options.syncExtensions = false;
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

function restoreBackup(dir, repoRoot) {
	const tarballs = existsSync(dir) ? tgzFiles(dir) : [];
	if (tarballs.length === 0) throw new Error(`Not a valid backup directory: ${dir}`);
	console.log(`==> Restoring global pi from ${dir}`);
	run(NPM, ["install", "-g", "--ignore-scripts", ...tarballs]);
	if (repoRoot && existsSync(join(repoRoot, "packages", "coding-agent", "src", "cli.ts"))) {
		installPiShims(repoRoot, run(NPM, ["root", "-g"], { capture: true }).trim());
	}
	console.log(`Global pi is now: ${tryCapture("pi", ["--version"]) ?? "unknown"}`);
}

/**
 * Copy the repo's project extensions (.pi/extensions/) over the global
 * extensions (~/.pi/agent/extensions/). Only same-named entries are
 * overwritten; global-only extensions are kept. node_modules and .git are
 * skipped. A copy of the previous global extensions is kept next to the npm
 * package backup so the sync can be undone manually.
 */
function syncExtensions(repoRoot, backupDir) {
	const srcDir = join(repoRoot, EXTENSIONS_RELATIVE_DIR);
	const destDir = GLOBAL_EXTENSIONS_DIR;
	if (!existsSync(srcDir)) {
		console.log(`No ${EXTENSIONS_RELATIVE_DIR} in repo, skipping extension sync.`);
		return;
	}

	const extBackupDir = join(backupDir, "extensions");
	console.log(`==> Backing up global extensions to ${extBackupDir}`);
	if (existsSync(destDir)) {
		cpSync(destDir, extBackupDir, { recursive: true });
	} else {
		mkdirSync(extBackupDir, { recursive: true });
	}

	console.log(`\n==> Syncing extensions from ${srcDir} to ${destDir}`);
	mkdirSync(destDir, { recursive: true });
	const copied = copyExtensionTree(srcDir, destDir);
	console.log(`Synced ${copied} file(s). Extensions take effect on next pi start or /reload.`);
}

/**
 * Directory containing the npm-generated pi shims. `npm root -g` returns the
 * global node_modules dir; the shims live one level up on Windows and in the
 * prefix's bin/ on Unix.
 */
function globalBinDir(globalRoot) {
	return process.platform === "win32" ? dirname(globalRoot) : join(dirname(dirname(globalRoot)), "bin");
}

function piLauncherScript(repoRoot) {
	return `#!/usr/bin/env node
// Generated by scripts/sync-global-pi.mjs — do not edit by hand.
// \`pi --local\` launches the local pi repo from source (tsx); every other
// invocation launches the globally installed pi bundle.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const globalBin = dirname(fileURLToPath(import.meta.url));
const globalCli = join(globalBin, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
const localRepo = ${JSON.stringify(repoRoot)};

const args = process.argv.slice(2);
const isLocal = args[0] === "--local";

let entry;
if (isLocal) {
	const repoCli = join(localRepo, "packages", "coding-agent", "src", "cli.ts");
	const repoTsx = join(localRepo, "node_modules", "tsx", "dist", "cli.mjs");
	if (!existsSync(repoCli) || !existsSync(repoTsx)) {
		console.error(\`pi --local: local repo pi not found under \${localRepo}\`);
		process.exit(1);
	}
	entry = [repoTsx, repoCli];
} else {
	entry = [globalCli];
}

const result = spawnSync(process.execPath, [...entry, ...args.slice(isLocal ? 1 : 0)], { stdio: "inherit" });
process.exit(result.status ?? 1);
`;
}

function piShimCmd() {
	return [
		"@ECHO off",
		"GOTO start",
		":find_dp0",
		"SET dp0=%~dp0",
		"EXIT /b",
		":start",
		"SETLOCAL",
		"CALL :find_dp0",
		"",
		'IF EXIST "%dp0%\\node.exe" (',
		'  SET "_prog=%dp0%\\node.exe"',
		") ELSE (",
		'  SET "_prog=node"',
		"  SET PATHEXT=%PATHEXT:;.JS;=;%",
		")",
		"",
		'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\pi-launcher.mjs" %*',
		"",
	].join("\r\n");
}

function piShimPs1() {
	return `#!/usr/bin/env pwsh
$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent

$exe=""
if ($PSVersionTable.PSVersion -lt "6.0" -or $IsWindows) {
  # Fix case when both the Windows and Linux builds of Node
  # are installed in the same directory
  $exe=".exe"
}
$ret=0
if (Test-Path "$basedir/node$exe") {
  if ($MyInvocation.ExpectingInput) {
    $input | & "$basedir/node$exe"  "$basedir/pi-launcher.mjs" $args
  } else {
    & "$basedir/node$exe"  "$basedir/pi-launcher.mjs" $args
  }
  $ret=$LASTEXITCODE
} else {
  if ($MyInvocation.ExpectingInput) {
    $input | & "node$exe"  "$basedir/pi-launcher.mjs" $args
  } else {
    & "node$exe"  "$basedir/pi-launcher.mjs" $args
  }
  $ret=$LASTEXITCODE
}
exit $ret
`;
}

function piShimSh() {
	return `#!/bin/sh
basedir=$(dirname "$(echo "$0" | sed -e 's,\\\\,/,g')")

case \`uname\` in
    *CYGWIN*|*MINGW*|*MSYS*)
        if command -v cygpath > /dev/null 2>&1; then
            basedir=\`cygpath -w "$basedir"\`
        fi
    ;;
esac

if [ -x "$basedir/node" ]; then
  exec "$basedir/node"  "$basedir/pi-launcher.mjs" "$@"
else
  exec node  "$basedir/pi-launcher.mjs" "$@"
fi
`;
}

/**
 * Replace npm's pi shims with wrappers around pi-launcher.mjs so that
 * `pi --local` runs the repo pi from source while every other invocation uses
 * the globally installed bundle. npm regenerates its shims on every global
 * install, so this must run after each `npm install -g`.
 */
function installPiShims(repoRoot, globalRoot) {
	const bin = globalBinDir(globalRoot);
	writeFileSync(join(bin, "pi-launcher.mjs"), piLauncherScript(repoRoot));
	writeFileSync(join(bin, "pi.cmd"), piShimCmd());
	writeFileSync(join(bin, "pi.ps1"), piShimPs1());
	writeFileSync(join(bin, "pi"), piShimSh());
	console.log(`Installed pi shims in ${bin} (pi --local runs the repo pi from ${repoRoot})`);
}

function copyExtensionTree(srcDir, destDir) {
	let count = 0;
	for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
		if (entry.name === "node_modules" || entry.name === ".git") continue;
		const src = join(srcDir, entry.name);
		const dest = join(destDir, entry.name);
		if (entry.isDirectory()) {
			mkdirSync(dest, { recursive: true });
			count += copyExtensionTree(src, dest);
		} else {
			copyFileSync(src, dest);
			count++;
		}
	}
	return count;
}

async function confirm(question) {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	const answer = await new Promise((resolve) => rl.question(question, resolve));
	rl.close();
	return /^(y|yes)$/i.test(answer.trim());
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

	if (options.rollback) {
		let dir = options.rollbackDir;
		if (!dir) {
			const backups = listBackups(backupRoot);
			if (backups.length === 0) throw new Error(`No backups found in ${backupRoot}`);
			dir = backups[backups.length - 1];
		}
		restoreBackup(dir, repoRoot);
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
	installPiShims(repoRoot, globalRoot);

	if (options.syncExtensions) {
		syncExtensions(repoRoot, backupDir);
	}

	console.log(`\nGlobal pi is now: ${tryCapture("pi", ["--version"]) ?? "unknown"}`);
	console.log("To roll back: npm run sync -- --rollback");
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
	main().catch((error) => {
		console.error(error.message);
		process.exit(1);
	});
}
