# Free Creation Storyboard Enhancement Plan

Status: revised implementation plan
Scope: `content_mode=free` only
Rollback baseline: `3ac4f80 chore: checkpoint current frontend state`

## 1. Decision

The free canvas will gain one focused module: an ordered storyboard group that
turns an idea or script into editable shots, storyboard images, independent
video clips, voiceover, subtitles, and an explicitly composed result.

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
               -> voiceover and subtitles -> merge selected clips
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
   separate from composed-video export.
6. Model-native audio, controllable TTS voiceover, and subtitles are different
   capabilities. The UI and execution layer must not present them as one switch.
7. Music generation and a full multi-track editor are outside this release.

## 3. Reuse and isolation

The free storyboard module may reuse these lower-level modules:

- `GenerationQueue` and `TaskSpec`;
- provider capability resolution and preflight validation;
- image and video generation implementations;
- audio synthesis backends and voice discovery;
- speech presentation subtitle timing and WebVTT serialization;
- FFmpeg clip normalization and concatenation behavior;
- artifact manifest, versioning, cancellation, retry, and project events;
- shared home/free composer controls.

It must not call or depend on:

- fixed workflow router endpoints;
- episode script files or `get_storyboard_items()`;
- fixed workflow `generation_mode` semantics;
- episode storyboard artifact keys;
- fixed workflow page state or sidebar modules.

The existing fixed storyboard, TTS, presentation, and video-composition flows
expect a script schema, episode identity, or fixed project route. Reusing those
routers or data models would couple free creation to concepts it intentionally
does not have. Shared mechanics should be extracted behind lower-level library
interfaces, while free creation owns its admission and orchestration.

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
      "voiceover_text": "...",
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
  "storyboard_stage": "image | video | voiceover",
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

### 4.3 Voiceover and composition records

Voice selection is a plan-level default with an optional per-shot override.
`voiceover_text` is authored shot data; generated audio remains a versioned free
creation and is not written back into the plan.

A merge request is a narrow, immutable composition claim rather than a generic
timeline or graph:

```json
{
  "source_clips": [
    {
      "creation_id": "c_video_01",
      "version": 2,
      "storyboard_shot_id": "shot_01"
    }
  ],
  "voice_mode": "voiceover | original | mute",
  "subtitle_mode": "none | sidecar | burn_in",
  "transition": "cut"
}
```

The resulting composed video is a new canvas creation. Its artifact basis and
manifest record every source creation ID and version, the final order, audio
mode, subtitle mode, and composition settings. Source files are never inferred
from canvas coordinates or server-internal paths.

## 5. Module interface

The backend seam is one free-storyboard module with a small interface:

