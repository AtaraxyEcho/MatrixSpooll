# Corresponding source release

This directory is mounted read-only into the MatrixSpooll application in production.

Production Compose generates this archive automatically before starting the
application. To create or verify the deliverable manually, run from the source
package root:

```bash
MATRIXSPOOLL_VERSION=1.2.0 uv run python scripts/build_source_release.py
```

The command creates a versioned ZIP archive, `source-manifest.json`, and
`SHA256SUMS`. Generated artifacts are intentionally ignored by Git. Back them
up with the release and keep the directory mounted for as long as that version
is offered to users over the network.
