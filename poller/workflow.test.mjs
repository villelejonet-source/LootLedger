// node --test poller/workflow.test.mjs
// Checks on .github/workflows/prices.yml: step order, and the shell of some steps
// run in bash against a local git repository and stubbed `gh` / `sleep`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const YML = readFileSync(join(HERE, "..", ".github", "workflows", "prices.yml"), "utf8").replace(/\r/g, "");

// The steps of the prices job (or another job): [{ name, if, run, raw }] in order.
function steps(want = "prices") {
  const out = [];
  const lines = YML.split("\n");
  let cur = null, job = null;
  for (let i = 0; i < lines.length; i++) {
    const j = lines[i].match(/^  ([\w-]+):$/);
    if (j) { job = j[1]; cur = null; continue; }
    const m = lines[i].match(/^      - (name: (.*)|uses: .*)$/);
    if (m) { cur = { name: m[2] ?? m[1], raw: [] }; if (job === want) out.push(cur); continue; }
    if (!cur) continue;
    cur.raw.push(lines[i]);
    const kv = lines[i].match(/^        (if|continue-on-error|run): (.*)$/);
    if (kv) cur[kv[1]] = kv[2];
    if (/^        run: \|$/.test(lines[i])) {
      const body = [];
      while (i + 1 < lines.length && (lines[i + 1] === "" || lines[i + 1].startsWith("          "))) body.push(lines[++i].slice(10));
      cur.run = body.join("\n");
    }
  }
  return out;
}
const step = (name) => steps().find((s) => s.name === name);
const names = () => steps().map((s) => s.name);

// Run a step's script like GitHub does (bash -eo pipefail), in `cwd`, with extra env.
// `${{ github.repository }}` becomes "owner/repo"; other expressions become "".
function runStep(name, cwd, env = {}) {
  const script = step(name).run.replace(/\$\{\{\s*([^}]*?)\s*\}\}/g, (_, e) => (e === "github.repository" ? "owner/repo" : ""));
  const r = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", script], {
    cwd, env: { ...process.env, ...env }, encoding: "utf8",
  });
  return { code: r.status, out: r.stdout + r.stderr };
}
const tmp = () => mkdtempSync(join(tmpdir(), "wf-"));
const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, stdio: "pipe" });

function bareRepo({ withHistory }) {
  const dir = tmp(), bare = join(dir, "repo.git"), work = join(dir, "work");
  git(dir, "init", "--quiet", "--bare", bare);
  mkdirSync(work);
  git(work, "init", "--quiet", "--initial-branch", withHistory ? "history" : "main");
  writeFileSync(join(work, "113.json.gz"), "x");
  git(work, "add", "-A");
  git(work, "commit", "--quiet", "-m", "c");
  git(work, "push", "--quiet", bare, "HEAD");
  return bare;
}

test("A2: no history branch yet -> start with an empty history", () => {
  const cwd = tmp();
  const r = runStep("Get previous history", cwd, { REPO_URL: bareRepo({ withHistory: false }) });
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(readdirSync(join(cwd, "history")), []);
});

test("A2: an existing history branch is cloned", () => {
  const cwd = tmp();
  const r = runStep("Get previous history", cwd, { REPO_URL: bareRepo({ withHistory: true }) });
  assert.equal(r.code, 0, r.out);
  assert.ok(existsSync(join(cwd, "history", "113.json.gz")));
});

test("A2: a repository that can't be read fails the step instead of starting empty", () => {
  const cwd = tmp();
  const r = runStep("Get previous history", cwd, { REPO_URL: join(cwd, "does-not-exist.git") });
  assert.notEqual(r.code, 0, r.out);
  assert.ok(!existsSync(join(cwd, "history")));
});

test("A3: history is saved right after the fetch, before release and CurseForge", () => {
  const n = names();
  assert.equal(n.indexOf("Keep history"), n.indexOf("Fetch auction houses") + 1);
  assert.ok(n.indexOf("Keep history") < n.indexOf("Publish release"));
  assert.equal(step("Upload prices to CurseForge")["continue-on-error"], "true");
});

test("A8a: the CurseForge upload is decided by the hour (or the manual input), not the event type", () => {
  const s = step("Upload prices to CurseForge");
  assert.doesNotMatch(s.if, /event_name/);
  assert.match(s.run, /date -u \+%H/);
  assert.match(s.run, /FORCE/);
});

// Stub `gh` and `sleep` on PATH; `gh` writes what it was asked to a log.
function stubs({ ghListFails }) {
  const dir = tmp(), log = join(dir, "gh.log");
  writeFileSync(join(dir, "sleep"), "#!/bin/sh\nexit 0\n");
  writeFileSync(join(dir, "gh"), [
    "#!/bin/sh",
    `echo "$1 $2" >> "${log.replace(/\\/g, "/")}"`,
    `if [ "$1 $2" = "run list" ]; then ${ghListFails ? "exit 1" : "echo 0"}; fi`,
    "exit 0", "",
  ].join("\n"));
  chmodSync(join(dir, "sleep"), 0o755);
  chmodSync(join(dir, "gh"), 0o755);
  const sep = process.platform === "win32" ? ";" : ":";
  return { PATH: dir + sep + process.env.PATH, log };
}

test("A8b: if listing the runs fails, the next run is still started", () => {
  const { PATH, log } = stubs({ ghListFails: true });
  const r = runStep("Start the next run", tmp(), { PATH, Path: PATH, RUN_ID: "1" });
  assert.equal(r.code, 0, r.out);
  assert.match(readFileSync(log, "utf8"), /workflow run/, r.out);
});

test("A8b: with no other run waiting, the next run is started", () => {
  const { PATH, log } = stubs({ ghListFails: false });
  const r = runStep("Start the next run", tmp(), { PATH, Path: PATH, RUN_ID: "1" });
  assert.equal(r.code, 0, r.out);
  assert.match(readFileSync(log, "utf8"), /workflow run/, r.out);
});

test("M2: npm runs only in the tests job; the prices job starts the next run even if the tests failed", () => {
  const prices = YML.slice(YML.indexOf("\n  prices:\n"));
  assert.match(prices, /^    needs: tests$/m);
  assert.match(prices, /^    if: always\(\)$/m);
  assert.ok(!steps().some((s) => /\bnpm\b/.test(s.run ?? "")), "no npm in the job holding the secrets");
  assert.ok(steps("tests").some((s) => /npm ci/.test(s.run ?? "")));
  const n = names();
  assert.equal(n.at(-1), "Start the next run");
  assert.equal(step("Start the next run").if, "always()");
});

test("L1: the release tag is passed as a variable and checked before gh is called", () => {
  const { PATH, log } = stubs({ ghListFails: false });
  assert.doesNotMatch(step("Publish release").run, /\$\{\{/, "no expressions pasted into the script");
  const bad = runStep("Publish release", tmp(), { PATH, Path: PATH, TAG: 'v1.0-1"; touch pwned; "', TITLE: "t" });
  assert.notEqual(bad.code, 0, bad.out);
  assert.match(bad.out, /Unexpected release tag/);
  assert.ok(!existsSync(log), "gh not called");
  const good = runStep("Publish release", tmp(), { PATH, Path: PATH, TAG: "v3.15.0-202611281235", TITLE: "t" });
  assert.equal(good.code, 0, good.out);
  assert.match(readFileSync(log, "utf8"), /release create/);
});