```text
create_or_update_plan(project, plan_draft) -> plan
generate_images(project, plan_id, shot_ids, image_options) -> batch_result
generate_videos(project, plan_id, shot_ids, video_options) -> batch_result
generate_voiceovers(project, plan_id, shot_ids, voice_options) -> batch_result
compose_selection(project, ordered_sources, composition_options) -> task
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
- `POST /projects/{project}/free-creation-storyboards/{plan_id}/voiceovers`
- `POST /projects/{project}/free-creation-compositions`

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

When at least two successful video creations are selected, right-clicking any
selected card preserves the multi-selection and exposes `Merge selected clips`.
The action is unavailable for queued, failed, deleted, or non-video creations.

The merge confirmation shows the exact source versions and order. Clips from
one storyboard plan default to `sequence_index`; mixed or direct-generation
clips require the user to confirm or reorder them. Canvas position and selection
order are never silently treated as story order.

The first release does not add a full timeline. Plan reorder plus the merge
confirmation is sufficient for ordered cuts, voiceover choice, and subtitle
output. A timeline becomes justified only when users need frame-accurate trim
points, overlaps, transition lengths, multiple simultaneous audio tracks,
volume envelopes, or manual subtitle-cue timing.

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

The output is a set of ordered video clips on the canvas. This step does not
automatically merge them; composition remains an explicit selection action.

## 9. Voiceover, subtitles, and composition

### 9.1 Voiceover

Voiceover generation is an explicit storyboard action:

- users write or edit `voiceover_text` per shot;
- users select a configured voice, language, and speed at plan level, with an
  optional per-shot override;
- the backend reuses the audio synthesis backend and generation queue through a
  free-creation adapter, not the episode TTS route;
- each successful result is an audio card on the canvas and records plan, shot,
  text, voice, language, speed, model, version, and duration provenance.

Uploaded audio and `reference_audio` remain available for model input, but they
are not silently treated as generated narration.

### 9.2 Audio policy during merge

The first release supports one active audio source per composed segment:

- `voiceover`: use the generated TTS track and mute the clip's native audio;
- `original`: preserve the video model's original audio and do not add TTS;
- `mute`: produce a silent composition.

This avoids an implicit audio mix without volume controls. If generated
voiceover exceeds its clip duration, preflight rejects the merge with a stable
error and asks the user to shorten the text or regenerate a longer clip. It
must not truncate, speed up, or time-stretch speech silently.

### 9.3 Subtitles

For TTS voiceover, subtitle cues derive from the exact `voiceover_text` and the
materialized audio duration. Reuse the existing speech-presentation timing and
WebVTT serializer. Store editable cue JSON and a `.vtt` sidecar for every
subtitled composition; `burn_in` additionally renders the same cues into the
video.

The first release does not promise automatic subtitles for arbitrary model
audio or uploaded audio because that requires a separate ASR contract. Native
audio can still be preserved through `voice_mode=original`.

### 9.4 Clip merge

Composition runs as a queued backend task. Extract the existing FFmpeg
normalization and concatenation mechanics into a shared library module, keep
the fixed workflow adapter using that module, and add a free-creation adapter.
The initial transition set contains only `cut`; transitions can be added after
the composition contract is stable.

The composed result returns to the canvas as a distinct video creation with its
own preview, version, retry, download, and delete behavior. Its export command
downloads the composed video and subtitle sidecar, while the existing asset ZIP
export continues to export selected source resources.

### 9.5 Model-native audio

The video composer reads the existing model capability response rather than a
provider-name allowlist. Models such as Seedance variants that declare an audio
track may expose `original` audio; models with a controllable audio switch may
also expose the generation toggle. Native model audio does not satisfy the TTS
contract because it does not guarantee a selected voice, exact narration text,
or structured subtitle cues.

## 10. Deferred features

The following are deliberately excluded from this implementation:

- local mask editing, inpainting, and cutout;
- music generation and mixing;
- a timeline editor;
- automatic merge without an explicit user selection;
- transition effects beyond a hard cut;
- simultaneous native-audio and TTS mixing;
- ASR subtitles for arbitrary uploaded or model-native audio;
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

### Step 4: voiceover and subtitles

- Add free-storyboard voiceover batch admission and execution.
- Reuse provider voice discovery, audio synthesis, task status, and artifacts.
- Render generated voiceover as selectable audio cards.
- Materialize subtitle cue JSON and WebVTT from narration text and duration.
- Test voice capability errors, per-shot overrides, version provenance, and
  narration-duration conflicts.

### Step 5: selected-clip composition

- Preserve multi-selection when opening a video card context menu.
- Add `Merge selected clips` eligibility checks and confirmation UI.
- Extract shared FFmpeg normalization and hard-cut concatenation behavior.
- Add queued composition, immutable source-version claims, subtitle sidecars,
  optional subtitle burn-in, and a composed-video canvas card.
- Keep composed-video export separate from asset ZIP export.

### Step 6: evaluate before expanding

Use actual workflows to decide whether users need a full timeline, audio mixing,
transitions, ASR captions, or local image editing next. Do not create their data
model before that decision.

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
- Voiceover can be generated per shot without an episode script or fixed route.
- Voiceover audio appears as a versioned, selectable canvas creation.
- A selection of at least two successful video clips can be merged from the
  context menu without collapsing the selection.
- Same-plan clips default to storyboard order; mixed clips require explicit order
  confirmation.
- Merge never reads stale or implicit source revisions.
- TTS subtitles produce cue JSON and WebVTT; optional burn-in uses the same cues.
- Voiceover longer than its target clip fails before composition without silent
  truncation or speed adjustment.
- Model-native audio remains selectable as original audio but is not described as
  controllable TTS or structured subtitles.
- Audio upload/reference behavior continues to work.
- Asset ZIP export and composed-video export are visibly distinct operations.

## 13. Test gates

Backend tests cover plan revisions, explicit source handling, batch admission,
partial enqueue compensation, capability errors, creation read-model assembly,
provenance, TTS admission, subtitle timing, immutable composition sources,
FFmpeg normalization, and merge failure compensation. Frontend tests cover
no-write-on-open, source selection, manual editing, reorder, batch selection
filtering, right-click selection preservation, merge eligibility and ordering,
voice/subtitle options, per-shot status, and preservation of the direct composer.

Before each implementation commit run focused backend tests, frontend lint,
typecheck, Vitest, i18n consistency, and the fixed storyboard/reference-video
regression suites. Run a production frontend build before the final commit.
