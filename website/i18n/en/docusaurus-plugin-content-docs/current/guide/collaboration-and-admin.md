---
id: collaboration-and-admin
title: Users, collaboration, and administration
sidebar_position: 5
update_docs: engine-b
---

# Users, collaboration, and administration {#collaboration-and-admin}

MatrixSpooll uses a compact multi-user model: system administrators manage accounts and runtime state, while project access uses owner, editor, and viewer roles.

## System roles {#system-roles}

- The environment-provisioned **super administrator** cannot be demoted, disabled, or deleted in the UI.
- **Administrators** manage users, online sessions, system logs, background tasks, and system-wide providers.
- **Members** use authorized projects and assets; unauthorized system settings are hidden and protected by route checks.

The management UI is `/app/admin/manager`; its login entry is `/admin/login`.

## Project roles {#project-roles}

- **Owners** manage settings, members, and ownership transfer.
- **Editors** modify project content and common settings but cannot transfer ownership.
- **Viewers** have read-only access and cannot open project settings.

Project names do not need to be globally unique. The backend resolves authorization, membership, and storage through a stable project ID.

## Login sessions {#login-sessions}

The admin sessions page lists only currently online sessions. A new login with the same browser identity or source IP replaces the existing session for that account; the old page receives a real-time signed-out notice. Login history is stored separately for successful and failed authentication events.
