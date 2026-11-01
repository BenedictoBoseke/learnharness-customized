# Subject folders — custom.3 validation

Version `0.4.1-custom.3`, Android code `103`; 1 November 2026. Based on `feature/sync-linked-markdown` commit `f3e11c838c3a6aede22657c63fbeb3cefff2cc24`. This feature is review work, not a merge into main.

## Automated and integration results

| Check | Result |
| --- | --- |
| Production Next.js build and TypeScript | Passed |
| Full ESLint | No errors; existing `source-name-ui.test.tsx` next/head warning |
| Focused subjects/documents/replicas/Supabase/menu suites | 65 passed, 0 failed |
| Broader learning/authentication regressions | 576 passed, 6 existing Windows-specific failures out of 582 |
| Disposable real PostgreSQL 17 | Original and additive migrations, RLS/access control, revision/idempotency assertions, v1/v2/future-version validation passed |
| Actual learning-agent flow with a local mock | 7 calls; scoped read, source proposal/review, explicit finish, once-only log and grouped checkpoint proposal passed |
| Production responsive UI with synthetic originals | Actual 320/360/393/411px viewports, Dictate, model-menu bounds, explicit owner choice, background indexing and logging-off checks passed; 1280px desktop dialog passed |
| Packaged Windows app | Trusted folder IPC, opaque/reused grants, stable IDs/originals after restart passed; picker result stubbed |
| Existing packaged Windows note workflow | Real original-file Apply/Undo, external annotations and linked-note agent proposal flow passed using a local mock |
| Actual Android SAF provider | System tree picker, persisted grants/restart, revocation, cached recovery, stable relinking, original-file Apply/Undo passed |
| Existing Android single-note workflow | Real picker, restart, permission revocation and cached recovery passed |
| Android runtime lifecycle and archive restore | Stop/restart, PID isolation, stable origin, capability rotation, attachment/archive roundtrip, retained previous library, unchanged auth hash and traversal rejection passed |
| Actual Android WebView widths | 320, 360, 393 and 411px effective widths passed; native density/size changes, not nominal viewport labels |
| Android keyboard/navigation layout | Portrait Send, strict visible/tappable landscape Send, unsent draft through rotation, keyboard then menu Back, 130% font, modal focus/labels/Back passed |
| Android release build/lint | Both arm64-v8a and x86_64 built; release lint has no errors and 16 toolchain/localization warnings |

Focused safety coverage includes Unicode/nested/duplicate names, excluded/internal notes, Windows junction escapes/root replacement, atomic editor saves, bounded CJK retrieval and pagination, stale proposal/Undo conflicts, group partial outcomes, interrupted/cancelled indexing, 300-note asynchronous discovery, explicit destination reconciliation, repeat materialization, external-content sentinel filtering, v2 offline two-replica conflict recovery and retained candidates. Lesson IDs survive fresh operation IDs, reopening and restart at the same learning boundary. Existing unused email links remain usable after rate limits; server Retry-After persists and overlapping sends are blocked.

The six broad-suite failures match the established Windows baseline: three POSIX file-mode assertions and three Unix Claude CLI fixture assumptions. They are not recorded as passing.

## Limits of these results

- Android testing used an API 34 x86_64 emulator and a separate synthetic DocumentsProvider, not a physical arm64 phone or the user's OneDrive provider. Arm64 was built and its package/signature/alignment verified, not executed on hardware.
- TalkBack is not installed on this emulator. DOM modal focus/accessible labels and native accessibility labels were checked. UIAutomator did not expose the full WebView accessibility subtree without an accessibility service; full spoken order/gesture testing remains a physical-device/TalkBack check.
- New protocol-v2 sync was tested with actual local PostgreSQL and isolated replica fixtures. The additive migration has not been installed in the user's hosted Supabase project, and live hosted PC–Android subject sync is not claimed. Install the migration and update both devices first.
- No real Obsidian notes, real desktop profile, provider credentials or personal learning data were used for write testing. No sign-in emails or paid model calls were made for this feature's QA.
- Provider writes cannot offer universal cross-file atomicity or atomic compare-and-swap against another editor. Recovery candidates, expected revisions and post-save verification remain necessary. A successful local write does not prove external folder sync has finished.

See [subject-folders.md](subject-folders.md) for setup, transport ownership, privacy boundaries, migration and recovery instructions. The Back integration uses the platform dispatcher; see [Android's Back callback guidance](https://developer.android.com/guide/navigation/custom-back/predictive-back-gesture).
