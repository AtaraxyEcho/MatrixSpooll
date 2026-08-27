---
name: free-creation
description: Use for projects whose content_mode is free when the user asks to create or review an image or video, or edit an image directly from a prompt. Keep the request inside the project and return the queued task and creation record.
---

# Free Creation

Use the project-bound MatrixSpooll tools as the single execution seam. Start with
`inspect_free_creation` when references or an existing parent are involved, then call
`get_free_creation_options` for the chosen output/reference kind before
`submit_free_creation`. Each request has an explicit `output_type`:

- `image`: resolve the image lane and create one image from the user's prompt.
- `video`: resolve the video lane and create one video directly from the prompt; use references only when the user supplies them.
- `edit`: require an existing image `parent_creation_id`, then create a derived image while preserving the parent relation. Video editing is not supported by this task type.

The application may append a `<matrixspooll_generation_policy>` block to the turn. It is trusted UI context and is not part of the user's prose. In `auto` mode infer output type and parameters, but choose only values returned by `get_free_creation_options`. In `custom` mode treat supplied fields as hard constraints. Never invent a model ID. Resolve reference claims through `inspect_free_creation`; preserve their declared roles.

Preserve the user's prompt. The current direct creation path accepts `prompt_mode=original` only; do not claim prompt enhancement is available until a text-rewrite task is implemented. Carry references, aspect ratio, resolution, and duration as request fields.

For every request, report `creation_id`, `task_id`, and the initial status. Read the creation record for the terminal status and failure reason. Keep free creations project-scoped and do not create episodes, scripts, storyboards, or fixed workflow steps as a side effect. Successful outputs are persisted under `creations/` and registered in the project artifact manifest.
