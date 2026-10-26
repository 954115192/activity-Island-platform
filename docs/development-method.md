# Development Method

## Work from vertical slices

Each feature must cross the full product path before it is considered useful:

```text
source adapter → platform service → permission check → event router
→ official module → island/workbench presentation → recovery path
```

Do not build a large collection of adapters or UI screens without completing one end-to-end journey.

## Contract-first development

Before implementing a service:

1. Define input and output types.
2. Define lifecycle states.
3. Define structured errors.
4. Define permission requirements.
5. Define idempotency and retry behavior.
6. Add a fake implementation for tests.

The fake implementation is a required development tool. It lets the shell and official modules progress without a physical phone or a particular Windows state.

## Module rules

Official modules may use platform services and render on all supported surfaces. They must remain replaceable at the UI level and must not hide state transitions inside view-only code.

Extensions may use only the public SDK. Any new platform capability must be added to a contract package first, then implemented by the platform service, then exposed through the SDK.

## Testing layers

### Contract tests

Verify event envelopes, versions, capability checks, and structured errors.

### Service tests

Verify normalization, state machines, retries, cleanup, deduplication, and permission behavior with fake adapters.

### Integration tests

Verify service composition, storage, event routing, and renderer boundaries.

### End-to-end tests

Verify the user journeys: notification arrival, pairing, transfer, cancellation, reconnect, and revocation.

### Manual verification

Use real Windows notifications and at least one physical Android device before a release that changes those paths. Record the OS version, phone version, network type, and permission state.

## Change policy

- Keep changes scoped to one domain.
- Prefer additive contract changes.
- Do not put feature logic in the desktop process entry point.
- Do not introduce an extension-only workaround for a missing platform service.
- Every new persisted field needs a migration or an explicit version gate.
- Every new sensitive field needs a retention and redaction decision.

## Definition of done

A change is complete when:

- The contract is documented and versioned.
- Permission behavior is explicit.
- Failure and recovery states are represented.
- The affected unit, integration, and end-to-end checks pass.
- The feature is observable in the island or workbench where appropriate.
- Logs contain identifiers and state, not private content by default.
- The user can disable or revoke the feature when it handles personal data.

