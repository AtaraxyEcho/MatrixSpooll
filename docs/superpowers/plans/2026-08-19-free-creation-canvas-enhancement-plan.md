# Free Creation Storyboard Enhancement Plan

Status: revised implementation plan
Scope: `content_mode=free` only
Rollback baseline: `3ac4f80 chore: checkpoint current frontend state`

## 1. Decision

The free canvas will gain one focused module: an ordered storyboard group that
turns an idea or script into editable shots, storyboard images, and independent
video clips.

This plan does not build a generic graph editor, a second fixed workflow, or a
video editing timeline. Those would expand the interface before the product has
stable use cases for them.

The existing direct composer remains the default:

```text
prompt -> direct image/video generation -> canvas result
```

Storyboard creation is an explicit optional action:

```text
idea or script -> storyboard group -> storyboard images -> selected shot videos
```

## 2. Product principles

1. Free creation remains independent from drama, narration, advertising, and
   reference-video project layouts.
2. Direct generation never silently changes into storyboard generation.
3. A text model is optional for direct free creation. AI shot planning may
   require a configured text model; without one, users can create and edit shots
   manually.
4. Canvas position is visual organization. Story order comes only from
   `sequence_index`.
5. A generated video clip is not a final edited video. Asset ZIP export remains
   separate from any future composed-video export.

## 3. Reuse and isolation

The free storyboard module may reuse these lower-level modules:

- `GenerationQueue` and `TaskSpec`;
- provider capability resolution and preflight validation;
- image and video generation implementations;
- artifact manifest, versioning, cancellation, retry, and project events;
- shared home/free composer controls.

It must not call or depend on:

- fixed workflow router endpoints;
- episode script files or `get_storyboard_items()`;
- fixed workflow `generation_mode` semantics;
- episode storyboard artifact keys;
- fixed workflow page state or sidebar modules.

The existing fixed storyboard implementation expects a script schema, episode
identity, and project generation route. Reusing it at the router or data-model
level would couple free creation to concepts it intentionally does not have.

## 4. Minimal domain model

### 4.1 Storyboard group

Persist only user-authored planning data:

```json
{
  "plan_id": "sp_abc",
  "title": "Rain station",
  "source": {
    "type": "prompt | upload",
    "reference_id": "r_optional"
  },
  "shots": [
    {
      "shot_id": "shot_01",
      "sequence_index": 0,
      "title": "Station exterior",
      "image_prompt": "...",
      "video_prompt": "...",
      "duration_seconds": 5
    }
  ],
  "revision": 3,
  "created_at": "...",
  "updated_at": "..."
}
```

Do not persist `image_creation_id` or `video_creation_id` into the plan. That
would require cross-file transactions between plan state and asynchronous task
results.

Generated creations instead carry:

```json
{
  "storyboard_plan_id": "sp_abc",
  "storyboard_shot_id": "shot_01",
  "storyboard_stage": "image | video",
  "sequence_index": 0
}
```

The read model resolves the latest usable image/video creation for each shot.
This keeps the plan as the source of truth for intent and creation metadata as
the source of truth for generated media.

### 4.2 No generic relation model

The first release does not add a general-purpose `node_kind` registry or
relations such as `sequence_next`, `audio_for`, and `caption_for`.

Existing creation references and `parent_creation_id` continue to describe
generation provenance. Storyboard membership and `sequence_index` are enough to
support the required workflow.

## 5. Module interface

The backend seam is one free-storyboard module with a small interface:

```text
create_or_update_plan(project, plan_draft) -> plan
generate_images(project, plan_id, shot_ids, image_options) -> batch_result
generate_videos(project, plan_id, shot_ids, video_options) -> batch_result
```

The module hides source extraction, validation, ordering, capability checks,
task construction, partial enqueue compensation, and read-model assembly.
Routers remain thin transport adapters.

Required routes:

- `GET /projects/{project}/free-creation-storyboards`
- `POST /projects/{project}/free-creation-storyboards`
- `GET /projects/{project}/free-creation-storyboards/{plan_id}`
- `PUT /projects/{project}/free-creation-storyboards/{plan_id}`
- `POST /projects/{project}/free-creation-storyboards/{plan_id}/images`
- `POST /projects/{project}/free-creation-storyboards/{plan_id}/videos`

Batch endpoints perform all validation before enqueue. The frontend must not
loop over the ordinary creation endpoint, because that exposes compensation and
partial-failure complexity to the caller.

## 6. Planning behavior

The composer shows a `Plan storyboard` command only when a prompt or explicitly
selected text/script resource is available.

Opening the planner does not write data. The user first sees a local draft and
chooses one of these paths:

- `Plan with AI`, available when a text model is configured;
- `Import paragraphs as shots`, an explicit deterministic conversion;
- `Add shots manually`, always available.

The system must not select the first uploaded text file automatically. The user
chooses the source, and creating the plan requires an explicit save action.

