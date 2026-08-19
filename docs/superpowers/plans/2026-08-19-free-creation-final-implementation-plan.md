# Free Creation: Final Implementation Baseline

Status: execution baseline
Scope: `content_mode=free` only. Storyboard and reference-video project flows keep their existing layout, controls, and execution contracts.

## Product contract

- A free project stores `content_mode=free` and does not select a legacy `generation_mode`.
- A prompt with no media uses direct video generation (`t2v`). Text and image models are optional.
- Home and free-project detail use one generation composer. The selected output lane is carried through the home-to-detail transition; a video handoff does not reopen image controls.
- A resource identity is never a server path in a request. Existing creations use `creation_id + version`; uploads use `reference_id`.

## Resource and input roles

Resource types are `image`, `video`, `audio`, `script`, and `creation`. A resource role is explicit and is never inferred from a filename. Audio uploads, including voiceover files, are first-class canvas nodes with native preview controls and can be referenced as `reference_audio` when the selected video model declares that slot.

`first_frame`, `last_frame`, `reference_image`, `reference_video`, `reference_audio`, `prompt_context`.

The composer asks for a role after an image or video is added. Invalid type-role combinations and duplicate slots are rejected before enqueue. Two images assigned to first and last frame produce `first_last_frame`; one first frame produces `first_frame`; reference images and reference videos remain separate modes. A script contributes prompt context and does not require a text model.

## Capability and execution contract

The capability response exposes `modes`, `input_slots`, `combinations`, ratios, resolutions, durations, and quantity limits. `t2v` is a declared model capability, not an inference from `first_frame`.

Preflight uses the same capability object as execution and returns stable errors for unsupported t2v, frame roles, reference media, combinations, resource types, counts, ratios, resolutions, durations, and quantity. Changing model revalidates all bound resources without silently deleting them.

The normalized request contains `output_type`, `prompt`, `model`, structured `references`, structured `context`, ratio, resolution, duration, and quantity. The server computes the effective mode and maps roles to the video request:

- `first_frame` -> `start_image`
- `last_frame` -> `end_image`
- `reference_image` -> `reference_images`
- `reference_video` -> `reference_videos`
- `reference_audio` -> `reference_audio_files`
- `prompt_context` -> prompt context

Artifact basis and manifest retain prompt, model, effective mode, resource identity, version, role, order, ratio, resolution, duration, quantity, and request id.

## Navigation and detail shell

The project route resolves project metadata before selecting a layout. While metadata is pending, it renders a neutral workspace loading shell; it never mounts the standard project detail layout first. This removes the one-frame flash when entering a free project. The route uses a stable free-layout key per project.

The free detail shell contains only the infinite canvas, the shared composer, optional agent access, and the free export menu. Legacy stage labels and legacy export controls remain available only in their existing fixed workflows.

## Canvas interaction

- The normal cursor remains the default arrow.
- Left-click blank canvas starts marquee selection; left-click a node selects it. Dragging starts only from a node header.
- Long-press middle mouse pans. `Space + left-drag` is the keyboard alternative.
- `Ctrl/Cmd + wheel` zooms only inside the canvas and calls `preventDefault`; ordinary wheel pans the canvas.
- Right-click inside the canvas suppresses the browser menu and opens an opaque, viewport-safe context menu. Right-click outside the canvas keeps browser behavior.
- Upload nodes have the same selection, drag, marquee, context-menu, and batch actions as creation nodes.
- Image, video, text/script, and audio/voiceover uploads are all rendered as identifiable canvas cards. Audio cards keep native playback controls so creators can audition a voiceover before binding it to a request; text/script cards use `prompt_context` and do not require a text model.
- A batch selection can move, hide, reference, or export. Deleting an unreferenced upload deletes its private record and file; a referenced upload is detached/hidden first and cannot break an existing creation.
- Popovers and menus use an opaque raised surface, a portal/fixed position, and a high stacking layer. They must not be clipped by the composer or category bars.

## Session visibility

Direct generation requests are not conflated with Agent SDK sessions. The canvas shows a compact, opaque session summary at the upper left: current prompt, effective mode, model, bound resource count, status, and the latest request time. It expands into a request-history drawer with retry/select/export affordances. An optional world-space prompt card can be created for a request, but it is not required for the first release.

Agent access remains optional and project-scoped. Opening and closing it must preserve the session id and transcript; it must not reset to a new conversation on every render.

## Delivery order

1. Sync this contract and add route gating for a flash-free free detail entry.
2. Extract/align the shared home/detail composer and carry output lane plus request id through navigation.
3. Add explicit resource roles, capability modes/slots/combinations, preflight error codes, and execution mapping.
4. Add upload node selection, context actions, safe delete/hide, batch export, and canvas browser-event handling.
5. Add the upper-left session summary and request history while preserving optional Agent SDK sessions.
6. Run focused backend/frontend tests, type checks, lint, and a production build. Commit the complete change with a conventional commit message.

## Acceptance checklist

- Entering a free project never flashes a storyboard/reference detail page.
- Home video generation arrives in free detail with video controls only; image references can still be uploaded and assigned explicitly.
- Prompt-only generation succeeds only for a model declaring `t2v`.
- First/last frame, reference image, reference video, audio, and script roles are distinct in the request and execution layer.
- Model changes revalidate resources and show stable, actionable errors.
- Canvas controls work with default cursor, middle-button pan, marquee selection, node-only drag, local zoom, and suppressed in-canvas browser context menu.
- Upload nodes can be selected, moved, hidden/deleted safely, referenced, and batch-exported.
- Context menus and parameter popovers are opaque and are not clipped or transparent.
- Session summary and request history are visible without pretending direct requests are Agent SDK transcripts.
- Existing storyboard and reference-video tests and workflows remain green.
