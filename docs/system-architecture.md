# System Architecture

## Topology

```text
┌──────────────────────── Desktop Application ────────────────────────┐
│ Desktop Shell                                                        │
│  island window · interaction priority · presentation lifecycle       │
│                                                                     │
│ Official Modules            Workbench                               │
│  notifications · devices    history · search · settings             │
│  transfers · device state                                          │
│                                                                     │
│ Platform Services                                                    │
│  notification adapter · device registry · connection manager         │
│  transfer engine · permissions · event router · platform storage     │
└──────────────────────────────┬──────────────────────────────────────┘
                               │ authenticated device session
                         ┌─────▼─────┐
                         │ Phone App │
                         │ auth · filters · send/receive · settings
                         └───────────┘
```

## Architectural layers

### Desktop shell

Owns windows, island geometry, interaction state, animation, presentation priority, lifecycle, and accessibility of the desktop surface. It does not own notification parsing, transfer protocol details, or device secrets.

### Platform services

Own shared stateful mechanisms:

- `NotificationService` adapts operating-system notifications into normalized events.
- `DeviceService` handles discovery, pairing, identity, connection state, and reconnection.
- `TransferService` manages sessions, chunks, checksums, cancellation, resume, and cleanup.
- `PermissionService` evaluates grants, prompts, and revocation.
- `EventRouter` delivers typed events to approved consumers.
- `PlatformStorage` persists device records, policy, event history, and transfer metadata.

Each service has a typed interface, a lifecycle, structured errors, and observable state. Services must be restartable without forcing the island window to restart.

### Official modules

Official modules compose platform services into user-facing experiences. They may render in the island, the settings surface, and the workbench. They do not bypass permission checks or reach into another module's private state.

### Extensions

Extensions run against a versioned public SDK. They can subscribe to approved events and request approved actions. They cannot own the device connection, read all platform storage, or inject arbitrary events into the global router.

## Domain event envelope

All cross-service events use a common envelope:

```ts
type DomainEvent<T> = {
  eventId: string
  type: string
  version: number
  occurredAt: string
  source: 'desktop' | 'phone' | 'platform' | 'module' | 'extension'
  subject?: string
  sensitivity: 'public' | 'private' | 'sensitive'
  payload: T
}
```

Consumers must be idempotent by `eventId`. Sensitive payloads are only delivered when the consumer has a matching grant.

## Device model

The platform distinguishes a stable device identity from an active connection:

- **Device identity** is the user-approved record and public metadata.
- **Pairing** establishes trust and stores a revocable relationship.
- **Connection** is a temporary online session.
- **Capability grant** determines what this device may exchange.

The island and modules consume device state; they do not create independent socket sessions.

## Transfer model

A transfer is a durable session with a lifecycle:

```text
created → awaiting-approval → active → verifying → completed
                                  └──────────────→ failed
created / active / failed → cancelled
```

Every transfer has a session ID, source, destination, item metadata, progress, checksum state, and error information. Partial files live in managed temporary storage and are removed according to a cleanup policy.

## Privacy model

Permissions are scoped by consumer, device, resource, and sensitivity. Examples:

- notification metadata
- notification content
- device list
- transfer creation
- transfer content access

The default is deny for sensitive data. Revocation stops future delivery and invalidates active operations where practical.

## Failure model

The platform treats connection loss, permission denial, unavailable source applications, malformed events, and partial transfers as expected states. Each produces a typed error and a user-visible recovery path. A module failure must not terminate the desktop shell.

