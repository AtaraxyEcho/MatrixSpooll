# Free Creation Canvas Enhancement Plan

Status: proposed implementation plan
Scope: `content_mode=free` only
Baseline: `3ac4f80 chore: checkpoint current frontend state`

## 1. Product outcome

The free creation project should become a canvas-first video workspace with a
complete, inspectable path from an idea or script to storyboard images, video
clips, voiceover, captions, music, and a final export. Existing drama,
narration, advertising, storyboard, and reference-video project flows must keep
their current routes, controls, task types, and data contracts.

The existing direct composer remains the default path:

```text
prompt -> direct image/video generation -> canvas result
```

The enhancement adds an explicit storyboard path without changing that default:

```text
script or idea -> shot plan -> storyboard images -> selected shot videos -> post-production -> export
```

## 2. Current boundary

The current free canvas already supports image, video, text/script, and audio
uploads; explicit reference roles; direct t2v, first/last frame, reference
image/video/audio generation; canvas selection and movement; dependency lines;
request history; and ZIP export.

The current system does not yet provide shot planning, shot ordering, selected
shot video generation, local mask editing, generated voiceover, captions,
music tracks, or timeline composition. These are new free-canvas capabilities,
not changes to the fixed workflow.

## 3. Domain model

### 3.1 Canvas nodes

Keep creation and upload identities stable. Add a node metadata layer rather
than changing the meaning of existing creation IDs.

```json
{
  "node_id": "c_...",
  "node_kind": "creation | upload | storyboard_shot | audio | script | sequence",
  "resource_id": "c_... or r_...",
  "plan_id": "sp_...",
  "shot_id": "shot_...",
  "sequence_index": 2,
  "duration_seconds": 5,
  "position": {"x": 640, "y": 280}
}
```

`node_kind` describes the canvas role. It must not replace
`FreeCreation.output_type`, which continues to describe the generated media
type (`image`, `video`, or `edit`).

### 3.2 Relations

Persist typed relations instead of inferring meaning from coordinates:

```text
uses             resource -> generation
derived_from     version -> parent
sequence_next    shot -> shot
audio_for        audio -> video/sequence
caption_for      caption -> video/sequence
reference_for    resource -> generation
```

Existing parent and reference claims remain valid. The new relation layer is
additive and can be rendered as the current dependency lines plus optional
sequence arrows.

### 3.3 Storyboard plan

Store plans under the free workspace, for example
`free_creation/storyboards/<plan_id>.json`:

```json
{
  "plan_id": "sp_...",
  "source": {"type": "upload", "reference_id": "r_..."},
  "title": "Rain station sequence",
  "status": "draft | generating | ready | failed",
  "shots": [
    {
      "shot_id": "shot_...",
      "sequence_index": 0,
      "title": "Station exterior",
      "prompt": "...",
      "duration_seconds": 5,
      "image_creation_id": null,
      "video_creation_id": null
    }
  ]
}
```

The plan owns ordering and shot metadata. Generated creations continue to own
media, version, model, and artifact provenance.

## 4. Backend API and task design

Add free-specific routes under the existing free project router:

1. `POST /projects/{project}/free-creation-storyboards/plan`
   - accepts a prompt or an uploaded text/script resource;
   - returns a persisted draft plan;
   - uses a deterministic fallback splitter when no text model is configured;
   - never changes the default direct generation path.
2. `GET /projects/{project}/free-creation-storyboards/{plan_id}`
   - returns the plan, shot status, and linked creations.
3. `PUT /projects/{project}/free-creation-storyboards/{plan_id}`
   - updates shot prompt, title, duration, and order;
   - validates unique sequence indexes and model duration constraints.
4. `POST /projects/{project}/free-creation-storyboards/{plan_id}/generate-images`
   - enqueues one image task per selected shot;
   - writes `plan_id`, `shot_id`, and `sequence_index` into creation metadata.
5. `POST /projects/{project}/free-creation-storyboards/{plan_id}/generate-videos`
   - accepts an ordered shot selection;
   - validates that each shot has a successful image;
   - enqueues one video task per shot using the image as `first_frame` or
     `reference_image` according to the selected mode.
