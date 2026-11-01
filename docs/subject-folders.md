# Subject folders and Android usability

This feature extends the shared Windows/Android app and its original-note editing service. It does not import an Obsidian vault into a replacement editor. Original files stay with their selected filesystem/document provider.

## Link an existing subject

Open **Subjects → Link subject folder** on Windows or Android. On Android the operating system must expose that folder through a compatible Storage Access Framework provider; a Windows OneDrive path cannot be pasted into an Android binding.

Review the discovered Markdown notes, exclusions and synchronization owner, then choose **Link and index selected notes**. A Chinese subject might contain:

```text
Chinese/
  HSK 1.md
  HSK 1 - Checkpoint.md
  HSK 1 - Lesson Log.md
```

Use the suggested roles or choose them individually. Role suggestions do not take effect until confirmed. Other notes can be source/reference material. Merely discovering a note never enables live conversation logging. Automatic completed-lesson logging is off initially; choose a log and enable it explicitly if desired.

Start a subject session with **New session**, or open Subject from an existing session and choose **Use for this session**. Each session has one active subject. **Resume subject** opens the checkpoint and offers the related sessions; it does not start a model request. Synced conversations still require the separate **Resume here** gate before inference can continue.

At an explicitly sent learning turn, the teacher receives bounded context from the checkpoint, recent log and relevant source sections. Subject tools list/search/read included notes by logical IDs, with revision and relative-path citations. Folder context uses a local lexical index, not a paid embedding service. General filesystem tools in a subject session are limited to explicitly selected attachments or separately linked notes; folder notes use the scoped subject tools.

## Finish a lesson and update originals

1. Resolve any pending quiz/problem, then open the subject from that session and choose **Finish lesson**.
2. Review the prepared finish request and put it in the lesson composer. Sending it uses the normal selected-provider flow; opening a subject never starts inference.
3. The teacher summarizes covered material, demonstrated progress, mistakes/weak points and next review. It can record the explicitly requested lesson and propose a checkpoint/source update in a related review group.
4. If automatic log append is enabled, one stable marked lesson block is appended to the selected original log. Otherwise review the summary and explicitly apply its log append. Checkpoint/source prose always requires review.
5. Open the relevant note or group, inspect before/after and reason, then Apply or Reject selected edits. Undo checks the actual applied revision and refuses to overwrite later external changes.

Groups preflight selected files, record each outcome and stop on conflicts/failures. They do not claim cross-file atomicity. After a partial operation, successful files stay successful and remaining files can be reviewed/retried. Private journals/backups preserve recovery candidates. A cloud provider can still fail between checks or perform partial writes; successful saves are verified by reading the original again.

Original UTF-8 text, frontmatter, links, comments, block IDs, callouts, tables and unrelated line endings remain outside focused replacements. Unsupported encodings are rejected safely. Human changes to app-managed blocks are preserved. No original note is automatically renamed or deleted.

## Choose one owner for original-note synchronization

**External folder/provider** is appropriate when another service already carries the Obsidian files. Each device binds its own local copy. LearnHarness synchronizes subject/note identity, relative paths, roles, session associations and learning progress, not the source-file snapshots, local index, raw external-note read/edit tool payloads or local recovery copies. External proposal bodies remain on their originating device and must be reviewed there. Ordinary lesson messages and learning graph/progress still synchronize; quoted note text in an ordinary conversation is not removed.

LearnHarness cannot verify that OneDrive, Obsidian or another external service has completed a remote transfer. Subject status distinguishes local indexing/binding/writes from progress synchronization.

**LearnHarness carries note content** is explicit opt-in. On another device, select a destination folder and review every file: same content can bind, different content needs a local/synced choice, and missing notes are created only when explicitly selected. Skipped notes stay unbound. Existing local content is rechecked immediately before a write. Repeated materialization does not create duplicate filenames or note identities.

Changing owners pauses automatic logging and rechecks originals. Resolve existing file conflicts first. Previously uploaded immutable app-managed revisions are not retroactively removed by switching to external mode.

## Sync migration and older clients

Existing projects already using progress sync need the additive SQL:

```text
supabase/migrations/202611010002_subject_workspaces.sql
```

Fresh projects run `202611010001_learning_sync.sql` first, then the subject migration. Both retain account-private policies and the existing immutable blob bucket. No service-role key belongs in either app.

