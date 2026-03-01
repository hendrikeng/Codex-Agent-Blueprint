# Placeholder Contract

Replace all `{{...}}` tokens in this template before first merge.

## Required Core Placeholders

- `{{PRODUCT}}`
- `{{SUMMARY}}`
- `{{DOC_OWNER}}`
- `{{LAST_UPDATED_ISO_DATE}}`
- `{{CURRENT_STATE_DATE}}`
- `{{SCOPE1}}`, `{{SCOPE2}}`, `{{SCOPE3}}`

## Architecture/Stack Placeholders

- `{{FRONTEND_STACK}}`
- `{{BACKEND_STACK}}`
- `{{DATA_STACK}}`
- `{{SHARED_CONTRACT_STRATEGY}}`
- `{{FRONTEND_ENTRYPOINT_1}}`, `{{FRONTEND_ENTRYPOINT_2}}`
- `{{BACKEND_ENTRYPOINT_1}}`, `{{BACKEND_ENTRYPOINT_2}}`

## Invariant/Security Placeholders

- `{{CRITICAL_DOMAIN_SET}}`
- `{{SERVER_AUTHORITY_BOUNDARY_SET}}`
- `{{MONEY_AND_NUMERIC_RULE}}`
- `{{DOMAIN_INVARIANT_AREA_1..3}}`
- `{{DOMAIN_INVARIANT_1A..3B}}`
- `{{CRITICAL_FLOW_1..3}}`

## Quality Placeholders

- `{{SCORE_DOMAIN_CORRECTNESS}}`
- `{{SCORE_CRITICAL_SAFETY}}`
- `{{SCORE_AUTHZ_BOUNDARIES}}`
- `{{SCORE_ARCH_BOUNDARIES}}`
- `{{SCORE_DOC_GOVERNANCE}}`
- `{{SCORE_CRITICAL_TESTS}}`
- `{{QUALITY_GAP_1}}`, `{{QUALITY_GAP_2}}`

## Governance/Architecture Rule Placeholders

- `{{ESLINT_CONFIG_PATH}}`
- `{{SOURCE_TAG_1}}`, `{{SOURCE_TAG_2}}`
- `{{ALLOWED_TARGET_TAG_1A}}`, `{{ALLOWED_TARGET_TAG_1B}}`
- `{{ALLOWED_TARGET_TAG_2A}}`, `{{ALLOWED_TARGET_TAG_2B}}`
- `{{PROJECT_JSON_PATH_1}}`, `{{PROJECT_JSON_PATH_2}}`
- `{{PROJECT_REQUIRED_TAG_1}}`, `{{PROJECT_REQUIRED_TAG_2}}`

## Ownership/Approval Placeholders

- `{{CODEOWNERS_DEFAULT_TEAM}}` (default owner for repository paths, e.g. `@org/platform-engineering`)
- `{{CODEOWNERS_SECURITY_TEAM}}` (security approver for sensitive paths, e.g. `@org/security-ops`)

## Conformance Artifact Placeholders

- `{{GENERATED_AT_UTC_ISO}}`
- `{{CONFORMANCE_SOURCE}}`
- `{{REPOSITORY_PROFILE_SNAKE_CASE}}`
- `{{CONFORMANCE_PURPOSE}}`
- `{{OUT_OF_SCOPE_ITEM_1..3}}`
- `{{CI_WORKFLOW_PATH}}`

## Recommended Defaults

Use these defaults unless the product domain clearly does not apply:

- `{{CRITICAL_DOMAIN_SET}}`: `auth, tenant boundaries, lifecycle transitions, money (if applicable)`
- `{{SERVER_AUTHORITY_BOUNDARY_SET}}`: `auth decisions, lifecycle transitions, inventory/state mutation, billing/credits`
- `{{MONEY_AND_NUMERIC_RULE}}`: `Use fixed-point/minor-unit math for financial values; no floating-point money math.`
- `{{DOMAIN_INVARIANT_AREA_1}}`: `Auth and tenant boundaries`
- `{{DOMAIN_INVARIANT_AREA_2}}`: `Lifecycle/state transitions`
- `{{DOMAIN_INVARIANT_AREA_3}}`: `Financial/accounting behavior (if applicable)`

If a domain does not use billing/credits/payments, keep the placeholder explicit with `not applicable` and remove money-specific rules from runtime code/docs.

- `{{CODEOWNERS_DEFAULT_TEAM}}`: `@your-org/platform-engineering`
- `{{CODEOWNERS_SECURITY_TEAM}}`: `@your-org/security-ops`

## Validation Command

Run this command in the initialized repository; result must be empty:

```bash
./scripts/check-template-placeholders.sh
```
