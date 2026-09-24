#!/usr/bin/env node

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const HELP_TEXT = `Usage: npm run fork:diff [-- --remote=ryan] [-- --upstream=upstream/main] [-- --integration=mis-cambios] [-- --no-fetch] [-- --json]

Lists commits that exist on branches of a fork remote (default: ryan) but are not
yet reflected in this repo's integration branch (default: mis-cambios).

For each fork branch, finds the merge-base against the upstream branch (default:
upstream/main), then walks every commit from that point to the branch tip. A commit
counts as already incorporated if:
  - the integration branch contains a "(cherry picked from commit <sha>)" trailer
    for it (git cherry-pick -x leaves this automatically), or
  - it is listed in .fork-diff-ignore (one "<sha> # reason" per line) because a
    prior review found the same behavior already implemented upstream independently.

Everything else is reported as pending, so re-running this after each upstream/fork
fetch surfaces new fork work without re-litigating commits already triaged.

Add --json for machine-readable output instead of the human-readable report.`;

function parseArgs(argv) {
  const options = {
    remote: "ryan",
    upstream: "upstream/main",
    integration: "mis-cambios",
    fetch: true,
    json: false,
  };

  for (const arg of argv) {
    if (arg === "--no-fetch") {
      options.fetch = false;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log(HELP_TEXT);
      process.exit(0);
    } else if (arg.startsWith("--remote=")) {
      options.remote = arg.slice("--remote=".length);
    } else if (arg.startsWith("--upstream=")) {
      options.upstream = arg.slice("--upstream=".length);
    } else if (arg.startsWith("--integration=")) {
      options.integration = arg.slice("--integration=".length);
    } else {
      throw new Error(`Unknown argument: ${arg}\n\n${HELP_TEXT}`);
    }
  }

  return options;
}

async function git(args) {
  const { stdout } = await execFileAsync("git", args, { maxBuffer: 64 * 1024 * 1024 });
  return stdout.trim();
}

async function refExists(ref) {
  try {
    await git(["rev-parse", "--verify", "--quiet", ref]);
    return true;
  } catch {
    return false;
  }
}

async function loadIgnoreList() {
  const ignored = new Map();
  try {
    const raw = await readFile(new URL("../.fork-diff-ignore", import.meta.url), "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const [sha, ...reasonParts] = trimmed.split(/\s+#\s*/);
      ignored.set(sha.trim(), reasonParts.join(" # ").trim() || "reviewed: not needed");
    }
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  return ignored;
}

async function loadCherryPickedShas(integrationBranch) {
  const picked = new Set();
  if (!(await refExists(integrationBranch))) {
    return picked;
  }
  const log = await git(["log", integrationBranch, "--format=%B", "-z"]);
  const trailerPattern = /cherry picked from commit ([0-9a-f]{7,40})/g;
  for (const match of log.matchAll(trailerPattern)) {
    picked.add(match[1]);
  }
  return picked;
}

async function listForkBranches(remote) {
  const raw = await git(["for-each-ref", "--format=%(refname:short)", `refs/remotes/${remote}/`]);
  return raw
    .split("\n")
    .filter(Boolean)
    .filter((ref) => !ref.endsWith("/HEAD"));
}

async function listBranchCommits(mergeBase, branch) {
  const raw = await git([
    "log",
    "--no-merges",
    "--reverse",
    "--format=%H%x1f%h%x1f%an%x1f%ad%x1f%s",
    "--date=short",
    `${mergeBase}..${branch}`,
  ]);
  if (!raw) return [];
  return raw.split("\n").map((line) => {
    const [sha, short, author, date, subject] = line.split("\x1f");
    return { sha, short, author, date, subject };
  });
}

async function statForCommit(sha) {
  const raw = await git(["show", "--stat", "--format=", sha]);
  const lines = raw.trim().split("\n");
  return lines.length > 0 ? lines[lines.length - 1].trim() : "";
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.fetch) {
    await git(["fetch", options.remote, "--quiet"]);
    await git(["fetch", options.upstream.split("/")[0], "--quiet"]);
  }

  const branches = await listForkBranches(options.remote);
  if (branches.length === 0) {
    throw new Error(`No branches found under refs/remotes/${options.remote}/. Is the remote added?`);
  }

  const ignored = await loadIgnoreList();
  const pickedShas = await loadCherryPickedShas(options.integration);

  const report = [];
  for (const branch of branches) {
    const mergeBase = await git(["merge-base", options.upstream, branch]);
    const commits = await listBranchCommits(mergeBase, branch);
    const withStatus = [];
    for (const commit of commits) {
      let status = "pending";
      let reason;
      if (pickedShas.has(commit.sha) || pickedShas.has(commit.short)) {
        status = "incorporated";
      } else if (ignored.has(commit.sha)) {
        status = "ignored";
        reason = ignored.get(commit.sha);
      }
      withStatus.push({ ...commit, status, reason });
    }
    if (withStatus.length > 0) {
      report.push({ branch, mergeBase, commits: withStatus });
    }
  }

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  let pendingCount = 0;
  for (const { branch, commits } of report) {
    const pending = commits.filter((c) => c.status === "pending");
    if (pending.length === 0) continue;
    console.log(`\n${branch} (${pending.length} pending of ${commits.length} total)`);
    for (const commit of pending) {
      const stat = await statForCommit(commit.sha);
      console.log(`  ${commit.short}  ${commit.date}  ${commit.subject}`);
      console.log(`           ${stat}`);
      pendingCount += 1;
    }
  }

  const incorporated = report.flatMap((r) => r.commits).filter((c) => c.status === "incorporated").length;
  const ignoredCount = report.flatMap((r) => r.commits).filter((c) => c.status === "ignored").length;

  console.log(
    `\n${pendingCount} pending, ${incorporated} already incorporated into ${options.integration}, ${ignoredCount} ignored.`,
  );
  if (pendingCount === 0) {
    console.log("Nothing new to triage.");
  } else {
    console.log(
      "Review each pending commit, then either cherry-pick it with `git cherry-pick -x <sha>` " +
        `(so it shows as incorporated next run) or add it to .fork-diff-ignore with a reason.`,
    );
  }
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
