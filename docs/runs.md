# How Runs work

## Sandboxed workspace

Agents set to Assist or Act get a shell (`runner_shell`) and can edit files in
the Run's temporary worktree.

Each command runs in an operating-system sandbox: `sandbox-exec` on macOS and
bubblewrap on Linux. In the sandbox:

- There is no network.
- Writes are possible only in the worktree and a private temporary folder.
- There is no access to the credentials of the Runner, Pi, SSH, cloud
  providers, the GitHub CLI or the keychain.
- There is no access to Desktop, Documents or Downloads.

The Runner attaches the changes to the result as a proposed patch. It never
commits or pushes them.

If there is no sandbox, Agents get only the read-only tools.
`tako-runner doctor` shows which mode applies. On Linux, install
`bubblewrap`.

## Local run archive

The Runner keeps each Run's tool timeline and result in
`~/.takonaut/runs/<run-id>/` for 7 days. Only the owner can read the folder.
The Runner does not upload it.

- To change the number of days, set `TAKONAUT_RUNNER_ARCHIVE_DAYS`.
- To turn off the archive, set `TAKONAUT_RUNNER_ARCHIVE_DAYS=0`.

Takonaut receives only counts: tool calls, commands, changed files and
duration.

## Several repositories in one Run

An Agent that reads several repositories gets one Run for each event.

- The Runner checks out one repository as the working directory.
- It checks out the other repositories in
  `~/.takonaut/runner-worktrees/<run>.context/<name>/`.
- Each repository is at the exact commit that Takonaut sent.
- The file tools take a `repository` argument to work in each repository.
- The Agent can change the repositories listed under **May change** in
  **Code it reads**. By default, this is all of them. These repositories are
  writable in the sandbox. The other repositories are read-only. This
  includes the working directory if it is not in the list.
- `open_pull_request_with_changes` collects the changes from each repository
  that the Agent changed. After a person approves, Takonaut opens one linked
  draft pull request in each repository.
- If this machine does not have a clone of a repository, the Run page shows
  it and the Run continues without it. To add the clone, run
  `tako-runner setup` in its folder.
- Takonaut prefers a Runner that has all the repositories.

## Follow-ups

A person can ask a follow-up on a Run with **Ask the Agent a follow-up** on a
ticket or Run page.

- If this machine ran the earlier turn, the follow-up continues the same Pi
  session. The Agent keeps what it already read and gets only the new
  question.
- The follow-up runs on the same commit.
- The Runner that ran the earlier turn gets the first 60 seconds to take the
  follow-up. After that, another Runner can take it and starts from the
  earlier result.

The Runner keeps sessions in `~/.takonaut/threads/<thread>/<run>/` for 24
hours after the last turn. Only the owner can read them. They contain the
Agent's tool results, which include code that it read.

- To change the hours, set `TAKONAUT_RUNNER_THREAD_HOURS`.
- To keep no sessions, set `TAKONAUT_RUNNER_THREAD_HOURS=0`.

## Writing standard

Takonaut sends its writing standard with each Run (Tako Runner 0.12.2 and
newer).

- The Runner adds the standard to the Agent's instructions, after the
  Profile's own text.
- If the Profile already contains the standard, the Runner does not add it
  again.
- If Takonaut does not send a standard, the instructions do not change.

## Planning turns

The Runner runs Planner turns from Planning Studio. These Runs have mode
`planning`. A planning turn is read-only:

- It uses a detached worktree at the commit that the Grill session pinned.
- It gets only the tools that the Planner Profile grants.
- It does not write to the repository, push or open pull requests.
- Its result goes back to Takonaut as a Draft. It is not published.
- The prompt marks untrusted text as data. This includes the instruction,
  the ADRs in force and the session context.

The Runner keeps the Pi session of a Grill session warm between turns, one
session for each member who asks.

