# Account and Workbench direction

DI's hosted Workbench is the account's home for projects and investigations. A user can also install DI on a supported computer and link it to the same account. A linked computer is an execution and storage location, not a second account or a requirement that the computer be online for its projects to appear.

The account retains its project list, integration connections, graph definitions and Workbench layout preferences. Availability of a graph generation depends on the location where that generation is stored. The Workbench should show a location as offline when it cannot currently reach it and permit the user to choose another available location where the operation supports that choice.

A graph definition has its own identity and name, source selection, build location, storage location and update policy. These are independent choices. A local folder and a connected repository revision are different source types; either can be built or stored at a location that can access it. Snapshots are the default update policy. `working` is an ordinary graph name, not a reserved source or update policy. Generations represent builds of a graph definition and retain their own source and coverage information.

The Workbench presents projects, graph and source views, investigation results and controls as configurable panels. A panel can contain several tabs; its selected tab occupies the panel. Users can resize and arrange panels and restore their saved arrangement when signing in again. Questions, node inspection, changes, parity and audit remain entrances to the same graph and evidence rather than separate intelligence stores.

Clerk is the selected account identity provider for DI. Signing in with GitHub should carry the GitHub identity into repository connection where the provider configuration and permissions allow it. Repository access is a separate grant when needed; DI should explain that grant and reuse the user's existing GitHub session. GitHub sign-in alone must not be presented as proof that DI can access private repositories.

## Current implementation boundary

The existing hosted owner-password session and global project registry are not an account-aware Workbench. The existing account network library is not connected to an identity provider or a live computer, and a registered key thumbprint alone is not a linked, reachable computer. The current local graph catalog stores named retained targets at the installation's selected data location; it does not yet persist the full account-owned graph definition, per-graph storage choice or update policy. This document describes the intended product, not a claim that those features have shipped.

Before account users can access hosted projects, every project and graph request must resolve the authenticated account's own authorized source and storage binding. Preview account data and credentials must be isolated from Main. Local and hosted execution should use the same graph build and investigation sequence, with adapters for their different source, storage and communication locations.
