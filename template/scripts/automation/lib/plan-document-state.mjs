import fs from 'node:fs/promises';
import path from 'node:path';
import {
  collectUnfinishedCoverageRows,
  metadataValue,
  normalizeStatus,
  parseMetadata,
  setMetadataFields
} from './plan-metadata.mjs';
import { implementationTargetRoots } from './plan-scope.mjs';
import {
  escapeRegex,
  nowIso,
  resolveSafeRepoPath
} from './orchestrator-shared.mjs';

export const MUST_LAND_SECTION = 'Must-Land Checklist';

function isProgramPlan(plan) {
  return String(plan?.executionScope ?? '').trim().toLowerCase() === 'program';
}

function isProductPlan(plan) {
  return String(plan?.deliveryClass ?? '').trim().toLowerCase() === 'product';
}

export function sectionBounds(content, sectionTitle) {
  const headingRegex = new RegExp(`^##\\s+${escapeRegex(sectionTitle)}\\s*$`, 'm');
  const match = headingRegex.exec(content);
  if (!match) {
    return null;
  }

  const start = match.index;
  const headingEnd = content.indexOf('\n', start);
  const bodyStart = headingEnd === -1 ? content.length : headingEnd + 1;
  const remaining = content.slice(bodyStart);
  const nextHeading = /^##\s+/m.exec(remaining);
  const end = nextHeading ? bodyStart + nextHeading.index : content.length;
  return { start, bodyStart, end };
}

export function sectionBody(content, sectionTitle) {
  const bounds = sectionBounds(content, sectionTitle);
  if (!bounds) {
    return '';
  }
  return content.slice(bounds.bodyStart, bounds.end).trim();
}

export function upsertSection(content, sectionTitle, bodyLines) {
  const body = Array.isArray(bodyLines) ? bodyLines.join('\n') : String(bodyLines ?? '');
  const rendered = `## ${sectionTitle}\n\n${body.trim()}\n`;
  const bounds = sectionBounds(content, sectionTitle);

  if (!bounds) {
    return `${content.trimEnd()}\n\n${rendered}\n`;
  }

  const before = content.slice(0, bounds.start).trimEnd();
  const after = content.slice(bounds.end).trimStart();
  if (!after) {
    return `${before}\n\n${rendered}\n`;
  }
  return `${before}\n\n${rendered}\n${after}`.replace(/\n{3,}/g, '\n\n');
}

export function removeSection(content, sectionTitle) {
  const bounds = sectionBounds(content, sectionTitle);
  if (!bounds) {
    return content;
  }

  const before = content.slice(0, bounds.start).trimEnd();
  const after = content.slice(bounds.end).trimStart();
  if (!before && !after) {
    return '';
  }
  if (!before) {
    return `${after}\n`;
  }
  if (!after) {
    return `${before}\n`;
  }
  return `${before}\n\n${after}`.replace(/\n{3,}/g, '\n\n');
}

export function sectionlessPreamble(content) {
  const firstSectionIndex = content.search(/^##\s+/m);
  if (firstSectionIndex === -1) {
    return content.trimEnd();
  }
  return content.slice(0, firstSectionIndex).trimEnd();
}

export function appendToDeliveryLog(content, entryLine) {
  const sectionTitle = 'Automated Delivery Log';
  const body = sectionBody(content, sectionTitle);
  const lines = body ? body.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) : [];
  lines.push(`- ${entryLine}`);
  return upsertSection(content, sectionTitle, lines);
}

export function normalizeBulletSection(content, sectionTitle) {
  const body = sectionBody(content, sectionTitle);
  if (!body) {
    return content;
  }

  const lines = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '));
  const unique = [];
  const seen = new Set();
  for (const line of lines) {
    if (seen.has(line)) {
      continue;
    }
    seen.add(line);
    unique.push(line);
  }

  if (unique.length === 0) {
    return content;
  }
  return upsertSection(content, sectionTitle, unique);
}

export function removeDuplicateSections(content, sectionTitle) {
  let updated = content;
  while (true) {
    const first = sectionBounds(updated, sectionTitle);
    if (!first) {
      return updated;
    }
    const rest = updated.slice(first.end);
    const second = sectionBounds(rest, sectionTitle);
    if (!second) {
      return updated;
    }

    const secondStart = first.end + second.start;
    const secondEnd = first.end + second.end;
    const before = updated.slice(0, secondStart).trimEnd();
    const after = updated.slice(secondEnd).trimStart();
    updated = after ? `${before}\n\n${after}` : `${before}\n`;
  }
}

