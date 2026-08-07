# src/models

Mongoose schemas and models. One file per collection, named `<entity>.model.js`
(for example `user.model.js`, `emailAccount.model.js`).

Intentionally empty in Phase 1 — data models are defined in a later phase once
the domain is settled. Defining them before the requirements are known produces
migrations nobody wanted.