Update both Windows and Android before enabling subject sync. A library with subjects uses protocol v2 so older clients refuse it before import instead of dropping unknown records. Ordinary v1 libraries remain supported. After upgrading a library, keep using updated clients; do not force its manifest back to v1. Local learning remains available when the server needs the migration.

For rollback/recovery, retain the pre-update library export and local recovery history, reinstall a compatible updated build, and use the app's explicit recovery choices. Database migration rollback is not a way to downgrade a populated v2 library. Do not delete original notes or native grants to troubleshoot sync.

## Bounds, freshness and providers

Initial bounds: 5 MiB per note, 10,000 included Markdown notes, 25,000 visited entries, depth 32 and 250 MiB total cached/indexed text per subject. Reaching a bound leaves a partial index with reasons; narrow inclusion rather than assuming every file was read. Lists/search/tool windows are bounded separately.

Dot/internal directories, `.pi`, `.obsidian`, `.git`, trash, generated runtime directories and backup files are excluded by default. Notes can be nested and have Chinese filenames. Duplicate link basenames are ambiguous; a content hash alone never merges two notes. Supported in-root wikilinks, aliases, headings/block anchors and Markdown references resolve through the included index. Unsupported embeds/out-of-root links are reported; scripts/plugins are not executed.

Desktop watchers are debounced hints. Refresh also occurs after app writes, explicitly and on foreground return. Partial/provider-failed scans do not mean files were deleted. Unavailable notes retain caches and an actionable error; exclusions prevent further subject-tool reads of those notes. The cache never silently wins over a newer original.

Android uses persisted tree grants, child provider URIs and checked write capabilities. Folder listing and file access use ContentResolver. Some cloud providers support only read-only or individual-file access; use those fallbacks or a compatible local folder. A move, provider account change or revoked grant can require **Relink folder**.

Generated runtimes from obsolete installed Android versions are cleaned separately from original data, accounts, document grants and recovery history.

## Android controls

The mobile toolbar wraps rather than collapsing Dictate. Dropdown geometry stays within the visible viewport. Interactive regions use Android-sized targets; native Attach/More targets are larger and labeled. Back dismisses the keyboard and then the topmost registered menu/dialog before navigation. Note/subject review, settings sections and long paths have mobile layouts. Email verification remains visible after sender limits or reopening settings, and an actual server Retry-After can prevent another premature send without blocking use of an existing link.

With a short landscape keyboard open, the native/session/model toolbars temporarily give their space to the answer/send surface. Dismissing the keyboard restores those toolbars. This keeps the original composer and its draft mounted through rotation.

Desktop styling remains dense where appropriate. Emulator testing does not establish behavior on every physical phone or cloud provider; check the release test report for actual coverage.

## Development checks

Run the focused subject, original-document, replica, auth and menu-placement suites with `NODE_ENV=test`. `scripts/test-sync-database.mjs` validates the original and additive migrations in disposable PostgreSQL. `scripts/qa-subjects-ui.mjs` drives the production UI against a synthetic folder and a local fixture with no inference. `scripts/qa-subject-learning.mjs` exercises actual learning-agent tools using only a local mock model.

The separate Android test APK includes a QA DocumentsProvider. Run `ai.learnharness.mobile.test/ai.learnharness.mobile.LinkedDocumentTest` with `-e suite subjects` on a disposable emulator for the real system tree picker, original child reads, non-logging registration and reviewed Apply/Undo. Test/provider components do not ship in release APKs.

`scripts/qa-desktop-subjects.mjs` checks packaged Electron folder IPC, reused opaque grants, original-file reads and restart persistence in a temporary profile. Its picker result is stubbed; the trusted IPC and filesystem adapters are real. `scripts/qa-subject-android.mjs` changes only a disposable emulator's display/font settings, restores them afterward, and checks actual WebView widths, keyboard/send hit regions, hardware Back, rotation and modal focus using a local model-catalog fixture. No model inference or sign-in mail is required. Set `LH_QA_SKIP_WIDTHS=1` to rerun only its keyboard/lifecycle layout portion.

Build the shared runtime with `node scripts/build-custom.mjs --android`, then the Android APKs with the configured Gradle toolchain. Windows uses the same source with `--windows`. See `sync-linked-markdown.md` for the pinned native runtime, existing regression harness and auth separation.