An AI plan is still a draft. Users can edit titles, image prompts, video prompts,
durations, and order before generation.

## 7. Canvas behavior

Generated storyboard creations use the existing creation card with a compact
shot badge. No second card rendering system is required.

The canvas adds a contextual selection toolbar when all selected successful
image creations belong to one storyboard plan:

- `Generate selected shots`;
- `Move selection`;
- `Hide selection`;
- existing asset export.

`Generate selected shots` submits shot IDs ordered by `sequence_index`, not by
canvas coordinates or selection order.

The first release does not add a timeline. Plan editing provides explicit up/down
or drag reorder, and the canvas only reflects that order through shot badges and
optional lightweight sequence lines.

## 8. Generation behavior

### 8.1 Storyboard images

The image batch endpoint:

1. loads the plan and selected shots;
2. validates unique shot IDs and complete image prompts;
3. resolves image model capabilities once;
4. constructs all `free_image` task specifications;
5. validates the full batch before enqueue;
6. enqueues with compensation if an unexpected partial failure occurs;
7. returns a per-shot batch result.

Each result is an ordinary free creation with storyboard metadata. Existing
cancel, retry, version, preview, reference, and export behavior remains usable.

### 8.2 Selected shots to video

The video batch endpoint:

1. resolves the latest successful storyboard image for every selected shot;
2. rejects missing or incompatible images before enqueue;
3. validates aspect ratio, resolution, duration, quantity, and input roles
   against the selected video model;
4. binds each image explicitly as `first_frame` by default;
5. enqueues one `free_video` task per shot;
6. returns per-shot status and stable errors.

The output is a set of ordered video clips on the canvas. Automatic stitching,
transitions, captions, and audio mixing are not part of this phase.

## 9. Audio scope

Current audio behavior remains:

- upload and native preview;
- canvas card;
- explicit `reference_audio` binding when the model supports it.

AI voiceover generation is deferred until the project defines speaker, voice,
language, timing, and attachment rules. It should later be a separate free-audio
module, not additional fields on the storyboard batch interface.

## 10. Deferred features

The following are deliberately excluded from this implementation:

- local mask editing, inpainting, and cutout;
- AI voiceover generation;
- subtitle generation and caption tracks;
- music generation and mixing;
- a timeline editor;
- automatic video stitching and transitions;
- final composed-video export;
- a generic canvas relation graph;
- reverse video-to-script workflows.

These remain candidate product increments after storyboard usage validates the
required data and interaction model.

## 11. Delivery plan

### Step 0: remove experimental assumptions

- Do not commit the current frontend-per-shot loop.
- Remove automatic plan creation on panel open.
- Remove automatic use of the first text upload.
- Do not label queued images as ready.
- Keep the rollback baseline and this plan as separate commits.

### Step 1: plan CRUD and read model

- Add revisioned plan persistence, list/get/create/update operations.
- Add manual shot creation and explicit paragraph import.
- Add optional AI planning behind text-model availability.
- Add plan selection and editing UI.
- Test revision conflicts, source selection, order validation, and reopening.

### Step 2: storyboard image batch

- Add the backend image batch interface.
- Reuse free image execution and artifact handling.
- Add storyboard metadata to creation basis and metadata.
- Resolve live task state through existing project events and polling.
- Render resulting images as shot-labelled creation cards.

### Step 3: selected-shot video batch

- Add a storyboard-aware canvas selection action.
- Add backend preflight and ordered video batch enqueue.
- Bind each source image explicitly as `first_frame`.
- Preserve per-shot retry, cancellation, versions, and provenance.

### Step 4: evaluate before expanding

Use actual workflows to decide whether users need sequence preview, stitching,
voiceover, captions, or local image editing next. Do not create their data model
before that decision.

## 12. Acceptance criteria

- Existing direct image/video generation behaves exactly as before.
- Existing fixed workflow tests and routes remain unchanged.
- Opening and cancelling the planner creates no stored plan.
- Users explicitly choose a prompt or script source.
- A plan can be saved, reopened, edited, and reordered without generating media.
- All shots are validated before an image batch is enqueued.
- Storyboard image creations preserve plan, shot, stage, order, model, and
  version provenance.
- Only compatible successful storyboard images can be batch-generated as video.
- Selected videos follow plan order regardless of canvas position.
- Partial enqueue failures do not leave an unreported half-created batch.
- Audio upload/reference behavior continues to work.
- ZIP export remains an asset export and is not presented as a finished video.

## 13. Test gates

Backend tests cover plan revisions, explicit source handling, batch admission,
partial enqueue compensation, capability errors, creation read-model assembly,
and provenance. Frontend tests cover no-write-on-open, source selection, manual
editing, reorder, batch selection filtering, per-shot status, and preservation of
the direct composer.

Before each implementation commit run focused backend tests, frontend lint,
typecheck, Vitest, i18n consistency, and the fixed storyboard/reference-video
regression suites. Run a production frontend build before the final commit.