| Setting | Default | Environment variable |
|---|---|---|
| Folder | `~/.takonaut/planning/` (owner only) | `TAKONAUT_RUNNER_PLANNING_SESSIONS` |
| Warm time after the last turn | 30 minutes | `TAKONAUT_RUNNER_PLANNING_WARM_MS` |

### Host a Grill

A team can select this Runner to host a Grill (Grill v2, Tako Runner 0.10.0
and newer).

- Each member's turn continues the Grill's one shared session in
  `~/.takonaut/planning/<grill>/shared-g<generation>/`. The session stays
  warm for one day.
- The session uses the model that the team selected. If that model is not
  available, the Run fails. It does not use a different model.
- A new generation starts when the host or the model changes, or when a
  person selects **Rebuild session**. The new session starts with the Grill
  so far and the Project's Grill prompt in the system prompt.
- A side branch has its own session in `branches/<branch>/`. It is copied
  from the main session on its first turn. Its Runs get no write tools.

## Mockups

Tako Runner 0.11.0 and newer runs Mockup Runs. A person can ask a Project's
Agent to draft a new Mockup. A person can also ask the Agent to regenerate a
Mockup from the team's pin and area comments.

- The Run has mode `mockup`. It is read-only, like a planning turn.
- The code is checked out at a pinned commit, so the Agent can match the
  product's UI.
- The Agent gets only the organization tools that it is granted. It changes
  nothing.
- The claim contains the current source, the comments and where they point,
  the request, and the published text of the work item.
- The Agent answers with the complete new source in one `takonaut-mockup`
  block. Takonaut checks it, publishes it and marks the comments as
  addressed.
- Any Runner of the Project and repository can run it, if the Agent's
  **Runs on** setting allows that Runner.

## Process supervision (macOS and Linux)

Each analysis runs Pi in a separate worker process
(`tako-runner __analysis-worker`, internal) in its own POSIX process group.

- The worker receives the claim on stdin.
- The Runner removes `TAKONAUT_RUNNER_TOKEN` from the worker's environment.
- The worker runs as the same operating-system user. Thus it is not a
  sandbox: the worker can still read that user's `0600` credential file.

### Heartbeats and fencing

- The Runner sends one heartbeat at a time, every third of the lease.
- The Runner fences the claim if a heartbeat is rejected. It also fences the
  claim if no heartbeat succeeds within two thirds of the lease, counted from
  the first heartbeat.
- Fencing and the kill grace period end before the 30-second minimum lease
  expires.
- A fenced claim never reports usage or a result.

### Stopping the worker

- stdin stays open as a lifeline. If the Runner process stops for any reason
  (crash, SIGKILL, or Ctrl-C during `once`), the worker reads EOF and stops
  its own process group.
- Fencing and daemon shutdown (SIGINT or SIGTERM) send SIGTERM to the
  worker's process group. After 5 seconds, they send SIGKILL.
- The daemon waits until the whole group stops. Then it removes the worktree
  or claims more work.
- Daemon shutdown stops in-flight analysis and reports it as failed.

### Stop marker

If the Runner cannot make sure that the process group stopped:

1. It keeps the claim's worktree.
2. It writes a stop marker, `runner-supervision-stop.json`, next to
   `runner.json`, with mode `0600`.
3. It exits.

A daemon does not claim work while the marker exists. This includes a
daemon that the Homebrew service restarts with `keep_alive`.

To continue:

1. Look for Runner and Pi processes that are still running, and stop them.
2. Run `tako-runner clear-stop`.

### Limits

- `tako-runner once` does not check the stop marker. Only the daemon checks
  it.
- A child process that leaves the process group, for example with `setsid`
  or as a daemon, is outside this guarantee.
- The lifeline does not help if the worker itself is frozen, for example
  with `SIGSTOP`.
- Git commands that prepare and remove worktrees have no separate time
  limit.
- Shared Project context builds run in the daemon. See
  [Shared Project context builds](shared-context.md).
- Automatic delivery execution is not enabled.
