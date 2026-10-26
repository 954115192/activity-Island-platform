# ADR-0001: Product shape and ownership boundaries

## Status

Accepted

## Decision

Activity Island Platform is a layered cross-device product. The desktop shell presents state and short actions. Platform services own shared infrastructure. Official modules provide default user experiences. Extensions provide personal integrations. The workbench handles dense tasks.

## Why

Notification ingestion, device trust, connection lifecycle, permissions, and reliable file transfer are shared responsibilities. Giving each feature or extension its own implementation would duplicate state, weaken security boundaries, and make recovery inconsistent.

The island is valuable because it is a presentation and interruption surface. It should not become the owner of every source adapter or protocol.

## Consequences

Positive:

- Core experiences work without installing extensions.
- Device and transfer state has one owner.
- Permissions can be reviewed and revoked consistently.
- Extensions can add value without reimplementing infrastructure.
- Services can be tested with fakes and restarted independently.

Trade-offs:

- Platform contracts require more design before UI work.
- Official modules and extensions need distinct lifecycle and permission rules.
- Some operating-system capabilities will remain platform-specific.

## Rejected alternatives

### One large application with feature code in the shell

Rejected because the shell would accumulate OS integration, connection state, storage, and product UI in one failure domain.

### Every feature implemented as an extension

Rejected because shared device, notification, and transfer infrastructure would be duplicated and permissions would be difficult to reason about.

### A backend-first cloud product

Rejected for the initial product because the primary value is local, low-latency desktop and phone interaction. A relay can be evaluated later as an explicit capability.

