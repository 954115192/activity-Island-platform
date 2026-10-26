# Functional Boundaries

## Ownership matrix

| Area | Owner | Public to extensions? |
|---|---|---|
| Island window and geometry | Desktop shell | No |
| Presentation priority and interruption | Desktop shell | Request API only |
| Operating-system notification ingestion | Notification service | Subscribe through permission |
| Notification history | Notification service | Filtered query API |
| Device pairing and identity | Device service | Managed actions only |
| Connection and reconnect | Device service | Status subscription only |
| Transfer protocol | Transfer service | Create/query/cancel API |
| Permission decisions | Permission service | Request and status API |
| Official notification experience | Notification module | N/A |
| Official phone experience | Device module | N/A |
| Official transfer experience | Transfer module | N/A |
| Search, history, and batch work | Workbench | N/A |
| User integrations and automation | Extensions | Yes, within grants |

## What belongs in the desktop shell

- Window lifecycle.
- Island state and animation.
- Input routing and hit testing.
- Presentation arbitration.
- Rendering host and module lifecycle.
- Surface-level accessibility and reduced-motion behavior.

The shell receives facts and intents. It should not parse notification provider payloads or implement transfer chunks.

## What belongs in platform services

- Identity and authorization.
- OS integration.
- Device sessions.
- Transfer reliability.
- Event normalization and routing.
- Persistence and retention.
- Metrics, diagnostics, and structured errors.

Platform services are reusable infrastructure. They expose capabilities through contracts rather than exposing implementation objects.

## What belongs in official modules

Official modules own the product decisions that a user sees:

- Which summary is shown in a small island view.
- Which primary action appears in an expanded view.
- How notification history is grouped.
- How a transfer is selected, confirmed, paused, and retried.
- Which device controls belong in settings or the workbench.

## What belongs in extensions

Extensions are for user-specific value:

- External service integrations.
- Timers, trackers, and status cards.
- Personal notification rules.
- Shortcuts that use an approved platform action.
- Domain-specific dashboards.

Extensions are not a replacement for the platform's device, permission, or transfer infrastructure.

## Capability examples

```text
notifications.read:metadata
notifications.read:content
notifications.query:history
devices.read:list
devices.read:status
transfers.create
transfers.read:own
transfers.cancel:own
```

Capabilities should remain narrow enough that a user can understand the grant on a settings screen.

## API boundary rules

1. No UI surface imports another layer's private implementation.
2. No extension receives an unfiltered global event stream.
3. No module opens a second connection to a paired device.
4. No service returns raw credentials or private keys to a renderer.
5. All asynchronous actions return a request or session ID.
6. All public contracts include versioning and structured errors.

