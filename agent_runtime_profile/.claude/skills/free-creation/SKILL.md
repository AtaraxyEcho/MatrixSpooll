---
name: free-creation
description: Use for projects whose content_mode is free when the user asks to create, edit, or review an image or video directly from a prompt. Keep the request inside the project and return the queued task and creation record.
---

# Free Creation

Use the project's free-creation API as the single execution seam. Each request has an explicit `output_type`:

- `image`: resolve the image lane and create one image from the user's prompt.
- `video`: resolve the video lane and create one video directly from the prompt; use references only when the user supplies them.
- `edit`: require an existing image `parent_creation_id`, then create a new image version while preserving the parent.

Preserve the user's prompt. The current direct API accepts `prompt_mode=original` only; do not claim prompt enhancement is available until a text-rewrite task is implemented. Carry references, aspect ratio, resolution, and duration as request fields.

For every request, report `creation_id`, `task_id`, and the initial status. Read the creation record for the terminal status and failure reason. Keep free creations project-scoped and do not create episodes, scripts, storyboards, or fixed workflow steps as a side effect. The MVP persists these records under `creations/`; formal artifact-manifest registration is not available yet.
