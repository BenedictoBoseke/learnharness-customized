# Progress sync and linked Markdown

This fork builds the desktop and Android apps from the same LearnHarness 0.4.1 source. The earlier Android 0.4.0 port supplies the native host and platform adapters; it is no longer a copied installed desktop bundle. Existing native chat and graph version-1 records remain authoritative and need no destructive migration. Unsupported future versions are refused. Android keeps the same application ID and upgrades version code 100 to 101 without clearing its library.

## Setup and use

Create a Free Supabase project, run `supabase/migrations/202611010001_learning_sync.sql`, and keep the default email templates. Copy the original sign-in link from the email without opening it, and paste it into the app. It verifies the token hash directly with the configured project and never follows the redirect to localhost. Numeric email codes also work if custom templates are configured. Free projects may lock template editing without custom SMTP; editing is not required. The built-in sender requires the sign-in address to be an organization team member and has a low shared hourly limit. Use custom SMTP for broader use. Enter the project URL and publishable key in **Settings → Sync**, sign in separately on each device, create a library on the first device, and join it on the second. Never put service-role keys in either app.

Data is account-private with database/storage row-level policies and HTTPS. It is host-readable, not end-to-end encrypted. Free project inactivity pauses and storage quotas can interrupt sync without deleting the device's working library. No paid project is required.

Sync includes native conversations, submitted answers/reasoning, plans, completed job records, practice records, the graph/provenance family, linked-note data, and explicitly registered referenced attachments. Each session's model preference rides its native record, but available authentication and model connections are validated on the receiving device. General settings, model credentials, machine paths, native file permissions, active turns, and job execution remain device-local. Running jobs are omitted; completed foreign jobs cannot be recovered as local work.

Synchronization uses immutable SHA-256 blobs and transactional parent-revision comparison. File payloads use 4 MiB chunks, with a 64 MiB per-file limit. Missing manifest entries represent deletions relative to the recorded common base; stale devices cannot silently resurrect deleted records. Local staging journals and recovery manifests preserve interrupted imports. Retries reuse the durable operation identity and do not repeat inference.

Non-overlapping records reconcile automatically. A conversation is an indivisible ordered record; concurrent versions are never merged as message arrays. The graph family is also an indivisible consistency group. Conflicts require an explicit local/remote choice with the other version retained in recovery. Two populated libraries require an initial choice. This is sequential cross-device learning with recoverable offline conflicts, not a simultaneous collaborative editor. An adopted session requires **Resume here** before its agent can continue.

## Notes

Open **Note** in a session header and choose an existing Markdown document. Authorized lesson logging writes stable, marked blocks in that original file; backfill is idempotent. Pausing logging retains the link. Only visible lesson material is logged: answers, solutions, and explanations remain hidden until their original app result reveals them. Human frontmatter and annotations are preserved.

Ask the agent to read or revise a particular paragraph. Linked sessions receive `read_linked_document` and `propose_document_edit`; these tools cannot approve their own changes. A proposal contains an exact unique passage, replacement, and read revision. Review the diff and use Apply, Reject, or Undo. Editing the note does not modify audited quiz answers or graph evidence.

Each note has a portable identity and a separate local binding. On desktop an explicitly selected file grants access. Android uses `ACTION_OPEN_DOCUMENT`, persists the offered URI permission, checks provider write support, and updates the selected provider document through `ContentResolver`. Device paths and URI grants never synchronize. Bind the same synced note to a suitable local file on each device.

Choose app-managed document synchronization, or external synchronization when Obsidian/folder/provider sync already carries the file. External mode sends identity/relationship metadata rather than the file content. Conflicting file and app revisions need an explicit choice. Human changes to generated blocks can be retained/frozen while later blocks append. Private backups and a write-ahead intent preserve the cached previous revision and proposed change if a provider partially saves or a completion response is lost. Arbitrary providers cannot offer a universal atomic compare-and-swap against external editors.

Revoked, read-only, moved, or unavailable documents retain cached learning material and expose an error/relink action. Single-document Android grants do not include sibling images or whole directories; register attachments explicitly or use an external folder-sync service. Notes are UTF-8, up to 5 MiB. Recovery history is retained locally and immutable cloud blobs consume storage; there is no automatic history pruning in this version.

## Builds and checks

Use Node 24 and `npm ci`. Build the shared server and Windows installer with `node scripts/build-custom.mjs --windows`. The installer is unsigned. The customized build skips the upstream auto-update feed unless `LH_UPDATE_FEED` is explicitly configured.

For Android, install JDK 17, SDK 36, NDK 28.2.13676358, and CMake 3.22.1. Run `scripts/restore-android-runtime.ps1` to restore checksum-pinned third-party Node libraries and headers, configure SDK locations in `android/local.properties`, then run `node scripts/build-custom.mjs --android` and `android/gradlew.bat -p android assembleRelease lintRelease`. The arm64 and x86_64 APKs use the existing port's local development signing identity, not a Play Store signing identity. `mobile/RUNTIME-PROVENANCE.json` records the runtime origin.

Checks:

```powershell
$env:NODE_ENV='test'
node --import tsx --test tests/sync-replicas.test.ts tests/linked-documents.test.ts tests/supabase-sync.test.ts
node scripts/test-learning-regressions.cjs
node scripts/test-sync-database.mjs # Docker required; disposable PostgreSQL fixture
node scripts/qa-desktop-documents.mjs # packaged Windows app; isolated profile
```

The separate Android test APK includes a DocumentsProvider and instrumented system-picker tests; none of these provider/debug components ship in the release app. Use the consolidated runner `ai.learnharness.mobile.test/ai.learnharness.mobile.LinkedDocumentTest` with `-e phase first`, force-stop the target, then rerun with `-e phase restart`. The `revoke` and `revoked` phases check cached-note recovery and explicit relinking across a process restart. The same runner dispatches the original runtime and library-restore tests with `-e suite lifecycle` and `-e suite restore`. These are restricted to disposable emulators.

Provider subscriptions and model API credentials are independent of Supabase sign-in. A sync account error must never ask for a model API key. Initial and conflict choices include a per-device inventory with session counts/previews, note and attachment counts, graph nodes, and completed jobs. Existing BYOK, ChatGPT, Copilot, and other provider flows remain the original application code.
