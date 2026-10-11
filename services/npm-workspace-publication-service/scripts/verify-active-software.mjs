#!/usr/bin/env node
import { planSoftwareVerification, executeSoftwareVerification } from "../src/software-verification.mjs";
import { withSourceBindings } from "../src/source-bindings.mjs";
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { censusActiveSoftware, summarizeSoftwareCensus } from "../src/software-estate.mjs";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
};
const options = (name) => args.flatMap((argument, index) => argument === name && args[index + 1] !== undefined ? [args[index + 1]] : []);
const root = option("--root", process.cwd());
const concurrency = Number.parseInt(option("--concurrency", "2"), 10);
const timeoutMs = Number.parseInt(option("--timeout-ms", "120000"), 10);
const execute = args.includes("--execute");
const sourceBindings = args.includes("--source-bindings");
const reportPath = option("--report", null);
const requestedPackages = options("--package");
if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new TypeError("--concurrency must be a positive integer");
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new TypeError("--timeout-ms must be a positive integer");
if (sourceBindings && !execute) throw new TypeError("--source-bindings requires --execute");

const completeCensus = await censusActiveSoftware(root);
const plan = planSoftwareVerification(completeCensus, { packages: requestedPackages, includeDependencies: args.includes("--dependencies") });
const packages = plan.packages;
const census = summarizeSoftwareCensus(packages);
const absentBins = packages.flatMap((pkg) => pkg.bins.filter(({ exists }) => !exists).map((bin) => ({ package: pkg.name, path: pkg.path, bin })));
const missingSourceBins = absentBins.filter(({ bin }) => bin.status === "missing-source");
const jobs = packages.flatMap((pkg) => pkg.lifecycle.map((script) => ({ package: pkg.name, dir: pkg.dir, path: pkg.path, script })));
const incompatibleNodeEngines = packages.filter((pkg) => !pkg.nodeEngine.compatible).map((pkg) => ({ package: pkg.name, path: pkg.path, nodeEngine: pkg.nodeEngine }));

if (!execute) {
  const report = { mode: "plan", census, lifecycleJobs: jobs.length, tiers: plan.tiers, cyclic: plan.cyclic, absentBins, incompatibleNodeEngines };
  if (reportPath) await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = missingSourceBins.length === 0 && incompatibleNodeEngines.length === 0 && plan.cyclic.length === 0 ? 0 : 1;
} else {
  if (incompatibleNodeEngines.length > 0) {
    throw new Error(`runtime preflight refused ${incompatibleNodeEngines.length} package(s) under Node ${process.versions.node}`);
  }
  const run = (job) => new Promise((resolveJob) => {
    const started = performance.now();
    const child = spawn("npm", ["run", job.script], { cwd: job.dir, env: process.env, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", timedOut = false, escalation;
    const retain = (current, chunk) => `${current}${chunk}`.slice(-12000);
    child.stdout.on("data", (chunk) => { stdout = retain(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = retain(stderr, chunk); });
    const kill = (signal) => {
      try { if (process.platform === "win32") child.kill(signal); else if (child.pid) process.kill(-child.pid, signal); }
      catch (error) { if (error.code !== "ESRCH") stderr = retain(stderr, error.message); }
    };
    const timer = setTimeout(() => { timedOut = true; kill("SIGTERM"); escalation = setTimeout(() => kill("SIGKILL"), 2000); }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      clearTimeout(escalation);
      resolveJob({ ...job, status: "failed-to-start", error: error.message, stdout, stderr });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      clearTimeout(escalation);
      resolveJob({ ...job, status: timedOut ? "timed-out" : code === 0 ? "passed" : "failed", code, signal, stdout, stderr, durationMs: Math.round(performance.now() - started) });
    });
  });
  const executePlan = () => executeSoftwareVerification(plan, { concurrency, run });
  const execution = sourceBindings ? await withSourceBindings(plan, executePlan) : await executePlan();
  const results = execution.results;
  const failures = results.filter(({ status }) => status !== "passed");
  const finalCompleteCensus = await censusActiveSoftware(root);
  const selectedPaths = new Set(packages.map((pkg) => pkg.path));
  const finalPackages = finalCompleteCensus.filter((pkg) => selectedPaths.has(pkg.path));
  const finalAbsentBins = finalPackages.flatMap((pkg) => pkg.bins.filter(({ exists }) => !exists).map((bin) => ({ package: pkg.name, path: pkg.path, bin })));
  const finalMissingSourceBins = finalAbsentBins.filter(({ bin }) => bin.status === "missing-source");
  const summary = {
    mode: "execute", sourceBindings,
    census,
    lifecycleJobs: jobs.length,
    passed: results.length - failures.length,
    failed: failures.filter(({ status }) => status !== "blocked").length,
    blocked: failures.filter(({ status }) => status === "blocked").length,
    absentBins: finalAbsentBins.length,
  };
  const report = { summary, cyclic: plan.cyclic, packageStates: execution.packageStates, timings: results.filter(({durationMs}) => durationMs !== undefined).map(({package: name, script, durationMs}) => ({package: name, script, durationMs})), absentBins: finalAbsentBins, failures };
  if (reportPath) await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = execution.ok && failures.length === 0 && finalMissingSourceBins.length === 0 && finalAbsentBins.length === 0 ? 0 : 1;
}