6. `POST /projects/{project}/free-creation-postproduction`
   - is reserved for the later timeline phase;
   - accepts ordered video, audio, caption, and music tracks;
   - returns a queued final artifact rather than overloading ZIP export.

New task types must remain in `free_creation_tasks.py` and reuse the existing
generation queue and capability checks. They must not call fixed workflow
routers or mutate episode/storyboard project files.

## 5. Frontend interaction model

### 5.1 Script to storyboard

Add a compact `Plan storyboard` action beside the shared composer attachment
control. It opens a small plan surface with:

- script or prompt source;
- shot count preview;
- editable shot titles and prompts;
- duration per shot;
- `Generate storyboard images` action.

The normal composer continues to show only image/video generation lanes. The
new plan action is explicit so a text upload never silently changes a direct
video request into storyboard mode.

### 5.2 Canvas shot cards

Storyboard cards should be visually distinct from ordinary creation cards while
using the same surface tokens. Each card shows:

- shot number and title;
- prompt summary;
- image/video generation state;
- duration;
- actions: edit prompt, regenerate image, generate video, add to sequence.

Dragging a shot updates `sequence_index` through an explicit reorder operation;
free positioning remains available independently.

### 5.3 Batch generation

When the marquee selection contains storyboard cards, the selection toolbar
shows `Generate selected shots`. The action must:

- reject non-storyboard resources with an actionable message;
- preserve visual order by `sequence_index`;
- show per-shot queue status;
- return video creations to the same canvas;
- leave the existing ZIP export action unchanged.

### 5.4 Audio and post-production

The current upload/playback card remains valid. Later phases add explicit
audio-producing actions and track cards:

- voiceover generation from a prompt or script;
- caption generation from a selected video/sequence;
- music generation or upload;
- track trimming and ordering;
- final preview and video export.

These actions should be separate from `reference_audio`, which remains a model
input role for generation.

## 6. Delivery phases

### Phase A: storyboard foundation

- Add storyboard plan persistence and API DTOs.
- Add deterministic script splitting and editable shot plans.
- Add frontend plan drawer and storyboard shot cards.
- Add image generation for selected shots.
- Extend metadata and artifact basis with plan/shot/order fields.

Acceptance: a script can produce an editable shot plan and multiple storyboard
images on the free canvas. Direct prompt-only video generation remains unchanged.

### Phase B: shot-to-video pipeline

- Add selected-shot validation and ordered batch video requests.
- Map each storyboard image to the selected video input role.
- Add per-shot queue state and retry/cancel actions.
- Add sequence relations and a lightweight sequence strip.

Acceptance: selecting shots in any canvas position generates videos in sequence
order and returns them linked to their source images.

### Phase C: editing and multimodal relations

- Add mask/region edit requests for image cards.
- Add explicit `derived_from`, `audio_for`, and `caption_for` relations.
- Add generated voiceover nodes and script-to-voiceover actions.

Acceptance: an image can be locally edited, a voiceover can be attached to a
shot or sequence, and provenance remains visible after retries and versions.

### Phase D: post-production

- Add caption, copy, music, and timeline track models.
- Add preview and final video composition task.
- Add a dedicated final-video export action, separate from asset ZIP export.

Acceptance: a selected sequence can be previewed and exported as one video with
video, voiceover, captions, and music tracks.

## 7. Compatibility and safety rules

- Gate every new route and task on `content_mode=free`.
- Do not alter `generation_mode` semantics for existing projects.
- Keep existing `free_creation` direct requests valid without a storyboard plan.
- Reuse provider capability DTOs and preflight validation for every generated
  shot; do not infer support from frontend controls.
- Store resource IDs, versions, roles, and sequence indexes in artifact basis
  and manifests. Never persist server paths in public requests.
- Do not delete or silently reassign incompatible references when a model
  changes.
- Keep ZIP export and final-video export as separate operations.

## 8. Test strategy

Backend tests should cover plan persistence, split limits, reorder conflicts,
model capability failures, selected-shot validation, ordered enqueue, retry, and
artifact provenance. Frontend tests should cover plan creation, shot editing,
marquee filtering, sequence reorder, batch status, and preservation of the
existing direct composer behavior.

Run the focused backend tests, frontend typecheck/lint/Vitest, and a production
build after each phase. The fixed workflow storyboard and reference-video test
suites are regression gates for every phase.

