---
id: assets-and-references
title: Assets and references
sidebar_position: 7
update_docs: engine-b
---

# Assets and references {#assets-and-references}

MatrixSpooll separates reusable global assets, project definitions, and free-canvas references so a reusable identity is not confused with one request’s input.

## Three levels {#three-levels}

1. The **global asset library** stores reusable character, scene, and prop records.
2. **Project assets** in `project.json` are the source of truth for that workflow project.
3. **Canvas references** are uploaded image, video, audio, and text files that affect generation only when bound to a request.

Scripts refer to project assets by name rather than duplicating full definitions. Product counts, state, and duration in summaries are derived from existing artifacts.

## Import and preview {#import-and-preview}

The canvas accepts common image, audio, video, screenplay, and story-description files. Text becomes prompt context rather than publishable media. Double-click previews an item, `Ctrl + click` binds it to the composer, and regular click only selects.

## Capability linkage {#capability-linkage}

After references are bound, the composer exposes universal reference or first/last-frame controls according to model capabilities and validates allowed types and counts. Universal reference maps file types internally without exposing parameter names such as `reference_image` or `prompt_context`.

Request records preserve upstream reference claims. Grouping is only canvas organization and does not fabricate a generation artifact or rewrite derivation history.