export function normalizeClosureSection(content) {
  const body = sectionBody(content, 'Closure');
  if (!body) {
    return content;
  }

  const lines = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '));

  const seenKeys = new Set();
  const seenLines = new Set();
  const kept = [];
  for (const line of lines) {
    const keyMatch = line.match(/^- ([^:]+):/);
    if (keyMatch) {
      const key = keyMatch[1].trim().toLowerCase();
      if (seenKeys.has(key)) {
        continue;
      }
      seenKeys.add(key);
      let normalizedLine = line;
      if (key === 'completed at') {
        const rawValue = line.replace(/^- Completed At:\s*/, '').trim();
        if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?$/.test(rawValue)) {
          normalizedLine = `- Completed At: ${rawValue}Z`;
        }
      }
      kept.push(normalizedLine);
      continue;
    }

    if (seenLines.has(line)) {
      continue;
    }
    seenLines.add(line);
    kept.push(line);
  }

  if (kept.length === 0) {
    return content;
  }
  return upsertSection(content, 'Closure', kept);
}

export function updateSimpleMetadataField(content, field, value) {
  const regex = new RegExp(`^${escapeRegex(field)}:\\s*.*$`, 'm');
  if (regex.test(content)) {
    return content.replace(regex, `${field}: ${value}`);
  }
  return `${content.trimEnd()}\n${field}: ${value}\n`;
}

export function setPlanDocumentFields(content, fields = {}) {
  let updated = setMetadataFields(content, fields);
  if (Object.prototype.hasOwnProperty.call(fields, 'Status')) {
    updated = updateSimpleMetadataField(updated, 'Status', fields.Status);
  }
  if (Object.prototype.hasOwnProperty.call(fields, 'Validation-Ready')) {
    updated = updateSimpleMetadataField(updated, 'Validation-Ready', fields['Validation-Ready']);
  }
  return updated;
}

export function documentStatusValue(content) {
  const metadata = parseMetadata(content);
  const metadataStatus = normalizeStatus(metadataValue(metadata, 'Status'));
  if (metadataStatus) {
    return metadataStatus;
  }
  const match = content.match(/^Status:\s*(.+)$/m);
  return normalizeStatus(match?.[1] ?? '');
}

export function documentValidationReadyValue(content) {
  const metadata = parseMetadata(content);
  const value = normalizeStatus(metadataValue(metadata, 'Validation-Ready'));
  if (value === 'yes' || value === 'host-required-only' || value === 'no') {
    return value;
  }
  return '';
}

export function completionGateReadyForValidation(documentStatus, validationReady = '') {
  if (documentStatus === 'completed') {
    return true;
  }
  if (documentStatus !== 'validation') {
    return false;
  }
  return validationReady === 'yes' || validationReady === 'host-required-only';
}

export function nextStepChecklistLines(content) {
  const body = sectionBody(content, 'Next-Step Checklist');
  if (!body) {
    return [];
  }

  return body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => /^\d+\.\s+/.test(line) || line.startsWith('- '));
}

export function mustLandChecklistLines(content) {
  const body = sectionBody(content, MUST_LAND_SECTION);
  if (!body) {
    return [];
  }

  return body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^-\s+\[[ xX]\]\s+/.test(line));
}

export function mustLandChecklistHasOpenItems(content) {
  return mustLandChecklistLines(content).some((line) => /^-\s+\[\s\]\s+/.test(line));
}

export function nextStepChecklistIsHostValidationOnly(lines) {
  if (!Array.isArray(lines) || lines.length === 0) {
    return false;
  }

  return lines.every((line) => {
    const lower = line.toLowerCase();
    const referencesHostValidation =
      lower.includes('host validation') ||
      lower.includes('host-required') ||
      lower.includes('host required') ||
      lower.includes('host lane') ||
      lower.includes('validation lane');
    const closeAfterHost =
      lower.includes('status: completed') ||
      lower.includes('status `completed`') ||
      lower.includes('set plan') ||
      lower.includes('reviewer closeout');
    const mentionsOpenImplementation =
      lower.includes('worker follow-up') ||
      lower.includes('worker remediation') ||
      lower.includes('reviewer follow-up') ||
      lower.includes('reviewer re-check') ||
      lower.includes('implementation') ||
      lower.includes('code edit') ||
      lower.includes('source edit') ||
      lower.includes('test edit');

    if (mentionsOpenImplementation) {
      return false;
    }
    if (referencesHostValidation) {
      return true;
    }
    return closeAfterHost && lower.includes('host');
  });
}

