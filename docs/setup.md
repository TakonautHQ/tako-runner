# Setup

This page tells you how to set up a Runner in ways other than the default
`tako-runner setup --url https://takonaut.app`. It also tells you how
Takonaut selects the Agents that a Runner runs, and how the Runner protects
its configuration.

## Use an existing checkout

To use a repository that is already on the machine, run setup with
`--path`:

```bash
tako-runner setup --url https://takonaut.app --path /absolute/path/to/repository
```

Each run of `setup` in a repository folder maps one more repository.

## Set up many machines with a key

For fleet provisioning, use the one-time `tkr_...` credential that Takonaut
makes. Read it into the environment so that it is not in the shell history:

```bash
read -rs TAKONAUT_RUNNER_TOKEN
export TAKONAUT_RUNNER_TOKEN

tako-runner setup \
  --url https://takonaut.app \
  --org YOUR_ORGANIZATION_ID \
  --path /absolute/path/to/repository \
  --project-id YOUR_PROJECT_ID \
  --repository-id YOUR_REPOSITORY_ID

unset TAKONAUT_RUNNER_TOKEN
```

- Run `map` one time for each repository:
  `tako-runner map PROJECT_ID REPOSITORY_ROOT --repository-id REPOSITORY_ID`.
- With repository IDs, one Project can have several repositories. The Runner
  reports its repositories to Takonaut before it claims work.
- Local paths stay in the Runner configuration file. They are not sent to
  Takonaut.
- Use the lower-level `enroll`, `configure` and `map` commands only for
  scripted provisioning with complete repository and Project IDs.

## Browser approval

`tako-runner setup` opens Takonaut in your browser. A signed-in administrator
approves the organization, Runner name, capacity and allowed Projects.

- Browser approval makes a machine credential for the Runner. It does not
  install the administrator's user session or a Tako Bridge credential.
- Takonaut sends the credential one time and keeps only its hash.
- If the response is lost after Takonaut makes the Runner, the CLI shows the
  Runner ID if it can. The Runner ID is not secret. Rotate or revoke that
  Runner in Takonaut, then enroll again.
- Setup does not replace an existing configuration unless you add `--force`.
  A replacement clears the repository mappings, so Projects from another
  organization do not stay on the machine.

## Which Agents a Runner runs

Takonaut decides which Agents a Runner runs. You set this in Takonaut, not on
the machine.

- On an Agent's page, **Runs on** has two options: **Any Runner that can run
  it** (the default) or **Only these Runners**.
- A Run goes to the least busy allowed Runner that has all of these:
  - the Project and the repository
  - every tool that the Agent needs, with all of its secrets set
  - the Agent's model
- The **Runs on** list shows each Runner and what it does not have.
- You can keep a machine for specific Agents, for example a machine with
  production access. To do this, turn on **Only run Agents that choose it**
  on its Runner card. Then only Runner administrators can add it to an Agent's **Runs on**
  list.

The Runner reports its repositories, connectors, ready tools and models when
it starts. It reports again when a tool becomes ready or stops being ready.
It checks every 5 minutes. To report at once, run
`brew services restart tako-runner`.

The Runner runs as many Runs at the same time as the capacity set in
Takonaut. Each analysis stops after 20 minutes by default.

## Configuration files

| File | Contents |
|---|---|
| `~/.takonaut/runner.json` | Public configuration. It contains the Trusted Native public key and key ID, if they exist. |
| `~/.takonaut/runner-credentials.json` | The machine credential and the optional Trusted Native Ed25519 private key. Mode must be `0600`. |

The Runner checks the owner of both files and of their directory.

To use other paths, for isolated development only:

```bash
export TAKONAUT_RUNNER_CONFIG=/path/to/runner.json
export TAKONAUT_RUNNER_CREDENTIALS=/path/to/runner-credentials.json
```

## What the Runner refuses

The Runner does not start in these conditions:

- It runs as root.
- The server URL is not HTTPS. Loopback development URLs are the only
  exception.
- A configuration path is a symlink.
- A configuration file or directory has the wrong owner.
- Group or others can read the configuration directory or its files.

If group or others can read an existing `~/.takonaut`, do one of these:

- Make the directory private: `chmod 700 ~/.takonaut`.
- Set `TAKONAUT_RUNNER_CONFIG` and `TAKONAUT_RUNNER_CREDENTIALS` to files in a
  different directory with mode `0700`.

## Group-writable parent folders

The Runner refuses a configuration path below a folder that other accounts
can write to. Another local account could replace the configuration, the
credentials or the repository paths.

For a temporary test on a volume whose mount point is group-writable, allow
that one folder in each command:

```bash
tako-runner setup \
  --url https://takonaut.app \
  --allow-unsafe-ancestor /Volumes/External

tako-runner start --allow-unsafe-ancestor /Volumes/External
```

You can also set the folder in the environment for one command:

```bash
TAKONAUT_RUNNER_ALLOW_UNSAFE_ANCESTOR=/Volumes/External tako-runner start
```

- The path must be absolute. It matches only that exact folder.
- It does not change the checks for owner, symlinks, credential modes or
  other writable folders below it.
- It does not make a group-readable configuration directory acceptable.
- `--start-service` does not keep the override for the service. Use the
  foreground command for temporary tests.

## Install from source

```bash
git clone https://github.com/TakonautHQ/tako-runner.git
cd tako-runner
bun install --frozen-lockfile
bun link
```

Then run `tako-runner setup --url https://takonaut.app`.
