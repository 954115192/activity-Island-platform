# Delivery Roadmap

## Release 0.1 — foundation

Outcome: a runnable shell with stable contracts and no feature-specific coupling.

- Define domain event envelopes and error types.
- Define device, permission, notification, and transfer interfaces.
- Establish desktop shell lifecycle and surface states.
- Add service startup, shutdown, health, and diagnostic hooks.
- Add contract tests and a local fake service environment.

Exit criteria: the shell can display a fake notification and a fake transfer state through the same interfaces that production services will use.

## Release 0.2 — Windows notification path

Outcome: the first real product loop.

- Integrate the Windows notification adapter.
- Normalize source, title, content summary, timestamp, and supported actions.
- Add deduplication and bounded history.
- Add application-level filters and pause controls.
- Ship the notification module in the island and workbench.

Exit criteria: a real Windows notification appears once, can be inspected, and can open its source without destabilizing the shell.

## Release 0.3 — device identity and pairing

Outcome: the desktop can establish a trusted relationship with a phone.

- Implement one-time pairing code or QR flow.
- Store a revocable device record.
- Add authenticated local-network sessions.
- Add online, offline, reconnecting, and unavailable states.
- Add device management in settings and workbench.

Exit criteria: a user can pair, restart both apps, reconnect, and revoke the device.

## Release 0.4 — file transfer

Outcome: reliable two-way local-network transfer.

- Define transfer session and chunk protocol.
- Add approval, progress, cancellation, checksum verification, and retry.
- Add managed temporary storage and cleanup.
- Add transfer module in the island and workbench.

Exit criteria: a transfer survives a temporary disconnect or reports a recoverable failure with a retry action.

## Release 0.5 — phone notification mirror

Outcome: selected phone notifications can appear on the desktop.

- Add phone notification access and local filters.
- Add desktop privacy filters.
- Add stable source and event identity for deduplication.
- Add mute, application policy, and content visibility controls.
- Add supported source actions where the phone platform permits them.

Exit criteria: users can choose exactly which phone notification categories reach the desktop.

## Release 0.6 — extension platform

Outcome: third-party development uses safe, stable platform contracts.

- Publish extension manifest and capability model.
- Add SDK clients for notifications, devices, transfers, and presentation.
- Add simulators for local development.
- Add installation review, permission prompts, logs, and compatibility checks.

Exit criteria: an extension can use an approved transfer or notification subscription without managing the underlying connection.

## Release 1.0 — durable daily product

- Harden upgrades and data migration.
- Add service isolation and crash recovery.
- Add accessibility and reduced-motion coverage.
- Add privacy export and deletion controls.
- Add release telemetry that excludes content by default.
- Document support policy and compatibility guarantees.

## Deliberately deferred

- Public extension marketplace.
- Internet relay or cloud storage replacement.
- Full phone screen mirroring.
- Full messaging client.
- Broad automation language.

