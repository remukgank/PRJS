---
name: Vidoy CDN response
description: External Vidoy upload responses can be malformed even when the upload request may have reached the CDN.
---

The Vidoy upload endpoint has returned PHP `Deprecated` and `Warning` output instead of the JSON status payload expected by the uploader. A malformed response is ambiguous: the CDN may have accepted the file even though the client reports an invalid status.

**Why:** Blindly retrying an ambiguous upload can create duplicate files.

**How to apply:** Before retrying an upload with an invalid/non-JSON CDN response, reconcile the exact target filename against the Vidoy folder listing. Classify PHP-warning responses separately from authentication failures.