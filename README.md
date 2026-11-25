# Tako Runner

Tako Runner runs Takonaut Project Agents on your own machine. It runs Pi on
the exact Git commit that Takonaut sends. Your source code and the raw Pi
transcripts stay on the machine.

- Tako Runner is a standalone service. It is not a Pi package or a Pi fork.
  It uses Pi through the Pi SDK.
- Tako Runner is not Tako Bridge. Tako Bridge is a Pi extension that one
  person uses interactively. Tako Runner is a machine that an organization
  owns. It runs without a person, and only for the Projects that Takonaut
  allows.

## Security

- The machine credential can claim only work that Takonaut assigns to it. Each
  claim gets a short-lived Run token.
- Takonaut selects the repository and the exact 40-character commit SHA.
- Each Run uses a new detached Git worktree and a new Pi session.
- Agents get only the tools that their grant allows. By default these are
  read, list, find, grep and diff.
- The Runner refuses sensitive paths, symlink escapes, pushes, merges and
  deployments.
- Changes that an Agent proposes go to the Review queue in Takonaut. A person
  approves them.
- Model usage on your own provider account does not use Takonaut AI credits.
- The Runner does not load third-party Pi packages into Runs, because Pi
  packages can run any local code.

To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Requirements

- macOS or Linux. Windows is not supported.
- Git
- Bun 1.2 or newer
- Pi 0.84 or newer, signed in to a model provider for this operating-system
  user
- On Linux, `bubblewrap` for the sandboxed shell
- A Takonaut administrator who can approve the Runner

## Install

```bash
brew install TakonautHQ/tap/tako-runner
```

If you add the tap first, trust the formula before you install it:

```bash
brew tap TakonautHQ/tap
brew trust --formula TakonautHQ/tap/tako-runner
brew install tako-runner
```

To install from source, see [Setup](docs/setup.md#install-from-source).

## Set up

```bash
tako-runner setup --url https://takonaut.app
```

Setup does these steps:

1. It checks Git and Pi.
2. It opens Takonaut in your browser. An administrator approves the machine
   and selects its organization, name, capacity and Projects.
3. It clones each repository of those Projects into
   `~/.takonaut/repos/<owner>/<name>`.
4. It starts the background service (Homebrew). Add `--no-service` to skip
   this step.
5. It runs `tako-runner doctor`.

The Runner works only in its own clones. It never works in a developer's
checkout. For other setup methods, see [Setup](docs/setup.md).

## Run the service

```bash
brew services start tako-runner
brew services restart tako-runner   # report changes to Takonaut now
brew services stop tako-runner
brew update && brew upgrade tako-runner
```

The log is in `$(brew --prefix)/var/log/tako-runner.log`.

In Takonaut, open **Settings → Execution → Runners** to see the Runner's
health, capacity, repositories, Agents and credentials. Open **Runs** to see
the history of each Run. If a publication to an outside service failed, you
can retry it there. The retry uses the stored findings and does not run Pi
again.

## Commands

| Command | What it does |
|---|---|
| `tako-runner doctor` | Checks everything the Runner needs. Each failed check has a fix. |
| `tako-runner status [--json]` | Shows the server, service, repositories and connectors. |
| `tako-runner repos sync` | Clones repositories that people added to the Runner's Projects since setup. |
| `tako-runner repos list` | Lists the repositories of the Runner. |
| `tako-runner models` | Lists the models the Runner can use and its default model. |
| `tako-runner tools` | Lists the organization tools and if each tool is ready. |
| `tako-runner secrets set NAME` | Stores a secret on this machine. The value is not shown. |
| `tako-runner connector add NAME -- COMMAND` | Adds a local MCP server for logs or other evidence. |
| `tako-runner diagnostic-bundle` | Makes a support file without credentials or source code. |

Run `tako-runner --help` for all commands and options.

## Models

The Runner uses the models that Pi is signed in to. You can also add an
OpenAI-compatible endpoint, for example LiteLLM, Ollama or OpenRouter.

```bash
tako-runner models add litellm --from-pi
tako-runner models default litellm/gpt-6.1-sol
tako-runner models test --all
```

Set a default model. If there is no default, an Agent that does not select a
model gets Pi's default, and your login can refuse that model. For more, see
[Models, tools and connectors](docs/models-tools-connectors.md).

## Files on this machine

All files are in `~/.takonaut/` and only the owner can read them.

| File or folder | Contents |
|---|---|
| `runner.json` | Public configuration |
| `runner-credentials.json` | Machine credential (mode `0600`) |
| `secrets.json` | Tool secrets |
| `models.json` | Model endpoints and the default model |
| `runner-connectors.json` | Connector commands and their environment |
| `repos/` | Repository clones |
| `runs/<run-id>/` | Tool timeline and result of each Run, kept for 7 days |

## Get help

1. Run `tako-runner doctor` and do the fix that it shows.
2. If the problem continues, run `tako-runner diagnostic-bundle` and send the
   file to support. The bundle does not contain credentials, source code, Pi
   transcripts, tool output or absolute local paths.

## What's new in 0.12.3

Planner turns in a Grill read the code. A planning Run always gets the
repository read tools (`runner_read`, `runner_list`, `runner_find` and
`runner_grep`). It reads every repository that the Grill pinned, at the
pinned commit, and never changes one. Older Runners give these tools only
when the Planner Profile grants them. Takonaut shows a warning in Get ready
for a Grill that runs on an older Runner. See [Runs](docs/runs.md).

## Documentation

- [Setup](docs/setup.md): other setup methods, Agent selection,
  configuration safety and install from source
- [How Runs work](docs/runs.md): the sandbox, several repositories,
  follow-ups, the writing standard, planning turns, Mockups and process
  supervision
- [Models, tools and connectors](docs/models-tools-connectors.md)
- [Trusted Native mode](docs/trusted-native.md)
- [Shared Project context builds](docs/shared-context.md)
- [Developer reference](docs/developer-reference.md): API client, delivery
  adapter, tests and releases

## License

Apache-2.0. See [LICENSE](LICENSE).
