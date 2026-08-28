---
id: project-transfer-and-media
title: Project backup and media tools
sidebar_position: 6
update_docs: engine-b
---

# Project backup and media tools {#project-transfer-and-media}

## Project ZIP {#project-zip}

The project list can export a complete project ZIP and restore it through **Import project ZIP**. Both workflow and free-creation projects are supported. Import validates the archive structure, JSON size, entry count, individual and total extracted size, compression ratio, and path safety.

A successful import creates a new project identity instead of overwriting an existing project or inheriting old membership. Project ZIPs do not include database users, memberships, system provider credentials, login logs, or global configuration. Full disaster recovery also requires PostgreSQL and `deploy/production/projects/` backups.

## Media tools {#media-tools}

Video merge, subtitles, proxies, and thumbnails use FFmpeg/FFprobe in background work. Production images include both executables and verify them in health checks; local development must expose them on `PATH`.

Merge processes local clips in selection order and does not invoke a generation model. Incompatible codecs, dimensions, audio tracks, or containers fail without deleting the originals. Large jobs consume CPU, disk, and temporary space, so monitor free capacity.