export function sessionSignalsHostValidationOnly(sessionResult) {
  const text = `${sessionResult?.summary ?? ''}\n${sessionResult?.reason ?? ''}`.toLowerCase();
  if (!text.trim()) {
    return false;
  }

  const mentionsHostValidation =
    text.includes('host validation') || text.includes('host-required') || text.includes('host required');
  const saysOnlyGate =
    text.includes('only remaining') ||
    text.includes('only closeout gate') ||
    text.includes('only remaining completion gate') ||
    text.includes('sole gate') ||
    (text.includes('remaining') && text.includes('host') && text.includes('only'));
  const mentionsFurtherImplementation =
    text.includes('worker follow-up') ||
    text.includes('worker remediation') ||
    text.includes('reviewer follow-up') ||
    text.includes('implementation remains') ||
    text.includes('another worker session') ||
    text.includes('pending implementation');

  return mentionsHostValidation && saysOnlyGate && !mentionsFurtherImplementation;
}

export async function setPlanStatus(planPath, status, dryRun) {
  const content = await fs.readFile(planPath, 'utf8');
  const updated = setPlanDocumentFields(content, { Status: status });
  if (!dryRun) {
    await fs.writeFile(planPath, updated, 'utf8');
  }
  return updated;
}

export async function setResidualValidationBlockersSection(planPath, failedResult, reason, dryRun) {
  if (dryRun) {
    return;
  }
  const content = await fs.readFile(planPath, 'utf8');
  const lines = [
    '- Status: residual-external',
    `- Updated At: ${nowIso()}`,
    `- Validation ID: ${failedResult?.validationId ?? 'unknown'}`,
    `- Reason: ${reason}`,
    `- Finding Files: ${
      Array.isArray(failedResult?.findingFiles) && failedResult.findingFiles.length > 0
        ? failedResult.findingFiles.join(', ')
        : 'none'
    }`
  ];
  const updated = upsertSection(content, 'Residual Validation Blockers', lines);
  await fs.writeFile(planPath, updated, 'utf8');
}

export async function setHostValidationSection(planPath, status, provider, reason, dryRun) {
  if (dryRun) {
    return;
  }
  const content = await fs.readFile(planPath, 'utf8');
  const lines = [
    `- Status: ${status}`,
    `- Provider: ${provider || 'unknown'}`,
    `- Updated At: ${nowIso()}`,
    `- Reason: ${reason || 'none'}`
  ];
  let updated = upsertSection(content, 'Host Validation', lines);
  if (normalizeStatus(status) === 'passed') {
    updated = removeSection(updated, 'Remaining Validation Work (Host Required)');
  }
  await fs.writeFile(planPath, updated, 'utf8');
}

export async function maybeAutoPromoteCompletionGate(planPath, currentRole, sessionResult, options) {
  if (String(currentRole ?? '').trim().toLowerCase() !== 'reviewer') {
    return { promoted: false, reason: null };
  }

  const content = await fs.readFile(planPath, 'utf8');
  const unfinishedCoverageRows = collectUnfinishedCoverageRows(content);
  if (unfinishedCoverageRows.length > 0) {
    return { promoted: false, reason: null };
  }
  const status = documentStatusValue(content);
  const validationReady = documentValidationReadyValue(content);
  if (completionGateReadyForValidation(status, validationReady)) {
    return { promoted: false, reason: null };
  }

  if (validationReady === 'no') {
    return { promoted: false, reason: null };
  }
  if (validationReady === 'yes' || validationReady === 'host-required-only') {
    await setPlanStatus(planPath, 'validation', options.dryRun);
    return {
      promoted: true,
      reason:
        validationReady === 'host-required-only'
          ? "Plan metadata 'Validation-Ready: host-required-only' indicates host validation is the sole gate."
          : "Plan metadata 'Validation-Ready: yes' indicates implementation is complete for validation."
    };
  }

  const checklistHostOnly = nextStepChecklistIsHostValidationOnly(nextStepChecklistLines(content));
  const sessionHostOnly = sessionSignalsHostValidationOnly(sessionResult);
  if (!checklistHostOnly && !sessionHostOnly) {
    return { promoted: false, reason: null };
  }

  if (!options.dryRun) {
    const updatedPlan = setPlanDocumentFields(content, {
      Status: 'validation',
      'Validation-Ready': 'host-required-only'
    });
    await fs.writeFile(planPath, updatedPlan, 'utf8');
  }
  return {
    promoted: true,
    reason: checklistHostOnly
      ? 'Next-step checklist indicates host validation is the only remaining gate.'
      : 'Reviewer session result indicates host validation is the only remaining gate.'
  };
}

