// The GitHub workflows parse as YAML, and the write token only reaches the steps
// that need it. Needs the "yaml" dev package (npm ci).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const YAML = require("yaml");
const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".github", "workflows");
const load = (f) => YAML.parse(fs.readFileSync(path.join(DIR, f), "utf8"));

test("every workflow is valid YAML with jobs and steps", () => {
  for (const f of fs.readdirSync(DIR).filter((f) => f.endsWith(".yml"))) {
    const wf = load(f);
    assert.ok(wf.jobs && Object.keys(wf.jobs).length, `${f}: no jobs`);
    for (const [name, job] of Object.entries(wf.jobs)) {
      assert.ok(Array.isArray(job.steps) && job.steps.length, `${f}/${name}: no steps`);
      for (const s of job.steps) assert.ok(s.run || s.uses, `${f}/${name}: a step without run or uses`);
    }
  }
});

test("test and addon workflows only get a read-only token", () => {
  for (const f of ["test.yml", "addon.yml"]) assert.deepEqual(load(f).permissions, { contents: "read" }, f);
});

test("prices: the write token goes only to the steps that use git or gh", () => {
  const job = load("prices.yml").jobs.prices;
  assert.equal(job.env.GH_TOKEN, undefined);
  assert.equal(job.env.REPO_URL, undefined);
  const withToken = job.steps.filter((s) => s.env && (s.env.GH_TOKEN || s.env.REPO_URL)).map((s) => s.name);
  assert.deepEqual(withToken, [
    "Get previous history", "Keep history", "Publish release",
    "Prune old releases", "Keep schedule alive", "Start the next run",
  ]);
  for (const name of ["Tests", "Fetch auction houses", "Upload prices to CurseForge"]) {
    const s = job.steps.find((x) => x.name === name);
    assert.ok(!s.env?.GH_TOKEN && !s.env?.REPO_URL, `${name} must not get the write token`);
  }
});

test("prices: no write token left on disk for the feed's steps", () => {
  const job = load("prices.yml").jobs.prices;
  const checkout = job.steps.find((s) => s.uses?.startsWith("actions/checkout"));
  assert.equal(checkout.with?.["persist-credentials"], false, "checkout must not keep the token in .git/config");
  const hist = job.steps.find((s) => s.name === "Get previous history");
  assert.match(hist.run, /git -C history remote set-url origin "https:\/\/github\.com\//, "the history clone must drop the token from its remote");
});

test("prices: the addon it ships is tested (tests and Lua syntax) in a job before the prices job", () => {
  const { jobs } = load("prices.yml");
  assert.equal(jobs.prices.needs, "tests");
  const run = jobs.tests.steps.find((s) => s.name === "Addon tests").run;
  assert.match(run, /npm ci/);
  assert.match(run, /node --test tests\/\*\.test\.mjs/);
  assert.match(run, /luaparse/);
});

test("prices: npm packages only run in the tests job, with a read-only token and no secrets", () => {
  const wf = load("prices.yml");
  assert.deepEqual(wf.permissions, { contents: "read" }, "workflow default");
  assert.deepEqual(wf.jobs.tests.permissions, { contents: "read" });
  assert.doesNotMatch(JSON.stringify(wf.jobs.tests), /secrets\./);
  assert.deepEqual(wf.jobs.prices.permissions, { contents: "write", actions: "write" });
  for (const s of wf.jobs.prices.steps) assert.doesNotMatch(s.run ?? "", /\bnpm\b|node_modules/, `${s.name} must not use npm`);
});

test("prices: the chain goes on whatever happens to the tests; the work waits for them to pass", () => {
  const job = load("prices.yml").jobs.prices;
  assert.equal(job.if, "always()", "the prices job runs even if the tests failed");
  assert.match(job.env.FEED, /needs\.tests\.result == 'success'/);
  assert.match(job.env.FEED, /needs\.tests\.outputs\.skip != 'true'/);
  const last = job.steps.at(-1);
  assert.equal(last.name, "Start the next run");
  assert.equal(last.if, "always()");
  for (const s of job.steps.slice(0, -1)) {
    if (s.name === "Keep schedule alive") continue; // gh only, no feed or release
    assert.equal(s.if, "env.FEED == 'true'", `${s.name ?? s.uses} waits for the tests`);
  }
  // The fresh-release check now lives in the tests job, which skips its work too.
  const tests = load("prices.yml").jobs.tests;
  assert.equal(tests.outputs.skip, "${{ steps.fresh.outputs.skip }}");
  for (const s of tests.steps.slice(1)) assert.equal(s.if, "steps.fresh.outputs.skip != 'true'");
});
