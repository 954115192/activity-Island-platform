# Activity Island Platform

Activity Island Platform is a desktop-first information and action platform for Windows and mobile devices.

It gives users a quiet, glanceable surface for notifications, device state, transfers, and short actions. A desktop island is the primary presentation surface. A companion phone application provides the second device endpoint. A platform service layer owns connection, permissions, event routing, and transfer reliability. Official modules provide the default product experience. Extensions add personal workflows and integrations.

## Product promise

The product makes important events visible without opening a large application and makes common cross-device actions short enough to complete from the island.

The product is organized around five responsibilities:

- **Desktop shell** presents information and owns interaction priority.
- **Platform services** connect devices, protect data, and provide reliable primitives.
- **Official modules** deliver notification, device, and transfer experiences out of the box.
- **Extensions** add user-specific integrations and automation.
- **Workbench** handles search, history, configuration, and other dense tasks.

## Repository layout

```text
apps/
  desktop/                 Windows desktop application
  phone/                   Companion mobile application
packages/
  desktop-shell/           Island window and desktop interaction runtime
  platform-services/       Notifications, devices, transfers, permissions, storage
  platform-contracts/      Versioned domain types and service contracts
  official-modules/        First-party product modules
  extension-sdk/           Public extension API and tooling
  shared-ui/               Cross-surface visual primitives
tests/
  contracts/               Contract and compatibility tests
  integration/              Service integration tests
  e2e/                     End-to-end product flows
docs/                      Product and engineering decisions
tools/                     Local development and release utilities
```

## Development order

Build the platform in this order:

1. Contracts, identity, permissions, and event envelopes.
2. Desktop shell and the notification presentation path.
3. Device pairing and connection lifecycle.
4. Reliable local-network file transfer.
5. Official modules and workbench flows.
6. Extension capabilities, simulators, and automation.
7. Additional mobile synchronization features.

The first complete product slice is: **Windows notification → desktop island alert → expanded detail → source action**.

## Documentation

- [Product foundation](docs/product-foundation.md)
- [System architecture](docs/system-architecture.md)
- [Functional boundaries](docs/functional-boundaries.md)
- [Delivery roadmap](docs/delivery-roadmap.md)
- [Development method](docs/development-method.md)
- [Architecture decisions](docs/adr-0001-product-shape.md)

