# Trusted Native mode

Agents do not need Trusted Native mode to open pull requests or to make other
GitHub changes. An Agent proposes the change. After a person approves it,
Takonaut makes the change through its GitHub App. See
[Organization tools and secrets](models-tools-connectors.md#organization-tools-and-secrets).

Trusted Native is the older method. In this mode, the Runner machine calls
GitHub itself.

## Turn on Trusted Native

Trusted Native is off by default. You must turn it on in two places for one
exact Project repository.

1. **On the machine.** In an interactive terminal, `setup` tells you that
   Trusted Native gives the Runner more authority, and asks if you want to
   turn it on. If you select yes, the Runner:
   - makes a local Ed25519 signing identity
   - reports protocol v3 capabilities
   - keeps the private key only in the credentials file, which only the
     owner can read
2. **In Takonaut.** Open the Profile's **Tools & Executors** page. Publish a
   trust policy for that Runner and repository binding.

For autonomous protected actions, you must also:

- turn on the second switch on the **Tools & Executors** page
- set the exact Profile tool grant to **Automatic**

```bash
cd /absolute/path/to/repository
tako-runner setup --url https://takonaut.app --trusted-native

# Set this binding back to the standard read-only Runner mode:
tako-runner map PROJECT_ID "$PWD" \
  --repository-id REPOSITORY_ID \
  --disable-trusted-native
```

`--trusted-native` and `--disable-trusted-native` are the non-interactive
options. A non-interactive `setup` without either option keeps the existing
choice. If there is no existing choice, the Runner stays read-only.

## How a GitHub change is made

- A linked Takonaut GitHub integration is necessary.
- The model never gets GitHub tokens, personal access tokens, SSH agents,
  the Runner's private key or a shell.
- GitHub changes go through a narrow local `gh api` broker.
- The broker acts only after the Runner verifies a Takonaut permit. The
  permit is single-use, is valid for 5 minutes and is bound to the
  repository and the commit SHA.
- The Runner signs the result receipt. Takonaut checks the result
  separately through its linked GitHub App.

The action goes back to the Review queue if any of these are missing or old:
trust, capabilities, repository identity, lease evidence or Profile
autonomy.
