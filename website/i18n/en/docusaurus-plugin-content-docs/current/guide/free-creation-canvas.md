---
id: free-creation-canvas
title: Free creation and infinite canvas
sidebar_position: 3
update_docs: engine-b
---

# Free creation and infinite canvas {#free-creation-canvas}

Free creation generates images or videos directly from prompts and references without requiring source files, episodes, scripts, or storyboards. It still lives inside a project, so parameters, media, generation records, and canvas positions persist.

## Start from home {#start-from-home}

The home composer creates a free-creation project and derives a short project name from the prompt. Image, video, and Agent modes expose model, ratio, resolution, quantity, and duration controls according to the selected model’s declared capabilities. Invalid combinations should fail before enqueueing instead of being silently replaced.

Image dimensions follow the ratio and resolution. Video mode sends the prompt directly to the video model. A text model participates only in Agent mode, where it interprets intent and orchestrates tools.

## References {#references}

- **Universal reference** maps uploaded files to image, video, audio, or prompt context by file type.
- **First and last frames** show separate cards and allow swapping when the model supports this capability.
- **Canvas binding** uses `Ctrl + click`; regular click selects and double-click previews.

Changing the model revalidates reference types, counts, ratio, resolution, and duration.

## Canvas operations {#canvas-operations}

- Pan empty space freely and zoom down to 40%.
- Smart guides appear when dragged edges or centers approach another element.
- Single and marquee selections support group, hide, and delete operations.
- Use `Ctrl + Z` to undo and `Ctrl + Y` to redo.
- Double-click images and videos for an adaptive preview; video cards retain a play action.
- Video merge, subtitles, proxies, and thumbnails require FFmpeg.

### Subtitle and audio derivations {#subtitle-and-audio-derivations}

A subtitle track is an independent canvas card. Click to select it, drag to move it, double-click to edit it, or use its context menu to edit, hide, render, or delete it. It can also be grouped with a video. Before rendering, the source video connects to the subtitle. After rendering, that relation becomes “source video → subtitled video” plus “subtitle → subtitled video”. The result is placed to the right of the subtitle card when space is available and still passes collision detection.

Audio composition retains both the video and audio as sources and creates a new video without modifying either original. The result is placed to the right of its source media. Subtitle rendering and audio composition require FFmpeg.

## Project parameters {#project-parameters}

The latest valid model, ratio, resolution, quantity, and duration are stored per project. The ratio selected at project creation becomes the initial workspace value.
