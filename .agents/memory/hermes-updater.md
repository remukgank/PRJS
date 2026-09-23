---
name: Hermes updater
description: Hermes update requires its install directory to be a standalone Git checkout.
---

The Hermes CLI can run from `/home/runner/workspace/.hermes/hermes-agent/venv`, but its updater checks for `.git` inside the Hermes install directory. The parent PRJS repository does not satisfy that check.

**Why:** Linking Hermes to the PRJS `.git` would make a Hermes update operate on the application repository.

**How to apply:** If `hermes update` reports “Not a git repository”, use the official Hermes installer to repair/reinstall the Hermes checkout. Do not create a `.git` symlink to the PRJS repository.