export async function evaluateCompletionGate(plan, rootDir, state = null, dependencies = {}) {
  const content = await fs.readFile(plan.filePath, 'utf8');
  const documentStatus = documentStatusValue(content);
  const validationReady = documentValidationReadyValue(content);
  const implementationEvidencePaths =
    typeof dependencies.implementationEvidencePaths === 'function'
      ? dependencies.implementationEvidencePaths
      : () => [];

  if (!plan.deliveryClass) {
    return {
      ready: false,
      reason:
        "Plan is missing 'Delivery-Class'. Declare whether the plan is product, docs, ops, or reconciliation before validation/completion."
    };
  }

  if (!plan.executionScope) {
    return {
      ready: false,
      reason:
        "Plan is missing 'Execution-Scope'. Declare whether the plan is an executable slice or a non-executable program before validation/completion."
    };
  }

  if (isProgramPlan(plan)) {
    return {
      ready: false,
      reason:
        'Program plans are non-executable parent contracts. Keep the parent active, complete child slices first, and close the parent only after scope reconciliation is done.'
    };
  }

  if (completionGateReadyForValidation(documentStatus, validationReady)) {
    const mustLandLines = mustLandChecklistLines(content);
    if (mustLandLines.length === 0) {
      return {
        ready: false,
        reason:
          "Plan is missing executable scope. Add '## Must-Land Checklist' with markdown checkbox items before validation/completion."
      };
    }

    if (mustLandChecklistHasOpenItems(content)) {
      return {
        ready: false,
        reason:
          "Plan still has unchecked items in '## Must-Land Checklist'. Keep the plan in-progress until every must-land deliverable is complete."
      };
    }

    if (isProductPlan(plan)) {
      const unfinishedCoverageRows = collectUnfinishedCoverageRows(content);
      if (unfinishedCoverageRows.length > 0) {
        const preview = unfinishedCoverageRows
          .slice(0, 3)
          .map((entry) => `${entry.capability}='${entry.status}'`)
          .join(', ');
        return {
          ready: false,
          reason:
            `Plan still records unfinished current-status rows in '${unfinishedCoverageRows[0].sectionTitle}' (${preview}). ` +
            'Keep the plan in-progress until those capabilities are implemented in product code or split into separate executable follow-on plans.'
        };
      }

      const targetRoots = implementationTargetRoots(plan, { sourceOnly: true });
      if (targetRoots.length === 0) {
        return {
          ready: false,
          reason:
            "Product slice plans must declare at least one source-code 'Implementation-Targets' root before validation/completion."
        };
      }

      const implementationTouches = implementationEvidencePaths(state, plan, rootDir);
      if (implementationTouches.length === 0) {
        const targetPreview = targetRoots.slice(0, 4).join(', ');
        return {
          ready: false,
          reason:
            `Plan declares product implementation roots via Implementation-Targets (${targetPreview}) but no durable source implementation evidence has been recorded under those roots. ` +
            'Keep the plan in-progress until worker sessions land shipped product changes under the declared source paths.'
        };
      }
    }

    return { ready: true, reason: null };
  }

  if (documentStatus === 'validation') {
    return {
      ready: false,
      reason:
        "Plan status is 'validation' but Validation-Ready is not explicit. Keep the plan in-progress until reviewer closeout sets `Validation-Ready: yes` or `Validation-Ready: host-required-only`."
    };
  }

  return {
    ready: false,
    reason:
      'Plan is not ready for validation. Set top-level `Status: validation` (preferred) or `Status: completed` when implementation is done and validation can run.'
  };
}

export async function updateProductSpecMetadata(targetPath, dateStamp) {
  const currentStatePath = path.posix.normalize('docs/product-specs/CURRENT-STATE.md');
  const normalizedTarget = path.posix.normalize(targetPath);
  if (normalizedTarget !== currentStatePath) {
    return null;
  }
  return {
    'Last Updated': dateStamp,
    'Current State Date': dateStamp
  };
}

export async function resolveSpecTarget(rootDir, planId, target) {
  return resolveSafeRepoPath(rootDir, target, `Spec target for plan '${planId}'`);
}
