import test from 'node:test';
import assert from 'node:assert/strict';

import { extractProgramChildUnitDeclarations } from './plan-metadata.mjs';

test('extractProgramChildUnitDeclarations reads numbered remaining execution slices', () => {
  const declarations = extractProgramChildUnitDeclarations(`
## Remaining Execution Slices

### 1. Lifecycle Workbench, Availability Graph, And Smart Calendar
### 2. Execution Assist And Collaboration

## Recommended Implementation Order

### 1. Not A Child Unit
`);

  assert.deepEqual(
    declarations.map((entry) => ({
      sectionTitle: entry.sectionTitle,
      title: entry.title,
      planIdHint: entry.planIdHint
    })),
    [
      {
        sectionTitle: 'Remaining Execution Slices',
        title: 'Lifecycle Workbench, Availability Graph, And Smart Calendar',
        planIdHint: null
      },
      {
        sectionTitle: 'Remaining Execution Slices',
        title: 'Execution Assist And Collaboration',
        planIdHint: null
      }
    ]
  );
});

test('extractProgramChildUnitDeclarations reads portfolio unit plan-id hints', () => {
  const declarations = extractProgramChildUnitDeclarations(`
## 2026-2027 Portfolio Units

### PU-01 (Q2 2026): organizer-wizard-v2-step-ia-and-progress
### PU-02 (Q2 2026): organizer-wizard-v2-save-resume-center
`);

  assert.deepEqual(
    declarations.map((entry) => ({
      sectionTitle: entry.sectionTitle,
      title: entry.title,
      planIdHint: entry.planIdHint
    })),
    [
      {
        sectionTitle: '2026-2027 Portfolio Units',
        title: 'organizer-wizard-v2-step-ia-and-progress',
        planIdHint: 'organizer-wizard-v2-step-ia-and-progress'
      },
      {
        sectionTitle: '2026-2027 Portfolio Units',
        title: 'organizer-wizard-v2-save-resume-center',
        planIdHint: 'organizer-wizard-v2-save-resume-center'
      }
    ]
  );
});
