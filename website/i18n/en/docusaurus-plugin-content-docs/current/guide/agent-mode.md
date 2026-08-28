---
id: agent-mode
title: Agent mode
sidebar_position: 4
update_docs: engine-b
---

# Agent mode {#agent-mode}

Agent mode translates natural-language intent into project actions and generation tasks. It is selected from the same composer control as image and video generation; the three modes are not concurrent resident processes.

## Automatic and custom {#automatic-and-custom}

- **Automatic** lets Agent choose image or video output and recommend a compatible model, ratio, and resolution.
- **Custom** constrains Agent with a user-selected output preference, model, ratio, and resolution.

All resulting requests still pass model-capability validation and the generation queue.

## Sessions and projects {#sessions-and-projects}

From home, MatrixSpooll creates a free-creation project before starting an Agent session. In a project, conversation appears in the left session area while the creation composer remains at the bottom. Generated media is added to the active canvas.

Sessions remain bound to their project. When a project is deleted, inaccessible, or no longer compatible with a session, start a new session. Failure cards should present an actionable reason rather than a raw provider exception.

## Provider requirements {#provider-requirements}

The current Agent Runtime uses Claude Agent SDK. An Agent provider therefore needs a compatible Anthropic Messages endpoint and an accessible model. An OpenAI Chat Completions text endpoint is not automatically an Agent provider. Image, video, and TTS providers remain system-level configuration managed by administrators.
