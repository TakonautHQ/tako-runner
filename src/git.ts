export function normalizeGitHubRemote(remote: string): string | null {
	const value = remote.trim();
	let match = value.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/i);
	if (!match)
		match = value.match(
			/^https?:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?\/?$/i,
		);
	if (!match)
		match = value.match(
			/^ssh:\/\/git@github\.com\/([^/]+)\/(.+?)(?:\.git)?\/?$/i,
		);
	if (!match) return null;
	const owner = match[1].toLowerCase();
	const name = match[2].replace(/\.git$/i, "").toLowerCase();
	return `github.com/${owner}/${name}`;
}
