# Models, tools and connectors

## Models

The Runner uses the models that Pi is signed in to on this machine. You can
also add OpenAI-compatible endpoints. The Runner reports the models that it
can use to Takonaut. An Agent that selects a model goes to a Runner that has
that model.

```bash
tako-runner models                              # models, the default and endpoints
tako-runner models add litellm --from-pi        # use Pi's LiteLLM login (URL and key)
tako-runner models add ollama --base-url http://localhost:11434/v1
tako-runner models add router --base-url https://openrouter.ai/api/v1 --key-secret OPENROUTER_KEY
tako-runner models default litellm/gpt-6.1-sol  # for Agents that do not select a model
tako-runner models test --all                   # stop reporting models that your login refuses
tako-runner models remove NAME
```

### Default model

Set a default model. If there is no default, an Agent that does not select a
model gets Pi's built-in default. Your login can refuse that model. For
example, a ChatGPT Codex login refuses `gpt-5.5`. `tako-runner doctor` warns
when there is no default.

If an Agent selects a model that the Runner does not have, the Run uses the
Runner's default model.

### Endpoints

- Endpoints are configuration only. The Runner stores them in
  `~/.takonaut/models.json` with the default model.
  `TAKONAUT_RUNNER_MODELS` sets a different path.
- The Runner gets the models of an endpoint from its `/models` list. No
  third-party code runs.
- `--api` selects `openai-completions` or `openai-responses`.
- `--key-secret NAME` reads the API key from a Runner secret.

### Model tests

`models test --all` sends a very small request to each model. It stops
reporting each model that fails. A timeout or a rate limit counts as "not
sure", and the Runner keeps reporting that model.

### Model changes

The Runner checks its models every 5 minutes (Tako Runner 0.12.1 and newer).
It reports them again when they change:

- An endpoint adds or removes models.
- The default model changes.
- `models test` stops a model.

If a provider or endpoint fails during a check, the Runner keeps the models
that it reported last. To report a change at once, run
`brew services restart tako-runner`.

To stop reporting models, set `TAKONAUT_RUNNER_ADVERTISE_MODELS=0`.

## Organization tools and secrets

Organization administrators add tools in Takonaut on the **Agents → Tools**
tab, for example CloudWatch, Sentry, an API call or a script. Then they
install the tools on Runners.

- The Runner gets its tools from Takonaut.
- A tool is ready when each secret that it uses is set on this machine, and
  each program that it lists is installed.
- If a tool is not ready, its state names what is missing.
  `tako-runner doctor` shows this too.
- Secret values stay on the machine. The Runner removes them from all that
  it reports or shows to a model.

```bash
tako-runner tools                       # tools on this Runner and if each is ready
tako-runner secrets                     # secrets on this machine and secrets that tools need
tako-runner secrets set ADMIN_API_TOKEN # asks for the value; the value is not shown
tako-runner secrets unset ADMIN_API_TOKEN
tako-runner secrets import --env-file ./runner.env
tako-runner tools test look-up-order --arg order_id=ORD-1182
```

### Where secrets are stored

- By default, secrets are in `~/.takonaut/secrets.json`. Only the owner can
  read it.
- `--keychain` stores a secret in the macOS Keychain. The background service
  cannot answer Keychain prompts. Thus, use the file when you run the Runner
  with `brew services`.
- `tako-runner doctor` reads each secret in the same way as the service.

### Tools that change things

A tool marked **Changes** does not run during a Run.

1. The Agent proposes the call.
2. A person approves it in Takonaut.
3. The Runner makes the call with a single-use permit for exactly those
   arguments.

### Programs and scripts

Runs, script tools and connectors find programs in the folders where
installers put them: Homebrew, `/usr/local/bin` and `~/.local/bin`. They do
not use only the service's minimal `PATH`.

The Runner writes a script that Takonaut stores one time, by checksum, to
`~/.takonaut/tool-scripts/`. Its path replaces `${script}` in the tool's
command.

### Secrets entered in Takonaut

People can enter a secret on a tool's page in Takonaut (Tako Runner 0.12.0
and newer).

1. The Runner keeps a P-256 key in `~/.takonaut/runner-sealing-key.json`.
   Only the owner can read it. Runs cannot read it.
2. The Runner sends the public part of the key to Takonaut.
3. The browser seals the value with that key. The sealed value is bound to
   the key's fingerprint and the secret's name.
4. The Runner opens the value, stores it as `tako-runner secrets set` does,
   and tells Takonaut.
5. Takonaut removes the sealed copy.

The first time, compare the output of `tako-runner secrets fingerprint` with
the fingerprint that the browser shows.

## Connectors

A connector is a local [MCP](https://modelcontextprotocol.io) server. It
gives Agents read-only access to evidence outside the repository, for example
production logs.

You add a connector on the Runner machine. Its command and credentials are
in `~/.takonaut/runner-connectors.json`. Only the owner can read this file.
Takonaut never receives it.

```bash
# AWS CloudWatch Logs, with a read-only AWS profile from ~/.aws/config
tako-runner connector add aws-logs \
  --description "Production CloudWatch logs" \
  --env AWS_PROFILE=takonaut-readonly --env AWS_REGION=ap-south-1 \
  -- uvx awslabs.cloudwatch-mcp-server@latest

tako-runner connector test aws-logs     # starts it and lists the tools you can use
tako-runner connector list              # names and environment variable names only
tako-runner connector remove aws-logs
brew services restart tako-runner       # report it to Takonaut
```

To give an Agent the connector:

1. Restart the service.
2. In Takonaut, open the Agent's **Tools & permissions** page.
3. Find the connector under **Runner connectors**, for example
   `Aws Logs (Runner connector)`.
4. Turn it on for each Agent that must read those logs.

### Connector limits

- During a Run, the Runner starts only the connectors that the Agent is
  granted.
- The model gets only the tools that the server marks read-only (MCP
  `readOnlyHint`). To allow a different tool, add `--allow-tool TOOL`.
- The server gets a minimal environment: `PATH`, `HOME`, the locale and the
  `--env` values. It does not get the Runner's environment.
- The Runner limits tool output to 50 KiB for each call. The model gets it as
  untrusted data.
- `--timeout-ms N` sets the time limit for each request to the connector.
  The default is 30,000 ms (30 seconds).
- The Runner stops the server when the Run ends.

Use credentials that can only read. The Runner cannot make a tool that
changes data safe.
