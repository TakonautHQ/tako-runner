# Developer reference

## Development

```bash
bun install --frozen-lockfile
bun run test
bun run typecheck
bun run pack:check
```

The Pi runtime packages use pinned versions. Upgrade all
`@earendil-works/pi-*` packages together. Before a release, test an
installation from the packed package with production dependencies only.

## Runner API request deadlines

`RunnerApiClient` has a 10-second timeout for each request. The timeout
includes reading the response body, for success and for errors, and the
setup catalog.

- The optional third constructor argument `{ requestTimeoutMs }` can make the
  limit shorter. It must be an integer from 1 to 10000 ms. It cannot turn off
  or extend the limit.
- Each request has its own cancellation signal.
- The client stops an HTTP exchange that times out. It does not send the
  request again.
- An injected transport must obey cancellation to release its own
  resources. If it does not, the client still rejects on timeout.

A timeout has an **unknown remote outcome**: the server can already have
committed a change. Do not send another attempt or retry a change only
because of a timeout.

This is a transport timeout. It is not a hard real-time limit if the
JavaScript event loop is blocked. For process supervision, see
[How Runs work](runs.md#process-supervision-macos-and-linux).

## Delivery control adapter

The delivery control adapter is not a daemon execution mode. It gives no
additional execution authority.

`RunnerApiClient.claimDelivery()` claims delivery work that Takonaut already
dispatched, with `POST /api/runner/v2/delivery/claim`. It needs:

- the server rollout gates
- an authorized machine credential
- reported protocol 2 or later
- current Project, repository and capability eligibility

It does not change the reported protocol, start a delivery executor or change
the claim loop of the analysis daemon.

The returned `RunnerDeliveryClaim` is frozen. It contains `run_id`,
`project_id`, `attempt_id` and `lease_expires_at`. If there is no work, the
method returns `null`.

- Keep that exact claim for `heartbeatDelivery`, `activityDelivery`,
  `evidenceDelivery`, `pollDeliveryCommands`, `acknowledgeDeliveryCommand`
  and `completeDelivery`. These methods add its `X-Runner-Attempt-Id` to each
  delivery request.
- Do not give a newer claim to an older process.
- A 401 or 409 response means that the authority or the lease is lost. Stop
  that work. Do not retry it with a newer claim.

The adapter is control transport, not process supervision. These functions
each still need their own rollout gate:

- automatic delivery execution
- termination when the lease is lost
- cancellation and abandonment on customer Runners

The shared capacity foundation does not approve these workflows.

## Release

1. Set the version in `package.json` and in `test/package.test.ts`.
2. Push a `v<version>` tag to `TakonautHQ/tako-runner`. The **Release assets**
   workflow builds the package, its SHA-256 file and a rendered formula, and
   publishes the GitHub release.
3. To render the formula yourself:

   ```bash
   bun run formula:render -- VERSION SHA256 dist/tako-runner.rb
   brew style dist/tako-runner.rb
   ```

4. In [`TakonautHQ/homebrew-tap`](https://github.com/TakonautHQ/homebrew-tap),
   change the version and the SHA-256 in `Formula/tako-runner.rb`, then
   commit and push. Keep the formula's `caveats` block.
