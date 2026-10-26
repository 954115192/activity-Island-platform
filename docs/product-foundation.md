# Product Foundation

## Product definition

Activity Island Platform is a cross-device information and action surface. It connects a Windows desktop and a user's phone, turns important events into glanceable updates, and keeps short actions close to the user's current context.

The product is deliberately smaller than a full desktop suite and larger than a visual widget. Its job is to make an event or task understandable within seconds and actionable within a few interactions.

## User problems

Users repeatedly switch between notification centers, messaging devices, file windows, and status panels to answer small questions:

- What just happened?
- Does this need a response?
- Is my phone connected?
- Can I move this file to my other device?
- Did the transfer finish?

The product answers these questions from one low-distraction surface while keeping detailed work in a larger workbench.

## Core experience

### Glance

The island shows one concise fact: a notification, device state, transfer progress, or task result.

### Inspect

The user expands the island to see context, history, and the primary action.

### Act

The user performs a short action such as open, dismiss, pause, retry, accept, send, or switch device.

### Continue

The user can move to a full workbench when the task needs search, configuration, batching, or history.

## Product principles

1. **Glance before density.** The island communicates one current fact before it exposes detail.
2. **Platform before duplication.** Shared mechanisms are implemented once and exposed through contracts.
3. **Official paths before configuration.** Core capabilities work after installation and permission setup.
4. **Least privilege by default.** Access to notification content, devices, and files is explicit and revocable.
5. **Recoverable operations.** Connection and transfer failures have a visible state and a next action.
6. **Extensions add value without owning infrastructure.** Extensions use platform services instead of replacing them.
7. **The workbench absorbs complexity.** The island remains lightweight even when the product grows.

## Product surfaces

| Surface | Purpose | Typical duration |
|---|---|---:|
| Island | Notice and perform a short action | Seconds |
| Desktop settings | Configure permissions, modules, devices, and extensions | Minutes |
| Workbench | Search, review, batch, and manage | Minutes to hours |
| Phone app | Authorize, send, receive, and mirror selected events | Seconds to minutes |

## Core user journeys

### Desktop notification

1. A Windows notification arrives.
2. The platform normalizes it and assigns an event identity.
3. The notification module requests an island alert.
4. The user reads the summary or expands it.
5. The user opens the source, dismisses the item, or leaves it in history.

### File transfer

1. The user selects a paired device.
2. The platform creates a transfer session.
3. The receiving device confirms when required.
4. The island shows progress and the workbench shows the queue.
5. The transfer completes, can be opened, or can be retried after failure.

### Phone notification mirror

1. The phone app receives an allowed notification.
2. The phone applies its local privacy and application filters.
3. The desktop applies its own display policy.
4. The event appears with a device source and stable deduplication identity.
5. The user can mute, open, or manage the source according to supported actions.

## Non-goals

The initial product does not attempt to replace a messaging client, cloud drive, phone launcher, remote desktop, or general automation platform. It does not promise unrestricted access to every notification or every mobile operating system capability.

