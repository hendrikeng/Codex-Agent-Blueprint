#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

const rootDir = process.cwd();
const configPath = path.join(rootDir, 'docs', 'agent-hardening', 'evals.config.json');

function fail(message) {
  console.error(`[eval-verify] ${message}`);
  process.exit(1);
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isTemplatePlaceholder(value) {
  return /^\{\{[A-Z0-9_]+\}\}$/.test(String(value ?? '').trim());
}

function toIsoDate(value) {
  const parsed = Date.parse(String(value ?? ''));
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return new Date(parsed);
}

function daysBetween(a, b) {
  return Math.floor((b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24));
}

function normalizePath(value) {
  return String(value).split(path.sep).join('/');
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function isWithinRoot(absPath) {
  const relative = path.relative(rootDir, absPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function isTemplateMode() {
  const agentsPath = path.join(rootDir, 'AGENTS.md');
  if (!(await exists(agentsPath))) {
    return false;
  }
  const raw = await fs.readFile(agentsPath, 'utf8');
  const owner = raw.match(/^Owner:\s+(.+)$/m)?.[1]?.trim() ?? '';
  const updated = raw.match(/^Last Updated:\s+(.+)$/m)?.[1]?.trim() ?? '';
  return isTemplatePlaceholder(owner) && isTemplatePlaceholder(updated);
}

function parseJson(raw, filePath) {
  try {
    return JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(`Invalid JSON in ${filePath}: ${message}`);
  }
}

function suiteRequirementEntry(raw) {
  if (typeof raw === 'string') {
    return { id: raw, status: 'pass' };
  }
  if (isObject(raw) && typeof raw.id === 'string') {
    return {
      id: raw.id,
      status: String(raw.status ?? 'pass').trim().toLowerCase() || 'pass'
    };
  }
  fail('Each requiredSuites entry must be a string or object with an id.');
}

function validateSuites(report, requiredSuites, label) {
  if (!Array.isArray(report.suites) || report.suites.length === 0) {
    fail(`${label} report field 'suites' must be a non-empty array.`);
  }
  const suitesById = new Map();
  for (const suite of report.suites) {
    if (!isObject(suite)) {
      fail(`Each ${label} report suite entry must be an object.`);
    }
    const id = String(suite.id ?? '').trim();
    const status = String(suite.status ?? '').trim().toLowerCase();
    if (!id || !status) {
      fail(`Each ${label} report suite must include id and status.`);
    }
    suitesById.set(id, status);
  }
  for (const rawRequirement of requiredSuites) {
    const requirement = suiteRequirementEntry(rawRequirement);
    const observed = suitesById.get(requirement.id);
    if (!observed) {
      fail(`Required ${label} suite is missing from report: '${requirement.id}'.`);
    }
    if (observed !== requirement.status) {
      fail(
        `${label} suite '${requirement.id}' status '${observed}' does not satisfy required status '${requirement.status}'.`
      );
    }
  }
}

async function main() {
  const templateMode = await isTemplateMode();
  if (!(await exists(configPath))) {
    fail(`Missing config file: ${normalizePath(path.relative(rootDir, configPath))}`);
  }

  const config = parseJson(await fs.readFile(configPath, 'utf8'), configPath);
  if (!isObject(config)) {
    fail('Eval config must be a JSON object.');
  }

  const reportRel = String(config.reportPath ?? '').trim();
  if (!reportRel) {
    fail("Config field 'reportPath' is required.");
  }

  const reportAbs = path.join(rootDir, reportRel);
  if (!(await exists(reportAbs))) {
    fail(`Missing eval report file: ${reportRel}`);
  }

  const report = parseJson(await fs.readFile(reportAbs, 'utf8'), reportAbs);
  if (!isObject(report)) {
    fail('Eval report must be a JSON object.');
  }

  const generatedAtRaw = report.generatedAtUtc;
  if (typeof generatedAtRaw !== 'string' || generatedAtRaw.trim().length === 0) {
    fail("Report field 'generatedAtUtc' is required.");
  }
  if (templateMode && isTemplatePlaceholder(generatedAtRaw)) {
    console.log('[eval-verify] skipped in template mode (unresolved eval report placeholders).');
    return;
  }
  const generatedAt = toIsoDate(generatedAtRaw);
  if (!generatedAt) {
    fail(`Report generatedAtUtc is invalid: ${String(generatedAtRaw)}`);
  }

  const maxAgeDays = Number(config.maxAgeDays ?? 0);
  if (!Number.isInteger(maxAgeDays) || maxAgeDays <= 0) {
    fail("Config field 'maxAgeDays' must be a positive integer.");
  }
  const ageDays = daysBetween(generatedAt, new Date());
  if (ageDays < 0) {
    fail(`Eval report generatedAtUtc is in the future: ${generatedAtRaw}`);
  }
  if (ageDays > maxAgeDays) {
    fail(`Eval report is stale (${ageDays} days old, max ${maxAgeDays}).`);
  }

  const summary = report.summary;
  if (!isObject(summary)) {
    fail("Report field 'summary' must be an object.");
  }

  const total = Number(summary.total);
  const passed = Number(summary.passed);
  const failed = Number(summary.failed);
  const passRate = Number(summary.passRate);
  if (!Number.isFinite(total) || !Number.isFinite(passed) || !Number.isFinite(failed) || !Number.isFinite(passRate)) {
    fail('Report summary fields total/passed/failed/passRate must be numeric.');
  }
  if (total <= 0) {
    fail('Eval report summary.total must be greater than zero.');
  }
  if (passed < 0 || failed < 0) {
    fail('Eval report summary passed/failed values must be non-negative.');
  }
  if (passed + failed > total) {
    fail('Eval report summary is inconsistent: passed + failed exceeds total.');
  }
  if (passRate < 0 || passRate > 1) {
    fail('Eval report summary.passRate must be within [0,1].');
  }
  const derivedPassRate = passed / total;
  if (Math.abs(derivedPassRate - passRate) > 0.001) {
    fail(
      `Eval report summary.passRate (${passRate}) does not match passed/total (${derivedPassRate.toFixed(3)}).`
    );
  }

  const minimumPassRate = Number(config.minimumPassRate ?? 0);
  if (!Number.isFinite(minimumPassRate) || minimumPassRate < 0 || minimumPassRate > 1) {
    fail("Config field 'minimumPassRate' must be within [0,1].");
  }
  if (passRate < minimumPassRate) {
    fail(`Eval passRate ${passRate.toFixed(3)} is below minimum ${minimumPassRate.toFixed(3)}.`);
  }

  const regressions = report.regressions;
  if (!isObject(regressions)) {
    fail("Report field 'regressions' must be an object.");
  }
  const criticalOpen = Number(regressions.criticalOpen ?? 0);
  const highOpen = Number(regressions.highOpen ?? 0);
  if (!Number.isFinite(criticalOpen) || !Number.isFinite(highOpen) || criticalOpen < 0 || highOpen < 0) {
    fail('Report regressions criticalOpen/highOpen must be non-negative numeric values.');
  }

  const maxCriticalRegressions = Number(config.maxCriticalRegressions ?? 0);
  const maxHighRegressions = Number(config.maxHighRegressions ?? 0);
  if (!Number.isFinite(maxCriticalRegressions) || !Number.isFinite(maxHighRegressions)) {
    fail("Config fields 'maxCriticalRegressions' and 'maxHighRegressions' must be numeric.");
  }
  if (criticalOpen > maxCriticalRegressions) {
    fail(`Open critical regressions (${criticalOpen}) exceed allowed max (${maxCriticalRegressions}).`);
  }
  if (highOpen > maxHighRegressions) {
    fail(`Open high regressions (${highOpen}) exceed allowed max (${maxHighRegressions}).`);
  }

  if (!Array.isArray(report.suites) || report.suites.length === 0) {
    fail("Report field 'suites' must be a non-empty array.");
  }
  const suitesById = new Map();
  for (const suite of report.suites) {
    if (!isObject(suite)) {
      fail('Each report suite entry must be an object.');
    }
    const id = String(suite.id ?? '').trim();
    const status = String(suite.status ?? '').trim().toLowerCase();
    if (!id) {
      fail('Each report suite must include a non-empty id.');
    }
    if (!status) {
      fail(`Suite '${id}' is missing status.`);
    }
    if (suitesById.has(id)) {
      fail(`Duplicate suite id in report: '${id}'.`);
    }

    const suiteTotal = Number(suite.total ?? 0);
    const suitePassed = Number(suite.passed ?? 0);
    const suiteFailed = Number(suite.failed ?? 0);
    if (!Number.isFinite(suiteTotal) || suiteTotal < 0) {
      fail(`Suite '${id}' has invalid total value.`);
    }
    if (!Number.isFinite(suitePassed) || suitePassed < 0 || !Number.isFinite(suiteFailed) || suiteFailed < 0) {
      fail(`Suite '${id}' has invalid passed/failed values.`);
    }
    if (suitePassed + suiteFailed > suiteTotal) {
      fail(`Suite '${id}' is inconsistent: passed + failed exceeds total.`);
    }
    suitesById.set(id, { id, status });
  }

  const requiredSuites = Array.isArray(config.requiredSuites) ? config.requiredSuites : [];
  for (const rawRequirement of requiredSuites) {
    const requirement = suiteRequirementEntry(rawRequirement);
    const observed = suitesById.get(requirement.id);
    if (!observed) {
      fail(`Required eval suite is missing from report: '${requirement.id}'.`);
    }
    if (observed.status !== requirement.status) {
      fail(
        `Suite '${requirement.id}' status '${observed.status}' does not satisfy required status '${requirement.status}'.`
      );
    }
  }

  const requireEvidencePaths = config.requireEvidencePaths !== false;
  if (requireEvidencePaths) {
    if (!Array.isArray(report.evidence) || report.evidence.length === 0) {
      fail("Report field 'evidence' must be a non-empty array when requireEvidencePaths=true.");
    }
    for (const evidencePath of report.evidence) {
      const evidenceRel = String(evidencePath ?? '').trim();
      if (!evidenceRel) {
        fail('Eval evidence entries must be non-empty strings.');
      }
      if (isTemplatePlaceholder(evidenceRel)) {
        fail(`Eval evidence path contains unresolved placeholder: ${evidenceRel}`);
      }
      const evidenceAbs = path.resolve(rootDir, evidenceRel);
      if (!isWithinRoot(evidenceAbs)) {
        fail(`Eval evidence path escapes repository root: ${evidenceRel}`);
      }
      if (!(await exists(evidenceAbs))) {
        fail(`Eval evidence path does not exist: ${evidenceRel}`);
      }
    }
  }

  const continuityReportRel = String(config.continuityReportPath ?? '').trim();
  if (continuityReportRel) {
    const continuityReportAbs = path.join(rootDir, continuityReportRel);
    if (!(await exists(continuityReportAbs))) {
      fail(`Missing continuity eval report file: ${continuityReportRel}`);
    }
    const continuityReport = parseJson(await fs.readFile(continuityReportAbs, 'utf8'), continuityReportAbs);
    if (!isObject(continuityReport)) {
      fail('Continuity eval report must be a JSON object.');
    }
    const continuityGeneratedAt = toIsoDate(continuityReport.generatedAtUtc);
    if (!continuityGeneratedAt) {
      fail(`Continuity eval report generatedAtUtc is invalid: ${String(continuityReport.generatedAtUtc)}`);
    }
    const continuityAgeDays = daysBetween(continuityGeneratedAt, new Date());
    if (continuityAgeDays < 0) {
      fail(`Continuity eval report generatedAtUtc is in the future: ${String(continuityReport.generatedAtUtc)}`);
    }
    if (continuityAgeDays > maxAgeDays) {
      fail(`Continuity eval report is stale (${continuityAgeDays} days old, max ${maxAgeDays}).`);
    }
    const continuitySummary = continuityReport.summary;
    if (!isObject(continuitySummary)) {
      fail("Continuity eval report field 'summary' must be an object.");
    }
    const continuityPassRate = Number(continuitySummary.passRate);
    const continuityMinimumPassRate = Number(config.continuityMinimumPassRate ?? minimumPassRate);
    if (!Number.isFinite(continuityPassRate) || continuityPassRate < continuityMinimumPassRate) {
      fail(
        `Continuity eval passRate ${continuityPassRate.toFixed(3)} is below minimum ${continuityMinimumPassRate.toFixed(3)}.`
      );
    }
    validateSuites(
      continuityReport,
      Array.isArray(config.requiredContinuitySuites) ? config.requiredContinuitySuites : [],
      'continuity eval'
    );
  }

  const resilienceReportRel = String(config.resilienceReportPath ?? '').trim();
  if (resilienceReportRel) {
    const resilienceReportAbs = path.join(rootDir, resilienceReportRel);
    if (!(await exists(resilienceReportAbs))) {
      fail(`Missing resilience eval report file: ${resilienceReportRel}`);
    }
    const resilienceReport = parseJson(await fs.readFile(resilienceReportAbs, 'utf8'), resilienceReportAbs);
    if (!isObject(resilienceReport)) {
      fail('Resilience eval report must be a JSON object.');
    }
    const resilienceGeneratedAt = toIsoDate(resilienceReport.generatedAtUtc);
    if (!resilienceGeneratedAt) {
      fail(`Resilience eval report generatedAtUtc is invalid: ${String(resilienceReport.generatedAtUtc)}`);
    }
    const resilienceAgeDays = daysBetween(resilienceGeneratedAt, new Date());
    if (resilienceAgeDays < 0) {
      fail(`Resilience eval report generatedAtUtc is in the future: ${String(resilienceReport.generatedAtUtc)}`);
    }
    if (resilienceAgeDays > maxAgeDays) {
      fail(`Resilience eval report is stale (${resilienceAgeDays} days old, max ${maxAgeDays}).`);
    }
    const resilienceSummary = resilienceReport.summary;
    if (!isObject(resilienceSummary)) {
      fail("Resilience eval report field 'summary' must be an object.");
    }
    const resiliencePassRate = Number(resilienceSummary.passRate);
    const resilienceMinimumPassRate = Number(config.resilienceMinimumPassRate ?? minimumPassRate);
    if (!Number.isFinite(resiliencePassRate) || resiliencePassRate < resilienceMinimumPassRate) {
      fail(
        `Resilience eval passRate ${resiliencePassRate.toFixed(3)} is below minimum ${resilienceMinimumPassRate.toFixed(3)}.`
      );
    }
    validateSuites(
      resilienceReport,
      Array.isArray(config.requiredResilienceSuites) ? config.requiredResilienceSuites : [],
      'resilience eval'
    );
  }

  console.log(
    `[eval-verify] passed (age=${ageDays}d passRate=${passRate.toFixed(3)} suites=${report.suites.length} criticalOpen=${criticalOpen} highOpen=${highOpen}).`
  );
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack : String(error);
  fail(message);
});
