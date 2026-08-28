---
id: license-and-source
title: License, origin, and source access
sidebar_position: 1
update_docs: engine-b
---

# License, origin, and source access {#license-and-source}

MatrixSpooll is a modified version of ArcReel and is provided under the GNU Affero General Public License v3.0 (AGPL-3.0). Delivery, internal deployment, and paid customization do not remove the rights granted to recipients and network users.

## Project origin {#project-origin}

The in-app **About** page preserves the upstream attribution and source link required by `NOTICE`, and identifies MatrixSpooll as a modified version with the modifier and relevant date. Every source or image distribution must retain the root `LICENSE` and `NOTICE` files.

## Obtain source for the deployed version {#obtain-source}

Sign in to MatrixSpooll and open **About** from the user menu. Once the administrator publishes a source archive for the active release, the page shows its version, SHA-256 digest, and download action.

Operators build the version-matched archive before each release:

```bash
uv run python scripts/build_source_release.py
```

Artifacts are written to `deploy/production/legal-source/` and mounted read-only by production Compose. Never include `.env` files, databases, project media, logs, certificates, or provider credentials in the archive.

## Customer delivery {#customer-delivery}

A customer may receive the complete source and deployment service without publishing a public repository. The deployment operator must still give every authorized network user a free opportunity to obtain the corresponding source for the running version. Later modifications and third-party distribution remain subject to AGPL-3.0 and `NOTICE`.

This page is implementation guidance, not legal advice. A qualified adviser should review disputed delivery or contract boundaries.
